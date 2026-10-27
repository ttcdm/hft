import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * Audit 2026-10-22, finding F1: startup reconciliation step 4b closes a LIVE row as RECONCILED_ZERO_BALANCE from a balance read it
 * cannot trust. P1.6 taught the close path (`readHeldTokens`) that an empty balance from a wrong-cluster RPC, or from a slot before the
 * buy landed, is not a confirmed zero. Step 4b of `runStartupReconciliation` reads the same balance without either guard, zeroes the
 * cost basis and raises POSITION_GONE. It runs at every boot and on every `POST /api/execution/reconcile`.
 *
 * Real ExecutionCoordinator and SQLite; the RPC is tests/e2e/helpers/mockRpc.ts. Keys are throwaway values.
 */
const seeded: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
  for (const id of seeded.splice(0)) {
    const p = workstationDb.loadPositions().find((x) => x.id === id);
    if (p && p.status !== 'CLOSED') { p.status = 'CLOSED'; p.tokenQuantityRaw = '0'; workstationDb.savePosition(p); }
  }
});

function seedLive(over: Record<string, unknown> = {}): { id: string; mint: string } {
  const id = `a1022-${Math.random().toString(36).slice(2, 10)}`;
  const mint = (over.mint as string) ?? Keypair.generate().publicKey.toBase58();
  workstationDb.savePosition({
    id, mint, symbol: 'A1022', name: 'A1022', tokenDecimals: 6, tokenQuantityRaw: '1000000000', costBasisLamports: 100_000_000,
    entryPriceSol: 1e-4, currentPriceSol: 1e-4, currentValueSol: 0.1, realizedPnLSol: 0, entryTxSignature: `sig-${id}`,
    entryTimestamp: Date.now() - 60_000, lastMarkTimestamp: Date.now(), executionMode: 'LIVE', status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
    baseTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    walletPubkey: localSigner.getPublicKey().toBase58(), // R4-2: bound to the test signer
    ...over,
  } as any);
  seeded.push(id);
  return { id, mint };
}

const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;

async function coordinatorOn(opts: { genesisHash?: string } = {}) {
  const owner = Keypair.generate();
  const mockRpc = new MockSolanaRpc();
  if (opts.genesisHash) mockRpc.genesisHash = opts.genesisHash;
  vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
  vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(owner.publicKey);
  const conn = mockRpc.createConnection();
  const c = new ExecutionCoordinator(conn);
  cleanups.push(() => { c.cleanup(); mockRpc.clear(); });
  vi.spyOn(c.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any);
  return { c, conn, mockRpc, owner: owner.publicKey };
}

describe('F1: startup reconciliation does not close a LIVE row from a balance read it cannot trust', () => {
  it('wrong-cluster RPC (clusterProblem set): "could not find account" from it is not a confirmed zero; the row stays OPEN with its cost basis', async () => {
    const { c, conn } = await coordinatorOn({ genesisHash: Keypair.generate().publicKey.toBase58() });
    await vi.waitFor(() => expect(c.getClusterStatus().problem).toMatch(/genesis hash/), { timeout: 5_000 });
    const { id } = seedLive();
    vi.spyOn(conn, 'getTokenAccountBalance').mockRejectedValue(new Error('failed to get token account balance: Invalid param: could not find account'));

    const res = await c.startupReconciliation({ fresh: true });

    expect(res.status).not.toBe('EXECUTION_READY'); // the cluster problem alone keeps readiness down
    expect(row(id).status).toBe('OPEN');
    expect(row(id).tokenQuantityRaw).toBe('1000000000');
    expect(row(id).costBasisLamports).toBe(100_000_000);
    expect(c.getOperatorAlerts().some((a) => a.code === 'POSITION_GONE' && a.positionId === id)).toBe(false);
  });

  it('a zero balance answered from a slot before the buy landed does not close the row; the same answer from a later slot does', async () => {
    const { c, mockRpc, owner } = await coordinatorOn();
    await vi.waitFor(() => expect(c.getClusterStatus().problem).toBeNull(), { timeout: 5_000 });
    const { id, mint } = seedLive({ entrySlot: 500 });
    mockRpc.setTokenAccount(PumpCurveService.getAssociatedTokenAddress(new PublicKey(mint), owner, TOKEN_PROGRAM_ID), '0');

    mockRpc.setSlot(400); // a lagging node: it has not seen the buy yet
    await c.startupReconciliation({ fresh: true });
    expect(row(id).status).toBe('OPEN');
    expect(row(id).costBasisLamports).toBe(100_000_000);

    mockRpc.setSlot(600);
    await c.startupReconciliation({ fresh: true });
    expect(row(id).status).toBe('CLOSED');
    expect(row(id).exitReason).toMatch(/^RECONCILED_ZERO_BALANCE/);
  });
});
