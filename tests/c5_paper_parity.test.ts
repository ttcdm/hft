import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { EligibilityFilter } from '../server/signals/eligibilityFilter';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, VALID_PUMP_MINT_2, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

const MINT = VALID_PUMP_MINT_1.toBase58();
const MINT2 = VALID_PUMP_MINT_2.toBase58();

const known = (mint: string, over: Record<string, unknown> = {}, mode: 'LIVE' | 'PAPER' = 'LIVE') =>
  EligibilityFilter.evaluate(
    {
      mint, symbol: 'P', name: 'P', liquidityUsd: 15_000, devHoldingPct: 2, top10HoldersPct: 12,
      isMintAuthorityRevoked: true, isFreezeAuthorityRevoked: true, ...over,
    } as any,
    mode
  );

describe('C5: PAPER runs the same gate as LIVE', () => {
  let live: ExecutionCoordinator;

  beforeEach(() => {
    const kp = Keypair.generate();
    const rpc = new MockSolanaRpc();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    live = new ExecutionCoordinator(rpc.createConnection());
    (live as any).realWalletBalanceSol = 1.0;
    process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
    vi.spyOn(live, 'canExecuteLive').mockReturnValue({ allowed: true, reasons: [], readiness: { ready: true, score: 100, reasons: [], components: {
      signer: { ready: true, status: 'READY', address: kp.publicKey.toBase58() },
      bankroll: { ready: true, balanceSol: 1.5, spendableSol: 1.485, reserveRequiredSol: 0.015 },
      database: { ready: true, writable: true },
      startupReconciliation: { ready: true, status: 'EXECUTION_READY', details: 'All clear' },
      solanaRpc: { ready: true, health: 'HEALTHY', latencyMs: 1 },
      pumpFeed: { ready: true, status: 'HEALTHY', lastEventSecAgo: 1 },
      positionMarks: { ready: true, status: 'HEALTHY', lastMarkSecAgo: 1 },
      killSwitch: { ready: true, active: false },
      circuitBreaker: { ready: true, state: 'CLOSED' },
      jitoTransport: { ready: true, health: 'HEALTHY' },
      realMarketData: { ready: true, lastEventSecAgo: 1 },
    } } as any });
    live.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const p of workstationDb.loadPositions('PAPER', 'ACTIVE')) await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
    delete process.env.ALLOW_LIVE_REAL_MONEY_TRADING;
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    riskEngine.setKillSwitch(false);
    executionConfig.updateConfig({ paperStrictGates: false });
  });

  const req = (mint: string, eligibilityReport: any, amountSol = 0.005) => ({
    mint, symbol: 'P', name: 'P', amountSol, jitoTipSol: 0.0001, source: 'AUTO_SNIPER' as const,
    provenance: 'REAL_ONCHAIN' as const, currentPriceSol: 0.0001, eligibilityReport, signalTimestamp: Date.now(),
  });

  it('a concentrated token is rejected by the eligibility gate in BOTH modes', async () => {
    const bad = known(MINT, { top10HoldersPct: 45 });
    const paper = await executionCoordinator.executeTrade(req(MINT, bad));
    const lv = await live.executeTrade(req(MINT, bad));
    for (const r of [paper, lv]) {
      expect(r.success).toBe(false);
      expect(r.lifecycleState).toBe('FILTER_REJECTED');
      expect(r.error).toMatch(/ELIGIBILITY_CHECK_FAILED/);
    }
  });

  it('a healthy token passes the eligibility gate in BOTH modes (PAPER fills; LIVE is never filter-rejected)', async () => {
    const good = known(MINT);
    const paper = await executionCoordinator.executeTrade(req(MINT, good));
    expect(paper.success, paper.error).toBe(true);
    const lv = await live.executeTrade(req(MINT, good));
    expect(lv.lifecycleState).not.toBe('FILTER_REJECTED');
  });

  it('a stale report is rejected identically in both modes', async () => {
    const stale = known(MINT2);
    stale.evaluatedAt = Date.now() - 65_000;
    const paper = await executionCoordinator.executeTrade(req(MINT2, stale));
    const lv = await live.executeTrade(req(MINT2, stale));
    expect(paper.error).toMatch(/ELIGIBILITY_REPORT_STALE/);
    expect(lv.error).toMatch(/ELIGIBILITY_REPORT_STALE/);
  });

  it('every paper fill records which gates passed, failed and stayed unverified, and journals them', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const r = await executionCoordinator.executeTrade(req(mint, known(mint)));
    expect(r.success, r.error).toBe(true);
    expect(journal.mock.calls.some((c) => c[0] === 'PAPER_FILL_GATES')).toBe(true);
    const gates: any = r.gates;
    expect(gates.eligibility.passed).toEqual(expect.arrayContaining(['TOP_10_CONCENTRATION', 'MAX_CREATOR_EXPOSURE', 'MIN_LIQUIDITY_DEPTH']));
    expect(gates.eligibility.failed).toEqual([]);
    expect(gates.capitalCeiling.passed).toBe(true);
    expect(gates.risk.approved).toBe(true);
  });

  it('unknown holder data: LIVE rejects, PAPER fills but records it unverified; PAPER_STRICT_GATES makes PAPER reject too', async () => {
    const unknownHolders = known(MINT2, { devHoldingPct: null, top10HoldersPct: null });
    // PAPER re-reads on-chain facts when holders are UNKNOWN; none are readable here
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(null as any);
    const mint = Keypair.generate().publicKey.toBase58();
    const rep = known(mint, { devHoldingPct: null, top10HoldersPct: null }, 'PAPER');
    const lenient = await executionCoordinator.executeTrade(req(mint, rep));
    expect(lenient.success, lenient.error).toBe(true);
    expect((lenient.gates as any).eligibility.unverified).toEqual(expect.arrayContaining(['TOP_10_CONCENTRATION', 'MAX_CREATOR_EXPOSURE']));

    vi.mocked(PumpCurveService.fetchPumpMarketState).mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(await import('../server/solana/pumpCurve'), 'fetchTokenHolderDistribution').mockRejectedValue(new Error('rpc down'));
    const lv = await live.executeTrade(req(MINT2, unknownHolders));
    expect(lv.success).toBe(false);
    expect(lv.lifecycleState).toBe('FILTER_REJECTED');

    executionConfig.updateConfig({ paperStrictGates: true });
    const mint3 = Keypair.generate().publicKey.toBase58();
    const strict = await executionCoordinator.executeTrade(req(mint3, known(mint3, { devHoldingPct: null, top10HoldersPct: null }, 'PAPER')));
    expect(strict.success).toBe(false);
    expect(strict.lifecycleState).toBe('FILTER_REJECTED');
  });

  it('paper sizing uses the configured 0.07 SOL bankroll (10% of spendable), not an invented 1.0', async () => {
    expect(executionConfig.getConfig().paperBankrollSol).toBe(0.07);
    const mint = Keypair.generate().publicKey.toBase58();
    const big = await executionCoordinator.executeTrade(req(mint, known(mint), 0.02));
    expect(big.success).toBe(false);
    expect(big.error).toMatch(/EXCEEDS_CAPITAL_CEILING/);
    const ok = await executionCoordinator.executeTrade(req(mint, known(mint), 0.005));
    expect(ok.success, ok.error).toBe(true);
  });

  it('the tip the risk engine approved is the tip the paper fill is charged', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const spy = vi.spyOn(riskEngine, 'evaluateOrder');
    const r = await executionCoordinator.executeTrade({ signalTimestamp: Date.now(), ...req(mint, known(mint)), jitoTipSol: 0.0004 });
    expect(r.success, r.error).toBe(true);
    const approvedTip = spy.mock.calls[0][0].jitoTipLamports;
    expect((r.gates as any).risk.tipLamports).toBe(approvedTip);
    expect(r.feesPaidLamports).toBeGreaterThanOrEqual(approvedTip as number);
  });
});
