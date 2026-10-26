import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { JitoTransport } from '../server/solana/transports';
import { executionConfig } from '../server/solana/executionConfig';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { MockJitoEngine } from './e2e/helpers/mockJito';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';

function dummyTx(payer: PublicKey): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.signatures = [new Uint8Array(64).fill(7)];
  return tx;
}

describe('A4: real Jito health and fail-closed execution', () => {
  let mockRpc: MockSolanaRpc;
  let mockJito: MockJitoEngine;
  let coordinator: ExecutionCoordinator;

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    mockJito = new MockJitoEngine();
    await mockJito.start();
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
  });

  afterEach(async () => {
    coordinator.cleanup();
    vi.restoreAllMocks();
    await mockJito.stop();
  });

  describe('JitoTransport.probe', () => {
    it('is HEALTHY only when the block engine returns tip accounts', async () => {
      const jito = new JitoTransport(mockRpc.createConnection(), mockJito.getUrl());
      const res = await jito.probe();
      expect(res.healthy).toBe(true);
      expect(jito.getTelemetry().health).toBe('HEALTHY');
      expect(jito.getProbeAgeMs()).not.toBeNull();
    });

    it('is DEGRADED on an HTTP error (the old probe reported HEALTHY here)', async () => {
      mockJito.setFailProbe(true);
      const jito = new JitoTransport(mockRpc.createConnection(), mockJito.getUrl());
      const res = await jito.probe();
      expect(res.healthy).toBe(false);
      expect(jito.getTelemetry().health).toBe('DEGRADED');
      expect(jito.getTelemetry().lastError).toMatch(/503/);
    });

    it('is OFFLINE when the block engine cannot be reached', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const jito = new JitoTransport(mockRpc.createConnection(), mockJito.getUrl());
      const res = await jito.probe();
      expect(res.healthy).toBe(false);
      expect(jito.getTelemetry().health).toBe('OFFLINE');
    });

    it('is DEGRADED when the answer has no tip accounts', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: [] }), { status: 200 }));
      const jito = new JitoTransport(mockRpc.createConnection(), mockJito.getUrl());
      expect((await jito.probe()).healthy).toBe(false);
      expect(jito.getTelemetry().health).toBe('DEGRADED');
    });
  });

  describe('readiness', () => {
    it('is ready and not required when no block engine is configured (devnet, RPC transport)', () => {
      const real = executionConfig.getConfig();
      vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: '' });
      const c = new ExecutionCoordinator(mockRpc.createConnection());
      try {
        expect(c.getJitoReadiness()).toEqual({ ready: true, enabled: false, status: 'NOT_CONFIGURED' });
        expect(c.canExecuteLive().reasons.join(' ')).not.toMatch(/Jito/);
      } finally {
        c.cleanup();
      }
    });

    it('requires a HEALTHY and recent probe when a block engine is configured', async () => {
      await coordinator.getJitoTransport().probe();
      expect(coordinator.getJitoReadiness()).toMatchObject({ ready: true, enabled: true, status: 'HEALTHY' });

      vi.spyOn(coordinator.getJitoTransport(), 'getProbeAgeMs').mockReturnValue(10 * 60_000);
      const stale = coordinator.getJitoReadiness();
      expect(stale.ready).toBe(false);
      expect(stale.status).toBe('STALE');
      expect(coordinator.canExecuteLive().reasons.join(' ')).toMatch(/Jito Block Engine health probe is stale/);
    });

    it('is not ready after a failed probe and says why', async () => {
      mockJito.setFailProbe(true);
      await coordinator.getJitoTransport().probe();
      const r = coordinator.getJitoReadiness();
      expect(r.ready).toBe(false);
      expect(r.reason).toMatch(/DEGRADED/);
      expect(coordinator.canExecuteLive().reasons.join(' ')).toMatch(/Jito Block Engine is DEGRADED/);
    });

    it('cleanup stops the periodic probe loop', async () => {
      await new Promise((r) => setTimeout(r, 0));
      coordinator.cleanup();
      expect((coordinator as any).jitoProbeInterval).toBeNull();
    });
  });

  describe('submitAndConfirmWithRetry fails closed on an unhealthy block engine', () => {
    async function submit() {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      return coordinator.submitAndConfirmWithRetry({
        tx: dummyTx(owner),
        orderId: `a4-${Math.random().toString(36).slice(2)}`,
        correlationId: 'corr-a4',
        side: 'BUY',
        mint: mint.toBase58(),
        mintPubkey: mint,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        preSnapshot: { timestamp: Date.now(), walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any,
        jitoTipLamports: 100_000,
      });
    }

    it('refuses the order, tries no Jito submit and sends nothing when the RPC fallback is off', async () => {
      executionConfig.updateConfig({ enableRpcFallback: false, jitoMaxRetries: 2, jitoRetryIntervalMs: 1 });
      mockJito.setFailProbe(true);
      await coordinator.getJitoTransport().probe(); // the engine went down; the periodic probe has seen it
      const jitoSubmit = vi.spyOn(coordinator.getJitoTransport(), 'submit');
      const rpcSubmit = vi.spyOn((coordinator as any).rpcTransport, 'submit');
      const res = await submit();
      expect(res.success).toBe(false);
      expect(res.lifecycleState).toBe('SUBMIT_FAILED');
      expect(res.error).toMatch(/fail closed/);
      expect(jitoSubmit).not.toHaveBeenCalled();
      expect(rpcSubmit).not.toHaveBeenCalled();
    });

    it('goes straight to RPC (no Jito retries) when the fallback is enabled', async () => {
      executionConfig.updateConfig({ enableRpcFallback: true, jitoMaxRetries: 2, jitoRetryIntervalMs: 1 });
      mockJito.setFailProbe(true);
      await coordinator.getJitoTransport().probe(); // the engine went down; the periodic probe has seen it
      const jitoSubmit = vi.spyOn(coordinator.getJitoTransport(), 'submit');
      const rpcSubmit = vi.spyOn((coordinator as any).rpcTransport, 'submit').mockResolvedValue({
        signature: 'rpc_sig_a4',
        transport: 'SOLANA_RPC',
        success: true,
        submitDurationMs: 1,
        lifecycleState: 'BUNDLE_PENDING',
      });
      vi.spyOn((coordinator as any).rpcTransport, 'confirm').mockResolvedValue({ confirmed: true, slot: 5 } as any);
      const res = await submit();
      expect(res.success).toBe(true);
      expect(res.transport).toBe('SOLANA_RPC');
      expect(jitoSubmit).not.toHaveBeenCalled();
      expect(rpcSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('tip with no Jito', () => {
    it('is forced to zero when no block engine is configured and untouched when one is', () => {
      const input = { tipFloorLamports: 200_000, tradeAmountSol: 1 };
      expect((coordinator as any).resolveLiveTip(input).tipLamports).toBeGreaterThan(0);
      vi.spyOn(coordinator.getJitoTransport(), 'isEnabled').mockReturnValue(false);
      const tip = (coordinator as any).resolveLiveTip(input);
      expect(tip.tipLamports).toBe(0);
      expect(tip.tipSol).toBe(0);
    });
  });
});
