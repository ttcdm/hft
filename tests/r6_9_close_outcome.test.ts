import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import { closeOutcomeText } from '../src/utils/closeOutcome';

/**
 * R6-9 (haiku-attack 2026-10-26): a close that adopted an earlier sell (maybe partial) or found the wallet empty (assumed loss) was
 * reported as "Closed 100%" / "Position closed with PnL". The real coordinator now says which, and the text says what happened.
 * Setup as tests/n1_exit_core.test.ts: real coordinator and SQLite, RPC, builder and reconciler stubbed at their edges; throwaway keys.
 * The position is bound to the signer's wallet (R5-2: an empty balance proves nothing for a position whose wallet is unknown).
 */
const uid = () => Math.random().toString(36).slice(2);

describe('R6-9: the coordinator says when a close sold nothing now', () => {
  let coordinator: ExecutionCoordinator;
  let submit: ReturnType<typeof vi.spyOn>;
  let posId: string;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    const kp = Keypair.generate();
    const rpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    await initDone;
    (coordinator as any).connection.simulateTransaction = vi.fn(async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }));
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 1000, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: true, signature: 'r69sell', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
    vi.spyOn(coordinator, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true } as any } as any);
    posId = `r69_${uid()}`;
    workstationDb.savePosition({
      id: posId, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'R69', name: 'R6-9', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 0.0001,
      currentPriceSol: 0.00005, currentValueSol: 0.05, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
      executionMode: 'LIVE', walletPubkey: kp.publicKey.toBase58(), entryTxSignature: `sig_${posId}`, entryTimestamp: Date.now(), lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
  });

  it('an empty wallet: outcome ASSUMED_LOSS_EMPTY_WALLET, and the text says nothing was sold and the loss is assumed', async () => {
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } }));
    const res = await coordinator.closePosition(posId, 100, 'Manual user order');
    expect(res).toMatchObject({ success: true, status: 'CLOSED', outcome: 'ASSUMED_LOSS_EMPTY_WALLET' });
    expect(submit).not.toHaveBeenCalled();
    const t = closeOutcomeText(res, 100, '$R69');
    expect(t.text).toMatch(/^Nothing was sold: the wallet held none of \$R69/);
    expect(t.text).toMatch(/ASSUMED loss/);
    expect(t.text).not.toMatch(/Closed 100%/);
    expect(t.tone).toBe('warning');
  });

  it('an earlier sell that landed unconfirmed is adopted: outcome ADOPTED_EARLIER_SELL; a partial says tokens are still held', async () => {
    const recon = TradeReconciler.reconcileSellTransaction as any;
    recon.mockResolvedValueOnce({ success: false, reconciliationState: 'RECONCILIATION_REQUIRED', error: 'fill unreadable' });
    workstationDb.saveTransaction({
      signature: 'r69sell', orderId: `ord-exit-${uid()}`, correlationId: 'exit-r69', mint: VALID_PUMP_MINT_1.toBase58(), direction: 'SELL',
      submissionTransport: 'SOLANA_RPC', submissionTime: Date.now(), reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
    });
    expect((await coordinator.closePosition(posId, 100, 'Manual user order')).success).toBe(false);
    (coordinator as any).connection.getTokenAccountBalance = vi.fn(async () => ({ value: { amount: '0' } }));
    const adopted = await coordinator.closePosition(posId, 100, 'Manual user order');
    expect(adopted).toMatchObject({ success: true, outcome: 'ADOPTED_EARLIER_SELL', status: 'CLOSED' });
    expect(closeOutcomeText(adopted, 100, '$R69').text).toMatch(/^No new sell was sent: an earlier sell of \$R69 .* was adopted/);
    const partial = closeOutcomeText({ ...adopted, status: 'PARTIALLY_CLOSED' }, 100, '$R69').text;
    expect(partial).toMatch(/Tokens are still held \(PARTIALLY_CLOSED\)/);
    expect(partial).not.toMatch(/now closed/);
  });
});

describe('R6-9: the Sniper close message', () => {
  afterEach(() => vi.restoreAllMocks());
  it('does not say "Closed 100%" for an assumed loss', async () => {
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: -0.1, status: 'CLOSED', solMoved: 0, outcome: 'ASSUMED_LOSS_EMPTY_WALLET' });
    const r = await memecoinAggregator.closePosition('abcdefgh-123', 100);
    expect(r.message).toMatch(/^Nothing was sold/);
    expect(r.message).not.toMatch(/Closed 100%/);
  });
  it('a plain sale still reads as a close; a failure names the error', async () => {
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0.01, status: 'CLOSED', solMoved: 0.02 });
    expect((await memecoinAggregator.closePosition('abcdefgh-123', 100)).message).toMatch(/^Closed 100% of position abcdefgh\.\.\., realized \+0\.010000 SOL/);
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: false, pnlSol: 0, error: 'RPC down' });
    expect((await memecoinAggregator.closePosition('abcdefgh-123', 100)).message).toMatch(/^Close failed: RPC down/);
  });
});

describe('R6-9: an adopted partial (C2) and an unread fill (C1) read from the one outcome field', () => {
  it('an adopted partial says so and gives the tokens left; an adopted full sell is "no new sell"; an unread fill names the assumed loss', async () => {
    const p = closeOutcomeText({ success: true, pnlSol: 0.001, status: 'PARTIALLY_CLOSED', outcome: 'ADOPTED_EARLIER_SELL', remainingTokensRaw: '123456' }, 100, 'AAA');
    expect(p.text).toMatch(/earlier PARTIAL sell of AAA .*adopted/);
    expect(p.text).toContain('123456 raw token units left');
    expect(p.text).not.toMatch(/now closed|Closed 100%/);
    expect(p.tone).toBe('warning');
    const f = closeOutcomeText({ success: true, pnlSol: 0.002, status: 'CLOSED', outcome: 'ADOPTED_EARLIER_SELL' }, 100, 'AAA');
    expect(f.text).toMatch(/^No new sell was sent: an earlier sell of AAA/);
    const u = closeOutcomeText({ success: true, pnlSol: -0.05, status: 'CLOSED', outcome: 'ADOPTED_EARLIER_SELL_FILL_UNREAD' }, 100, 'AAA');
    expect(u.text).toMatch(/fill could not be read: the sold share of its cost basis is booked as an ASSUMED loss \(-0\.050000 SOL\)/);
  });
});
