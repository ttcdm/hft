import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * S254 (P2.2, R1-23/R1-83/R1-115): after a restart, a sell that was sent but not confirmed used to be forgotten (pendingSells lived in
 * memory), and the 3 s exit loop could evaluate the position before startup reconciliation had applied that sell. Now the coordinator seeds
 * its pending sells from the ledger at start, and holds LIVE positions with an unresolved SELL row out of the exit pass until the first
 * reconciliation run has ended. Real coordinator, ExitEngine and SQLite; the RPC is MockSolanaRpc, and the exit dispatch is spied.
 */
const uid = () => Math.random().toString(36).slice(2);

describe('S254: restart safety for sells sent before the restart', () => {
  let coordinator: ExecutionCoordinator | undefined;
  const mint = Keypair.generate().publicKey.toBase58();
  const otherMint = Keypair.generate().publicKey.toBase58();
  const position = (id: string, m: string) => workstationDb.savePosition({
    id, mint: m, symbol: 'S254', name: 'S254', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 1e-4, currentPriceSol: 5e-5,
    currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE',
    entryTxSignature: `sig_${id}`, entryTimestamp: Date.now() - 60_000, lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
  } as any);
  const sellRow = (m: string, state: 'PENDING' | 'RECONCILIATION_REQUIRED', submissionTime: number, lastValidBlockHeight?: number) => {
    const signature = `s254_sell_${uid()}`;
    workstationDb.saveTransaction({
      signature, orderId: `ord-exit-${uid()}`, correlationId: 'exit-s254', mint: m, direction: 'SELL', submissionTransport: 'SOLANA_RPC',
      submissionTime, reconciliationState: state, networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE', lastValidBlockHeight,
    });
    return signature;
  };
  const cleanup = () => {
    for (const p of workstationDb.loadPositions()) if (p.mint === mint || p.mint === otherMint) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    for (const t of workstationDb.loadTransactionsInStates(['PENDING', 'RECONCILIATION_REQUIRED'])!) if (t.mint === mint || t.mint === otherMint) workstationDb.saveTransaction({ ...t, reconciliationState: 'REVERTED' });
  };

  beforeEach(() => {
    cleanup();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(Keypair.generate().publicKey);
  });
  afterEach(() => {
    coordinator?.cleanup();
    coordinator = undefined;
    vi.restoreAllMocks();
    cleanup();
  });

  it('start() turns each unresolved LIVE SELL row into a pending sell of that mint\'s position, the latest one winning', () => {
    const id = `s254_${uid()}`;
    position(id, mint);
    sellRow(mint, 'PENDING', Date.now() - 20_000, 111);
    const latest = sellRow(mint, 'RECONCILIATION_REQUIRED', Date.now() - 5_000, 222);
    coordinator = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    const seeded = (coordinator as any).pendingSells.get(id);
    expect(seeded).toMatchObject({ signature: latest, lastValidBlockHeight: 222 });
  });

  it('a SELL row with no active position of its mint seeds nothing', () => {
    sellRow(otherMint, 'PENDING', Date.now() - 5_000);
    coordinator = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    expect([...(coordinator as any).pendingSells.values()].some((p: any) => p.signature.startsWith('s254_sell_'))).toBe(false);
  });

  it('before the first reconciliation ends, a LIVE position with an unresolved sell is not evaluated; another position is, and both are after it', async () => {
    const held = `s254_held_${uid()}`;
    const free = `s254_free_${uid()}`;
    position(held, mint);
    position(free, otherMint);
    sellRow(mint, 'PENDING', Date.now() - 5_000);
    // reconciliation is held on a promise, so the exit pass runs first
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(ExecutionCoordinator.prototype as any, 'runStartupReconciliation').mockImplementation(async () => {
      await gate;
      return { status: 'EXECUTION_READY', mismatchesCount: 0, details: 'ok' };
    });
    coordinator = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    const dispatch = vi.spyOn(coordinator as any, 'dispatchExit').mockResolvedValue(undefined);
    const recon = coordinator.startupReconciliation();

    await coordinator.evaluateAndProcessExits();
    const before = dispatch.mock.calls.map((c: any[]) => c[0].id);
    expect(before).toContain(free); // -50% from entry: the stop-loss fires for the position with no unresolved sell
    expect(before).not.toContain(held);

    release();
    await recon;
    dispatch.mockClear();
    await coordinator.evaluateAndProcessExits();
    expect(dispatch.mock.calls.map((c: any[]) => c[0].id)).toContain(held);
  });
});
