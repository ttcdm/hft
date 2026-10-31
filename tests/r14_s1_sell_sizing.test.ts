import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * R14-2 / R13-16: a LIVE sell books what it sold against the ROW. When the wallet holds more of the token than the position (tokens sent in
 * from outside), a partial must not set the row to the wallet's whole balance, and a full exit that leaves tokens in the wallet says so.
 * Real ExecutionCoordinator.closePosition and SQLite; the RPC, the builder, the send and the fill reader are stubbed at their edges.
 */
const uid = () => Math.random().toString(36).slice(2);
const mint = VALID_PUMP_MINT_1.toBase58();
const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id)!;

describe('R14-2 / R13-16: a LIVE sell is sized from the row, not the wallet', () => {
  let coordinator: ExecutionCoordinator;
  let mockRpc: MockSolanaRpc;
  let reconcileSell: ReturnType<typeof vi.spyOn>;
  let alerts: ReturnType<typeof vi.spyOn>;
  let wallet: Keypair;

  const seedLive = () => {
    const id = `r142_${uid()}`;
    workstationDb.savePosition({
      id, mint, symbol: 'R142', name: 'R142', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001, currentPriceSol: 0.0002,
      currentValueSol: 0.2, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE',
      entryTxSignature: `sig_${id}`, entrySlot: 1, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(), walletPubkey: wallet.publicKey.toBase58(),
    } as any);
    return id;
  };
  const clearLedger = () => {
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
  };
  const fill = (sold: string, walletAfter: string) => reconcileSell.mockResolvedValue({
    success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: sold, tokensSoldHuman: Number(sold) / 1e6, tokenDecimals: 6,
    actualGrossSolProceedsLamports: 20_005_000, actualNetSolProceedsLamports: 20_000_000, actualNetworkFeeLamports: 5000,
    actualJitoTipLamports: 0, actualRealizedPnLSol: 0.001, remainingTokensRaw: walletAfter, isFullyClosed: walletAfter === '0', slot: 6,
  } as any);

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    clearLedger();
    wallet = Keypair.generate();
    mockRpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (t: any) => t);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(mockRpc.createConnection());
    await initDone;
    const conn = (coordinator as any).connection;
    conn.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    conn.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 10 }, value: { amount: '1500000000' } })); // 500 more than the row
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1500000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockImplementation(async () => ({ success: true, signature: `sell_${uid()}`, transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' }));
    reconcileSell = vi.spyOn(TradeReconciler, 'reconcileSellTransaction');
    alerts = vi.spyOn(coordinator as any, 'raiseOperatorAlert');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    mockRpc.clear();
    clearLedger();
  });

  it('R14-2: a 33% partial leaves the row at its own quantity less the tokens sold, not at the wallet balance', async () => {
    const id = seedLive();
    fill('330000000', '1170000000'); // the wallet had 1500, sold 330, holds 1170
    const res = await coordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(res.success, res.error).toBe(true);
    const r = row(id);
    expect(r.status).toBe('PARTIALLY_CLOSED');
    expect(r.tokenQuantityRaw).toBe('670000000'); // was 1170000000: more than the row ever held
    expect(r.costBasisLamports).toBe(67_000_000);
  });

  it('R13-16: a full exit that leaves tokens in the wallet closes the row and raises an alert about the leftover', async () => {
    const id = seedLive();
    fill('1000000000', '500000000'); // the row's 1000 sold; the 500 sent in from outside are still there
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success, res.error).toBe(true);
    expect(row(id).status).toBe('CLOSED');
    const leftover = alerts.mock.calls.find((c) => c[0] === 'TOKENS_LEFT_AFTER_EXIT');
    expect(leftover?.[1]).toMatch(/500000000/);
  });

  it('R13-16: a full exit that empties the wallet raises no leftover alert', async () => {
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ context: { slot: 10 }, value: { amount: '1000000000' } }));
    const id = seedLive();
    fill('1000000000', '0');
    const res = await coordinator.closePosition(id, 100, 'STOP_LOSS');
    expect(res.success, res.error).toBe(true);
    expect(alerts.mock.calls.some((c) => c[0] === 'TOKENS_LEFT_AFTER_EXIT')).toBe(false);
  });
});
