import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, EXIT_LADDER_SELL_COUNT } from '../server/execution/coordinator';
import { estimateRoundTripCostLamports, MAX_ROUND_TRIP_COST_FRACTION } from '../server/risk/riskEngine';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { TradeReconciler } from '../server/execution/reconciliation';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * R3-28: the risk engine checks the signal and market-data ages once; the awaits after it (snapshot, build, sign) can outlast them. The
 * LIVE buy now refuses at the pre-send re-check once that send deadline has passed. Real ExecutionCoordinator.executeTrade and SQLite; the
 * curve read, the pre-trade snapshot (the await that "takes long" here, by moving the wall clock) and the send are the stubbed edges.
 */
describe('R3-28: a LIVE buy past its signal/market-data deadline is not sent', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let submit: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    const kp = Keypair.generate();
    rpc = new MockSolanaRpc();
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
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async () => ({ ...createSimulatedBondingCurveState(), marketDataTimestamp: Date.now() }) as any);
    submit = vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockResolvedValue({ success: false, signature: '', transport: 'SOLANA_RPC', error: 'should not be reached', lifecycleState: 'SUBMIT_FAILED' });
    vi.spyOn(coordinator as any, 'liveBuyReadinessProblems').mockReturnValue([]);
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, currentValueSol: 0, currentPriceSol: p.entryPriceSol, realizedPnLSol: 0 } as any);
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    vi.spyOn(workstationDb, 'loadMintExits').mockReturnValue({ lastExit: null, loss: null });
    (coordinator as any).realWalletBalanceSol = 1;
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
  });

  const buy = () => coordinator.executeTrade({
    signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'DL', name: 'DL', amountSol: 0.005,
    source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
  } as any);

  it('a snapshot read that takes past the 5 s market-data limit: refused with nothing sent', async () => {
    const realNow = Date.now.bind(Date);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockImplementation(async () => {
      const t0 = realNow();
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() - t0 + t0 + 6_000); // the read "took" 6 s
      return { walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: realNow() };
    });
    const res = await buy();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^ENTRY_REVOKED: the signal or its market data went stale/);
    expect(submit).not.toHaveBeenCalled();
  });

  it('within the limits the buy reaches the send, carrying the deadline', async () => {
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    await buy();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(typeof (submit.mock.calls[0][0] as any).buyNotAfter).toBe('number');
  });

  it('R8-6: the 20% round-trip gate counts one tip, base fee and priority fee per ladder sell (three), not one', async () => {
    expect(EXIT_LADDER_SELL_COUNT).toBe(3);
    const p = { buyTipLamports: 100_000, sellTipLamports: 100_000, priorityFeeLamports: 25_000, buyProtocolFeeLamports: 47_500, buyCreatorFeeLamports: 15_000 };
    expect(ExecutionCoordinator.ladderRoundTripCostLamports(p)).toBe(estimateRoundTripCostLamports(p) + 2 * (100_000 + 5_000 + 25_000));
    // an order whose one-sell round trip fits under 20% but whose three-sell ladder does not is refused
    const seen: number[] = [];
    const one: number[] = [];
    const real = ExecutionCoordinator.ladderRoundTripCostLamports.bind(ExecutionCoordinator);
    vi.spyOn(ExecutionCoordinator, 'ladderRoundTripCostLamports').mockImplementation((q) => { const v = real(q); seen.push(v - estimateRoundTripCostLamports(q)); one.push(estimateRoundTripCostLamports(q)); return v; });
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(coordinator as any, 'resolveLiveTip').mockImplementation(() => ({ tipLamports: 300_000, tipSol: 0.0003, policyReason: 'test' }));
    const res = await buy();
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThanOrEqual(2 * (300_000 + 5_000)); // two more sells, each with its tip and fees
    expect(one[0]).toBeLessThanOrEqual(MAX_ROUND_TRIP_COST_FRACTION * 0.005 * 1e9); // one sell alone would have passed
    expect(res.error).toMatch(/^EXPECTED_EDGE_BELOW_EXECUTION_COST/);
    expect(submit).not.toHaveBeenCalled();
    expect(MAX_ROUND_TRIP_COST_FRACTION).toBe(0.2);
  });
});
