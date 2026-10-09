import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, SystemProgram } from '@solana/web3.js';
import {
  CLUSTER_GENESIS_HASH,
  DEFAULT_RPC_URL,
  ClusterGuardError,
  allowedCluster,
  assertClusterAllowed,
  jitoTipFloorAllowed,
  resolveJitoUrl,
  resolveRpcUrl,
} from '../server/solana/clusterGuard';
import { JitoTransport } from '../server/solana/transports';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { workstationDb } from '../server/db/database';

const DEVNET = CLUSTER_GENESIS_HASH.devnet;
const MAINNET = CLUSTER_GENESIS_HASH['mainnet-beta'];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Simulates the production devnet configuration: no block engine URL. */
function withJitoDisabled() {
  const real = executionConfig.getConfig();
  vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: '' });
}

describe('R1: cluster guard', () => {
  describe('genesis check', () => {
    it('accepts the devnet genesis hash by default', async () => {
      const conn = { getGenesisHash: vi.fn().mockResolvedValue(DEVNET) };
      await expect(assertClusterAllowed(conn)).resolves.toEqual({ cluster: 'devnet', genesisHash: DEVNET });
    });

    it('refuses the mainnet genesis hash by default', async () => {
      const conn = { getGenesisHash: vi.fn().mockResolvedValue(MAINNET) };
      await expect(assertClusterAllowed(conn)).rejects.toBeInstanceOf(ClusterGuardError);
    });

    it('refuses an unknown genesis hash and an RPC error (fails closed)', async () => {
      await expect(assertClusterAllowed({ getGenesisHash: async () => 'unknown' })).rejects.toThrow(/CLUSTER_GUARD/);
      await expect(
        assertClusterAllowed({
          getGenesisHash: async () => {
            throw new Error('fetch failed');
          },
        })
      ).rejects.toThrow(/could not read genesis hash/);
    });

    it('only accepts mainnet when ALLOWED_CLUSTER=mainnet-beta is set explicitly', async () => {
      vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
      expect(allowedCluster()).toBe('mainnet-beta');
      await expect(assertClusterAllowed({ getGenesisHash: async () => MAINNET })).resolves.toBeTruthy();
      await expect(assertClusterAllowed({ getGenesisHash: async () => DEVNET })).rejects.toThrow(/CLUSTER_GUARD/);
    });

    it('treats any other ALLOWED_CLUSTER value as devnet', () => {
      vi.stubEnv('ALLOWED_CLUSTER', 'testnet');
      expect(allowedCluster()).toBe('devnet');
    });
  });

  describe('fail-closed URL defaults', () => {
    it('defaults the RPC to devnet and the block engine to disabled', () => {
      vi.stubEnv('SOLANA_RPC_URL', '');
      vi.stubEnv('JITO_BLOCK_ENGINE_URL', '');
      expect(resolveRpcUrl()).toBe(DEFAULT_RPC_URL);
      expect(DEFAULT_RPC_URL).toContain('devnet');
      expect(resolveJitoUrl()).toBe('');
    });

    it('replaces mainnet-looking URLs unless mainnet is allowed', () => {
      expect(resolveRpcUrl('https://api.mainnet-beta.solana.com')).toBe(DEFAULT_RPC_URL);
      expect(resolveJitoUrl('https://mainnet.block-engine.jito.wtf')).toBe('');
      vi.stubEnv('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com');
      expect(resolveRpcUrl()).toBe(DEFAULT_RPC_URL);
    });

    it('keeps a devnet RPC and a local mock block engine', () => {
      expect(resolveRpcUrl('https://api.devnet.solana.com')).toBe('https://api.devnet.solana.com');
      expect(resolveJitoUrl('http://127.0.0.1:9/')).toBe('http://127.0.0.1:9');
    });

    it('does not read the mainnet tip floor service on devnet', () => {
      expect(jitoTipFloorAllowed()).toBe(false);
    });

    it('execution config has no mainnet block engine by default', () => {
      expect(executionConfig.getConfig().jitoBlockEngineUrl).not.toMatch(/mainnet|jito\.wtf/);
    });
  });

  describe('JitoTransport with no block engine', () => {
    it('is disabled, never fetches and reports NOT_CONFIGURED', async () => {
      withJitoDisabled();
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const jito = new JitoTransport(new Connection(DEFAULT_RPC_URL), '');
      expect(jito.isEnabled()).toBe(false);
      const probe = await jito.probe();
      expect(probe.healthy).toBe(false);
      expect(jito.getTelemetry().health).toBe('NOT_CONFIGURED');
      expect(await jito.getTipFloorLamports()).toBeNull();
      expect(await jito.getBundleStatus('x')).toBeNull();
      expect(await jito.getInflightBundleStatus('x')).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('refuses to be pointed at a mainnet block engine', () => {
      withJitoDisabled();
      const jito = new JitoTransport(new Connection(DEFAULT_RPC_URL), '');
      expect(() => jito.setBlockEngineUrl('https://mainnet.block-engine.jito.wtf')).toThrow(/CLUSTER_GUARD/);
      expect(jito.isEnabled()).toBe(false);
    });
  });

  describe('submitAndConfirmWithRetry', () => {
    function buildTx(): { tx: VersionedTransaction; payer: Keypair } {
      const payer = Keypair.generate();
      const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([payer]);
      return { tx, payer };
    }

    async function submit(side: 'BUY' | 'SELL') {
      vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
      vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(0);
      const coordinator = new ExecutionCoordinator();
      const { tx, payer } = buildTx();
      const orderId = `r1-${side}-${Math.random().toString(36).slice(2)}`;
      const res = await coordinator.submitAndConfirmWithRetry({
        tx,
        orderId,
        correlationId: `corr-${orderId}`,
        side,
        mint: Keypair.generate().publicKey.toBase58(),
        mintPubkey: Keypair.generate().publicKey,
        owner: payer.publicKey,
        tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        preSnapshot: {} as any,
        jitoTipLamports: 0,
      });
      coordinator.cleanup();
      return { res, orderId };
    }

    it.each(['BUY', 'SELL'] as const)('refuses a %s on a mainnet genesis hash and sends nothing', async (side) => {
      vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(MAINNET);
      const send = vi.spyOn(Connection.prototype, 'sendRawTransaction');
      const journal = vi.spyOn(workstationDb, 'logJournal');
      const { res, orderId } = await submit(side);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/CLUSTER_GUARD/);
      expect(send).not.toHaveBeenCalled();
      expect(journal).toHaveBeenCalledWith('CLUSTER_GUARD_BLOCK', `corr-${orderId}`, 'LIVE', expect.objectContaining({ orderId, side }));
    });

    it('refuses to send when the genesis hash cannot be read', async () => {
      vi.spyOn(Connection.prototype, 'getGenesisHash').mockRejectedValue(new Error('fetch failed'));
      const send = vi.spyOn(Connection.prototype, 'sendRawTransaction');
      const { res } = await submit('BUY');
      expect(res.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });

    it('on devnet with no Jito goes straight to RPC and never calls fetch', async () => {
      withJitoDisabled();
      vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(DEVNET);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const send = vi.spyOn(Connection.prototype, 'sendRawTransaction').mockRejectedValue(new Error('rpc rejected'));
      const { res } = await submit('BUY');
      expect(send).toHaveBeenCalledTimes(1);
      expect(res.transport).toBe('SOLANA_RPC');
      expect(res.success).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('source regressions', () => {
    const root = process.cwd();
    const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

    it('no dotenv override:true in server code or scripts', () => {
      for (const f of ['server.ts', 'server/execution/coordinator.ts', 'scripts/test_devnet_execution.ts']) {
        expect(read(f)).not.toMatch(/override:\s*true/);
      }
    });

    it('no mainnet RPC or block engine URL literal outside the cluster guard and the tip-floor gate', () => {
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
          const rel = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(rel);
          else if (/\.(ts|cjs|mjs)$/.test(entry.name)) {
            const text = read(rel);
            const hits = text.match(/https?:\/\/[^\s'"`)]*(mainnet|jito\.wtf)[^\s'"`)]*/gi) || [];
            if (hits.length && rel !== path.join('server', 'solana', 'transports.ts')) offenders.push(`${rel}: ${hits.join(', ')}`);
          }
        }
      };
      walk('server');
      walk('scripts');
      expect(read('server.ts')).not.toMatch(/api\.mainnet-beta/);
      expect(offenders).toEqual([]);
    });

    it('transports only reads the Jito tip-floor service behind the mainnet gate', () => {
      const text = read('server/solana/transports.ts');
      const idx = text.indexOf('bundles.jito.wtf');
      expect(idx).toBeGreaterThan(-1);
      expect(text.slice(0, idx)).toContain('jitoTipFloorAllowed()');
    });

    it('the PAPER-mode mainnet fallback is gone and env:show is removed', () => {
      expect(read('server/solana/pumpCurve.ts')).not.toMatch(/mainnetFallback/);
      expect(JSON.parse(read('package.json')).scripts['env:show']).toBeUndefined();
    });
  });
});
