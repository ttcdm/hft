import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, MessageAccountKeys, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { TradeReconciler } from '../server/execution/reconciliation';
import { PaperExecutionEngine } from '../server/execution/paperEngine';
import { ExitEngine } from '../server/exits/exitEngine';
import { TOKEN_2022_PROGRAM_ID } from '../server/solana/programs';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { riskEngine } from '../server/risk/riskEngine';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import fixture from './fixtures/devnet_buy_5tVXiM.json';

/**
 * R14-8: the exit triggers compared a fee-inclusive entry price (SOL to the curve, pump fees included, per token) with the fee-free spot mark
 * (virtual SOL / virtual tokens), so a fresh buy started about 1.25% down: the -20% stop fired near -19% spot and TP1 needed about +31.6%.
 * Decision: both sides are fee-free prices. The entry is the SOL that reached the bonding curve per token (the curve account's own
 * balance change in the buy transaction), so "-20%" means the spot price 20% below what the curve charged before its fee, as the replay
 * already prices it. Real reconciler, coordinator, paper engine and exit engine; the transaction is the real devnet buy 5tVXiM (fixture).
 */
const WALLET = new PublicKey(fixture.accountKeys[0]);
const MINT = new PublicKey('GhkRAgqCeuRiE9eBGQ6nQFZkFeg7ZTwk55zNA7zF8YyH');
const TOKENS = 9_540_846.041122; // 9540846041122 raw, 6 decimals
const CURVE_NET_LAMPORTS = 9_876_542; // what the bonding curve account received; the other 123,458 of the 0.01 SOL were the 1.25% fee
const FEE_FREE = CURVE_NET_LAMPORTS / 1e9 / TOKENS;
const FEE_INCLUSIVE = 10_000_000 / 1e9 / TOKENS;

const fixtureConnection = () => ({
  getTransaction: async () => ({
    slot: fixture.slot,
    blockTime: 1_760_000_000,
    transaction: { message: { getAccountKeys: () => new MessageAccountKeys(fixture.accountKeys.map((k) => new PublicKey(k))), staticAccountKeys: fixture.accountKeys.map((k) => new PublicKey(k)) } },
    meta: { err: null, fee: fixture.fee, preBalances: fixture.preBalances, postBalances: fixture.postBalances, preTokenBalances: fixture.preTokenBalances, postTokenBalances: fixture.postTokenBalances },
  }),
  getTokenAccountBalance: async () => { throw new Error('not needed'); },
}) as any;

describe('R14-8: the entry price and the mark are on the same (fee-free) basis', () => {
  it('the reconciler reads the fee-free fill price from the bonding curve account\'s balance change', async () => {
    const snap = { walletSolLamports: fixture.preBalances[0], tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() };
    const r = await TradeReconciler.reconcileBuyTransaction(fixtureConnection(), fixture.signature, WALLET, MINT, TOKEN_2022_PROGRAM_ID, snap, 0);
    expect(r.success).toBe(true);
    expect(r.curveNetLamports).toBe(CURVE_NET_LAMPORTS);
    expect(r.feeFreeFillPriceSol).toBeCloseTo(FEE_FREE, 18);
    expect(r.effectiveFillPriceSol).toBeCloseTo(FEE_INCLUSIVE, 18); // unchanged: still the curve spend with its fee
  });

  it('a recovered buy enters at the fee-free price, so the -20% stop fires at -20% of it, not at about -19%', async () => {
    const r = await TradeReconciler.recoverInterruptedTransaction(fixtureConnection(), fixture.signature, WALLET);
    expect(r.curveNetLamports).toBe(CURVE_NET_LAMPORTS);
    const pos = (ExecutionCoordinator.prototype as any).positionFromRecoveredBuy.call({}, { signature: fixture.signature, mint: r.mint, jitoTipLamports: 0, executionMode: 'LIVE' }, r, fixture.slot, WALLET);
    expect(pos.entryPriceSol).toBeCloseTo(FEE_FREE, 18);
    expect(pos.costBasisLamports).toBe(12_902_540); // the cost basis stays all-in: PnL is lamports, not this price
    const at = (pct: number) => ExitEngine.evaluate({ entryPriceSol: pos.entryPriceSol, currentPriceSol: FEE_FREE * (1 + pct / 100), entryTimestamp: Date.now() - 1000 });
    expect(at(-19.5).shouldExit).toBe(false); // fired before: -19.5% of the fee-free price is -20.5% of the fee-inclusive one
    expect(at(-20.01).reason).toBe('STOP_LOSS');
    expect(at(29.9).shouldExit).toBe(false);
    expect(at(30.01).reason).toBe('TAKE_PROFIT_1'); // needed about +31.6% before
  });

  it('PAPER: a curve-quoted buy enters at the SOL that reached the curve per token (the fee is not in the entry price)', () => {
    const quote = { tokenAmountRaw: '1000000000', executionPriceSol: 0.0055 / 1000, spotPriceSol: 0.0000052, protocolFeeLamports: 51_600, creatorFeeLamports: 16_300, estimatedPriceImpactBps: 50 };
    const res = new PaperExecutionEngine().executePaperBuy({
      mint: Keypair.generate().publicKey.toBase58(), symbol: 'R148', name: 'R148', tokenDecimals: 6, amountSol: 0.0055, currentPriceSol: 0.0000052,
      slippageBps: 500, jitoTipSol: 0, curveQuote: quote,
    });
    expect(res.success).toBe(true);
    expect(res.position!.entryPriceSol).toBeCloseTo((5_500_000 - 51_600 - 16_300) / 1e9 / 1000, 15);
    expect(res.fillPriceSol).toBeCloseTo(0.0055 / 1000, 15); // the fill still reports the price paid, fees included
    expect(res.position!.costBasisLamports).toBe(5_500_000 + 5000); // and the basis everything paid
  });
});

