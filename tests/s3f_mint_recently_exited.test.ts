import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, ExecuteTradeRequest, MINT_REENTRY_BLOCK_MS } from '../server/execution/coordinator';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { localSigner } from '../server/solana/signer';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';
import { executionConfig } from '../server/solana/executionConfig';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { solPriceService } from '../server/market/solPriceService';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState, createPassingEligibilityReport } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';
import { resetAuto } from './fixtures/auto';

/**
 * 3F (P3.4 part 3, R1-9): MINT_RECENTLY_EXITED. A mint whose position in this execution mode was closed less than 24 h ago is not bought
 * again, and one that was ever closed at a loss is never bought again. The rule lives in the coordinator, so it covers manual and auto
 * buys alike, and reads the positions table, so neither the auto controller's setMode, a disarm and re-arm nor a restart clears it.
 *
 * Real ExecutionCoordinator (armed after a real startup reconciliation), real AutoSnipeController and in-memory SQLite. Doubles: the
 * Connection (MockSolanaRpc), the signer and the curve/venue/builder/snapshot edges the other LIVE suites stub (as s3b does). The builder
 * rejects with TEST_BUILD_REACHED, so a buy the rule lets through stops there, after every pre-trade check. The rule runs after the
 * risk check (LIVE) and the paper gates (PAPER), so a halt, the kill switch or the loss latch still names itself first.
 */

const HOUR = 3_600_000;

const closeAllActive = () => {
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
};

/** A position of `mint` closed `ageMs` ago with `realizedPnLSol` booked: written at that time, as the sell path writes it. */
function seedExit(mint: string, mode: 'LIVE' | 'PAPER', realizedPnLSol: number, ageMs: number) {
  const id = `s3f_${Math.random().toString(36).slice(2)}`;
  const at = Date.now() - ageMs;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at - HOUR);
  workstationDb.savePosition({
    id, mint, symbol: 'S3F', name: 'S3F', tokenDecimals: 6, tokenQuantityRaw: '600000000000', entryPriceSol: 1e-8, currentPriceSol: 1e-8,
    currentValueSol: 0.005, costBasisLamports: 5_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: mode,
    entryTxSignature: `${mode}:${id}`, entryTimestamp: at - HOUR, recordUpdatedAt: at - HOUR, updatedAt: at - HOUR,
  } as any);
  vi.setSystemTime(at);
  const row = workstationDb.loadPositions(mode).find((p) => p.id === id)!;
  workstationDb.savePosition({ ...row, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0, realizedPnLSol, exitReason: 'STOP_LOSS', exitTxSignature: `exit-${id}` } as any);
  vi.useRealTimers();
  return id;
}

