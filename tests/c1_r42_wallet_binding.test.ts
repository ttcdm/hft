import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * R4-2 / R5-2: the ledger is bound to the wallet that bought each LIVE position. Booting (or exiting) with a different signer reads that
 * signer's empty token account, which proves nothing, so no zero-balance close may book the position as a loss. Real coordinator and
 * SQLite; the RPC answers are scripted. Keys are fresh throwaway values.
 */
describe('R4-2 / R5-2: zero-balance closes require the position\'s own wallet', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let conn: any;
  let oldWallet: Keypair;
  let newSigner: Keypair;
  const mint = VALID_PUMP_MINT_1.toBase58();
  const uid = () => Math.random().toString(36).slice(2);

  const livePosition = (id: string, walletPubkey: string | undefined) => {
    workstationDb.savePosition({
      id, mint, symbol: 'R42', name: 'R42', tokenDecimals: 6, tokenQuantityRaw: '1000', entryPriceSol: 1e-4, currentPriceSol: 1e-4,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(), walletPubkey,
    } as any);
  };
  const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;
  const buyTxPaidBy = (payer: Keypair) => ({ slot: 5, blockTime: 1, meta: { err: null, fee: 5000 }, transaction: { message: { staticAccountKeys: [payer.publicKey] } } });
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions()) if (p.status !== 'CLOSED') workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    settleLeftoverLiveBuys();
  };

  beforeEach(async () => {
    mockRpc = new MockSolanaRpc();
    oldWallet = Keypair.generate();
    newSigner = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(newSigner.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    coordinator.orphanRecoveryDelaysMs = [];
    conn = (coordinator as any).connection;
    conn.getBalance = vi.fn(async () => 1_000_000_000);
    conn.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    conn.getSignatureStatuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    // the new signer has no token account for the mint: a "trusted" zero that only says nothing is in THIS wallet
    conn.getTokenAccountBalance = vi.fn(async () => { throw new Error('failed to get token account balance: Invalid param: could not find account'); });
    (coordinator as any).rpcHealth = 'HEALTHY';
    await vi.waitFor(() => expect(coordinator.getReconciliationStatus()).not.toBeNull());
    await (coordinator as any).reconcileInFlight?.catch(() => undefined);
    vi.spyOn(coordinator as any, 'scheduleReconcileRetry').mockImplementation(() => undefined);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    clearLedger();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('R4-2: a boot with a different signer leaves the old wallet\'s position open, books no loss and raises POSITION_WALLET_MISMATCH', async () => {
    const id = `r42_${uid()}`;
    livePosition(id, oldWallet.publicKey.toBase58());
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const res = await coordinator.startupReconciliation({ fresh: true });
    expect(row(id).status).toBe('OPEN');
    expect(row(id).costBasisLamports).toBe(100_000_000);
    expect(row(id).realizedPnLSol).toBe(0);
    expect(journal.mock.calls.some((c) => c[0] === 'REALIZED_ASSUMED_LOSS')).toBe(false);
    expect(res.status).toBe('RECONCILIATION_MISMATCH');
    expect(res.details).toMatch(/WALLET_MISMATCH/);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_WALLET_MISMATCH' && a.positionId === id && !a.cleared)).toBe(true);
  });

  it('R4-2: the same boot with the position\'s own signer still closes it as an assumed loss (the binding is not a blanket refusal)', async () => {
    const id = `r42own_${uid()}`;
    livePosition(id, newSigner.publicKey.toBase58());
    await coordinator.startupReconciliation({ fresh: true });
    expect(row(id).status).toBe('CLOSED');
    expect(row(id).realizedPnLSol).toBeCloseTo(-0.1, 9);
  });

  it('R4-2: a row from before the binding is bound to the fee payer of its own buy; another payer leaves it open, this signer closes it', async () => {
    const other = `r42old_${uid()}`;
    livePosition(other, undefined);
    conn.getTransaction = vi.fn(async () => buyTxPaidBy(oldWallet));
    await coordinator.startupReconciliation({ fresh: true });
    expect(row(other).status).toBe('OPEN');
    expect(row(other).walletPubkey).toBe(oldWallet.publicKey.toBase58()); // recorded, so the next check needs no chain read

    workstationDb.savePosition({ ...row(other), status: 'CLOSED' } as any);
    const mine = `r42mine_${uid()}`;
    livePosition(mine, undefined);
    conn.getTransaction = vi.fn(async () => buyTxPaidBy(newSigner));
    await coordinator.startupReconciliation({ fresh: true });
    expect(row(mine).status).toBe('CLOSED');
    expect(row(mine).walletPubkey).toBe(newSigner.publicKey.toBase58());
  });

  it('R4-2: a row from before the binding whose buy cannot be read is unknown: left open, never closed as a loss', async () => {
    const id = `r42unk_${uid()}`;
    livePosition(id, undefined);
    conn.getTransaction = vi.fn(async () => null);
    const res = await coordinator.startupReconciliation({ fresh: true });
    expect(row(id).status).toBe('OPEN');
    expect(res.details).toMatch(/WALLET_BINDING_UNKNOWN/);
  });

  it('R5-2: a 100% exit that finds the new signer\'s wallet empty does not close the old wallet\'s position', async () => {
    const id = `r52_${uid()}`;
    livePosition(id, oldWallet.publicKey.toBase58());
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 10 }, value: { amount: '0' } }));
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/WALLET_MISMATCH/);
    expect(row(id).status).toBe('OPEN');
    expect(row(id).costBasisLamports).toBe(100_000_000);
    expect(journal.mock.calls.some((c) => c[0] === 'REALIZED_ASSUMED_LOSS')).toBe(false);
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'POSITION_BALANCE_MISSING' && a.positionId === id)).toBe(false);
  });
});