describe('R14-8: a confirmed LIVE buy enters at the fee-free price', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let reconcile: ReturnType<typeof vi.spyOn>;
  const uid = () => Math.random().toString(36).slice(2);

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
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(coordinator as any, 'submitAndConfirmWithRetry').mockImplementation(async () => ({ success: true, signature: `r148_${uid()}`, transport: 'SOLANA_RPC', slot: 9, lifecycleState: 'CONFIRMED' }));
    reconcile = vi.spyOn(TradeReconciler, 'reconcileBuyTransaction');
    vi.spyOn(coordinator as any, 'liveBuyReadinessProblems').mockReturnValue([]);
    vi.spyOn(riskEngine, 'recordTradeFailure').mockImplementation(() => undefined);
    vi.spyOn(riskEngine, 'recordTradeSuccess').mockImplementation(() => undefined); // no per-mint cool-down between the two buys
    vi.spyOn(coordinator as any, 'syncRealWalletBalance').mockResolvedValue(undefined);
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
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    coordinator.cleanup();
    rpc.clear();
  });

  const buy = () => coordinator.executeTrade({
    signalTimestamp: Date.now(), mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'R148', name: 'R148', amountSol: 0.005,
    source: 'MANUAL', provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(VALID_PUMP_MINT_1.toBase58()),
  } as any);
  const fill = (extra: Record<string, unknown>) => reconcile.mockResolvedValue({
    success: true, reconciliationState: 'RECONCILED', actualSolSpentLamports: 7_200_000, actualTokensReceivedRaw: '1000000000', tokenDecimals: 6,
    tokensReceivedHuman: 1000, actualNetworkFeeLamports: 5000, actualJitoTipLamports: 0, effectiveFillPriceSol: 0.000005, allInFillPriceSol: 0.0000072,
    curveSpendLamports: 5_000_000, slot: 9, ...extra,
  } as any);

  it('the fill read from the curve account is the entry price', async () => {
    fill({ curveNetLamports: 4_938_272, feeFreeFillPriceSol: 0.000004938272 });
    const res = await buy();
    expect(res.success, res.error).toBe(true);
    const pos = workstationDb.loadPositions().find((p) => p.id === res.positionId)!;
    expect(pos.entryPriceSol).toBeCloseTo(0.000004938272, 15); // was 0.000005, the price with the fee in it
  });

  it('with no curve account in the transaction, the quote\'s own fee share is taken off the curve price', async () => {
    fill({});
    const res = await buy();
    expect(res.success, res.error).toBe(true);
    const pos = workstationDb.loadPositions().find((p) => p.id === res.positionId)!;
    expect(pos.entryPriceSol).toBeLessThan(0.000005);
    expect(pos.entryPriceSol).toBeGreaterThan(0.000005 * 0.97); // the simulated curve's fee tier, about 1%
  });
});