describe('3F: MINT_RECENTLY_EXITED, 24 h after any exit and for good after a loss', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let build: ReturnType<typeof vi.spyOn>;

  const buyReq = (mint: string, source = 'MANUAL_OPERATOR'): ExecuteTradeRequest => ({
    signalTimestamp: Date.now(), mint, symbol: 'S3F', name: 'S3F', amountSol: 0.005,
    source, provenance: 'REAL_ONCHAIN', eligibilityReport: createPassingEligibilityReport(mint),
  } as any);
  const newMint = () => Keypair.generate().publicKey.toBase58();

  /** A coordinator as a (re)started process builds it: startup reconciliation on the mock RPC, then armed LIVE. */
  const startCoordinator = async () => {
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    const init = vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    const c: any = rpc.createConnection();
    c.getBalance = vi.fn(async () => 1_000_000_000);
    c.getParsedTokenAccountsByOwner = vi.fn(async () => ({ context: { slot: 1 }, value: [] }));
    const next = new ExecutionCoordinator(c);
    await initDone;
    init.mockRestore();
    expect(next.getReconciliationStatus()?.status, next.getReconciliationStatus()?.details).toBe('EXECUTION_READY');
    expect(await next.syncRealWalletBalance()).toBeGreaterThan(0.015);
    expect(next.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK').success).toBe(true);
    vi.spyOn(next as any, 'scheduleOrphanRecovery').mockImplementation(() => undefined);
    vi.spyOn(next.getJitoTransport(), 'getTipFloorLamports').mockResolvedValue(null as any);
    return next;
  };

  beforeEach(async () => {
    vi.spyOn(ExecutionCoordinator.prototype as any, 'liveBuyReadinessProblems').mockRestore(); // the suite setup stubs it green (tests/setup/devnetGuard.ts)
    settleLeftoverLiveBuys();
    closeAllActive();
    memecoinAggregator.setConfluenceGating(false);
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    const wallet = Keypair.generate();
    vi.stubEnv('ALLOW_LIVE_REAL_MONEY_TRADING', 'true');
    vi.stubEnv('DEMO_MODE', '');
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    const realConfig = executionConfig.getConfig.bind(executionConfig);
    vi.spyOn(executionConfig, 'getConfig').mockImplementation(() => ({ ...realConfig(), jitoBlockEngineUrl: '', rpcFallbackTimeoutMs: 1200 }));
    vi.spyOn(workstationDb, 'getDailyTotalPnLSol').mockReturnValue(0);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() } as any;
    PumpCurveService.cachedFeeConfig = { feeBps: 100 } as any;
    riskEngine.setKillSwitch(false);
    riskEngine.setCircuitBreaker('CLOSED');
    riskEngine.recordRpcSuccess();
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    rpc = new MockSolanaRpc();
    coordinator = await startCoordinator();
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async () => createSimulatedBondingCurveState());
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() });
    build = vi.spyOn(txBuilder, 'buildBuyTransaction').mockRejectedValue(new Error('TEST_BUILD_REACHED'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    (riskEngine as any).lastTradeFailureTimestamp = 0;
    await resetAuto();
    executionCoordinator.clearHalt();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
    settleLeftoverLiveBuys();
    closeAllActive();
  });

  it('a CLOSED losing LIVE position of M: a manual and an auto buy of M are refused before anything is built', async () => {
    const mint = newMint();
    const id = seedExit(mint, 'LIVE', -0.0012, 30 * 24 * HOUR); // a month ago: a loss blocks for good
    for (const source of ['MANUAL_OPERATOR', 'AUTO_SNIPER']) {
      const res = await coordinator.executeTrade(buyReq(mint, source));
      expect(res.lifecycleState).toBe('RISK_REJECTED');
      expect(res.error).toMatch(new RegExp(`^MINT_RECENTLY_EXITED: ${mint} was closed at a loss \\(position ${id}, -0\\.001200 SOL\\)`));
    }
    expect(build).not.toHaveBeenCalled();
    const journal = (workstationDb as any).db.prepare(`SELECT payload_json FROM system_journal WHERE event_type = 'TRADE_RISK_REJECTED' AND payload_json LIKE ?`).all(`%${mint}%`);
    expect(journal.filter((r: any) => JSON.parse(r.payload_json).reason === 'MINT_RECENTLY_EXITED')).toHaveLength(2);
  });

  it('the block survives the auto controller\'s setMode, a disarm and re-arm, and a restart (a new coordinator on the same DB)', async () => {
    const mint = newMint();
    seedExit(mint, 'LIVE', -0.0012, HOUR);
    expect((await coordinator.executeTrade(buyReq(mint))).error).toMatch(/^MINT_RECENTLY_EXITED: /);

    // setMode clears the controller's per-session `attempted` set; the block is not kept there
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    vi.spyOn(executionCoordinator, 'syncRealWalletBalance').mockResolvedValue(null);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    expect((await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE })).ok).toBe(true);
    expect((await autoSnipeController.setMode('OFF')).ok).toBe(true);
    expect((await coordinator.executeTrade(buyReq(mint, 'AUTO_SNIPER'))).error).toMatch(/^MINT_RECENTLY_EXITED: /);

    expect(coordinator.armLiveTrading(false).success).toBe(true);
    expect(coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK').success).toBe(true);
    expect((await coordinator.executeTrade(buyReq(mint))).error).toMatch(/^MINT_RECENTLY_EXITED: /);

    coordinator.cleanup();
    coordinator = await startCoordinator();
    expect((await coordinator.executeTrade(buyReq(mint))).error).toMatch(/^MINT_RECENTLY_EXITED: /);
    expect(build).not.toHaveBeenCalled();
  });

  it('a winning exit 23 h ago is refused; one 25 h ago is let through to the builder', async () => {
    const recent = newMint();
    const id = seedExit(recent, 'LIVE', 0.0008, 23 * HOUR);
    const r1 = await coordinator.executeTrade(buyReq(recent));
    expect(r1.lifecycleState).toBe('RISK_REJECTED');
    expect(r1.error).toMatch(new RegExp(`^MINT_RECENTLY_EXITED: ${recent} was closed 23\\.0 h ago \\(position ${id}\\); it can be bought again after `));
    expect(build).not.toHaveBeenCalled();

    const old = newMint();
    seedExit(old, 'LIVE', 0.0008, 25 * HOUR);
    const r2 = await coordinator.executeTrade(buyReq(old));
    expect(r2.error ?? '').not.toMatch(/MINT_RECENTLY_EXITED/);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('the 24 h edge: refused one second before it, let through at it (block length is MINT_REENTRY_BLOCK_MS)', async () => {
    expect(MINT_REENTRY_BLOCK_MS).toBe(24 * HOUR);
    const a = newMint();
    seedExit(a, 'LIVE', 0, MINT_REENTRY_BLOCK_MS - 1_000);
    expect((await coordinator.executeTrade(buyReq(a))).error).toMatch(/^MINT_RECENTLY_EXITED: /);
    const b = newMint();
    seedExit(b, 'LIVE', 0, MINT_REENTRY_BLOCK_MS + 1_000);
    expect((await coordinator.executeTrade(buyReq(b))).error ?? '').not.toMatch(/MINT_RECENTLY_EXITED/);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('an old win followed by a later loss blocks for good; only the most recent exit sets the 24 h clock', async () => {
    const mint = newMint();
    seedExit(mint, 'LIVE', 0.002, 100 * HOUR);
    const lossId = seedExit(mint, 'LIVE', -0.0001, 50 * HOUR);
    seedExit(mint, 'LIVE', 0.003, 48 * HOUR);
    const res = await coordinator.executeTrade(buyReq(mint));
    expect(res.error).toMatch(new RegExp(`^MINT_RECENTLY_EXITED: ${mint} was closed at a loss \\(position ${lossId}`));
    expect(build).not.toHaveBeenCalled();
  });

  it('exits are per execution mode: a PAPER loss does not block a LIVE buy, and it does block a PAPER buy', async () => {
    const mint = newMint();
    seedExit(mint, 'PAPER', -0.004, HOUR);
    const live = await coordinator.executeTrade(buyReq(mint));
    expect(live.error ?? '').not.toMatch(/MINT_RECENTLY_EXITED/);
    expect(build).toHaveBeenCalledTimes(1);

    (riskEngine as any).lastTradeFailureTimestamp = 0; // the LIVE buy above stopped at the builder, which starts the failure cooldown
    const paper = await startCoordinator();
    expect(paper.armLiveTrading(false).success).toBe(true);
    expect(paper.getExecutionMode()).toBe('PAPER');
    const res = await paper.executeTrade(buyReq(mint));
    expect(res.executionMode).toBe('PAPER');
    expect(res.error).toMatch(/^MINT_RECENTLY_EXITED: .* was closed at a loss/);
    paper.cleanup();
  });

  it('the other refusals answer first: with the kill switch on, a recently exited mint is refused KILL_SWITCH_ACTIVE', async () => {
    const mint = newMint();
    seedExit(mint, 'LIVE', -0.0012, HOUR);
    riskEngine.setKillSwitch(true);
    const res = await coordinator.executeTrade(buyReq(mint));
    riskEngine.setKillSwitch(false);
    expect(res.error).toMatch(/^KILL_SWITCH_ACTIVE/);
    expect((await coordinator.executeTrade(buyReq(mint))).error).toMatch(/^MINT_RECENTLY_EXITED: /);
    expect(build).not.toHaveBeenCalled();
  });

  it('fail closed: the exits cannot be read, the buy is refused', async () => {
    const db = (workstationDb as any).db;
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: any) => {
      if (/FROM positions WHERE mint = \? AND execution_mode = \? AND status = 'CLOSED'/.test(String(sql))) throw new Error('database is locked');
      return realPrepare(sql);
    });
    const res = await coordinator.executeTrade(buyReq(newMint()));
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^MINT_RECENTLY_EXITED: the closed positions of .* could not be read/);
    expect(build).not.toHaveBeenCalled();
  });
});
