import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import { AutoSnipeController, autoSnipeController, SESSION_BUDGETS, DEVNET_CONFIRMATION_CODE, AUTO_DEVNET_ORDER_SOL } from '../server/auto/controller';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { paperEngine } from '../server/execution/paperEngine';
import { workstationDb } from '../server/db/database';
import { solPriceService } from '../server/market/solPriceService';
import { riskEngine } from '../server/risk/riskEngine';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { AutoModeSchema } from '../server/execution/tradeInputs';
import { setAutoMode, resetAuto, releaseAs, newPumpPool } from './fixtures/auto';
import { watchWindow } from '../server/signals/watchWindow';

// A real pool for a fresh mint, created the way the feed creates one.
function newPool() {
  const mint = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const l = new PumpFeedListener();
  const ev = l.parseLogs({ err: null, signature: 'g1', logs: [PumpFeedListener.encodeCreateEventLog({ name: 'G1', symbol: 'G1', uri: '', mint, creator })] } as any, { slot: 9 })!;
  const pool = memecoinAggregator.ingestOnChainCreateEvent(ev);
  pool.liquidityUsd = 15_000; // a created pool starts at $0, which the liquidity gate (correctly) rejects
  l.destroy();
  releaseAs(mint, 'HOT'); // G2b: auto candidates come out of the watch window
  return mint;
}
const cand = (mint: string) => ({ mint, symbol: 'G1', source: 'TEST' as const, amountUsd: 0.7, provenance: 'REAL_ONCHAIN' as const });

describe('G1: auto-snipe controller', () => {
  beforeEach(() => {
    memecoinAggregator.setConfluenceGating(false);
    solPriceService.setPrice(150, 'TEST_FIXTURE');
  });
  afterEach(async () => {
    await resetAuto();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    riskEngine.setKillSwitch(false);
    for (const p of workstationDb.loadPositions('PAPER', 'ACTIVE')) await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
  });

  it('a fresh controller, and the process-wide one, start OFF (nothing is restored across a restart)', () => {
    expect(new AutoSnipeController().getMode()).toBe('OFF');
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('OFF: a candidate is dropped and nothing reaches execution', async () => {
    const exec = vi.spyOn(executionCoordinator, 'executeTrade');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome).toBe('DROPPED');
    expect(d.reason).toBe('AUTO_OFF');
    expect(exec).not.toHaveBeenCalled();
    expect(snipe).not.toHaveBeenCalled();
  });

  it('SHADOW: runs the gates, journals "would buy", and sends/fills nothing', async () => {
    await setAutoMode('SHADOW');
    const exec = vi.spyOn(executionCoordinator, 'executeTrade');
    const fill = vi.spyOn(paperEngine, 'executePaperBuy');
    const before = workstationDb.loadPositions().length;
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome, d.reason).toBe('WOULD_BUY');
    expect(d.stage).toBe('fill');
    expect(d.amountSol).toBeGreaterThan(0);
    expect(exec).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(workstationDb.loadPositions().length).toBe(before);
    expect(autoSnipeController.getDecisions(1)[0].outcome).toBe('WOULD_BUY');
  });

  it('R5: the mode the controller checked travels with the trade, and the coordinator refuses it if the mode changed in between', async () => {
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    // the mode flips to LIVE after the controller's check and before the trade reaches the coordinator
    const realExecute = executionCoordinator.executeTrade.bind(executionCoordinator);
    const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockImplementation(async (req) => {
      (executionCoordinator as any).executionMode = 'LIVE';
      return realExecute(req);
    });
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(snipe.mock.calls[0][0].expectedMode).toBe('PAPER');
    expect(exec.mock.calls[0][0].executionMode).toBe('PAPER');
    expect(d.outcome).toBe('REJECTED');
    expect(d.reason).toMatch(/MODE_CHANGED/);
  });

  it('SHADOW applies the same gates as a fill: a token the filter rejects is REJECTED, not "would buy"', async () => {
    await setAutoMode('SHADOW');
    const mint = newPool();
    vi.spyOn(executionCoordinator, 'previewBuy').mockResolvedValue({ status: 'REJECTED', error: 'ELIGIBILITY_CHECK_FAILED: stub', lifecycleState: 'FILTER_REJECTED' });
    const d = await autoSnipeController.submitCandidate(cand(mint));
    expect(d.outcome).toBe('REJECTED');
    expect(d.reason).toContain('ELIGIBILITY_CHECK_FAILED');
  });

  it('PAPER: a candidate becomes a simulated fill, counted against the session budgets', async () => {
    await setAutoMode('PAPER');
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome, d.reason).toBe('BOUGHT');
    const s = autoSnipeController.getStatus();
    expect(s.session!.buys).toBe(1);
    expect(s.session!.spentSol).toBeGreaterThan(0);
    expect(s.session!.positionIds).toContain(d.positionId);
    expect(s.session!.budgetsLeft.buys).toBe(SESSION_BUDGETS.maxBuys - 1);
  });

  it('PAPER mode refuses to start unless the coordinator is PAPER; any mode refuses without AUTO_SNIPE_ENABLED', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', '');
    expect((await autoSnipeController.setMode('SHADOW')).ok).toBe(false);
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    expect((await autoSnipeController.setMode('PAPER')).ok).toBe(false);
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('budgets: running out of buys, spend or loss drops the controller to SHADOW', async () => {
    const stub = (id: string, amountSol: number) =>
      vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: true, message: 'ok', txHash: 't', amountSol, positionId: id, feesPaidLamports: 0 });

    // spend
    await setAutoMode('PAPER');
    stub('p1', 0.02);
    await autoSnipeController.submitCandidate(cand(newPool()));
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(autoSnipeController.getStatus().downgradeReason).toMatch(/max spend/);

    // buys: five small ones
    await setAutoMode('PAPER');
    stub('p2', 0.001);
    for (let i = 0; i < SESSION_BUDGETS.maxBuys; i++) await autoSnipeController.submitCandidate(cand(newPool()));
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(autoSnipeController.getStatus().downgradeReason).toMatch(/max buys/);

    // loss: a position the session opened is down more than 15% of the bankroll
    await setAutoMode('PAPER');
    const bankroll = autoSnipeController.getStatus().session!.startingBankrollSol;
    workstationDb.savePosition({
      id: 'g1-loss', mint: Keypair.generate().publicKey.toBase58(), symbol: 'L', name: 'L', tokenDecimals: 6, tokenQuantityRaw: '1',
      entryPriceSol: 1, currentPriceSol: 0.5, currentValueSol: 0, costBasisLamports: Math.round((bankroll * SESSION_BUDGETS.maxLossFraction + 0.001) * 1e9), realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER',
      entryTxSignature: 'g1', entryTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    stub('g1-loss', 0.001);
    await autoSnipeController.submitCandidate(cand(newPool()));
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(autoSnipeController.getStatus().downgradeReason).toMatch(/loss/);
  });

  it('after a downgrade the next candidate is a shadow run, never a buy', async () => {
    await setAutoMode('PAPER');
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValueOnce({ success: true, message: 'ok', txHash: 't', amountSol: 0.02, positionId: 'x', feesPaidLamports: 0 });
    await autoSnipeController.submitCandidate(cand(newPool()));
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    const exec = vi.spyOn(executionCoordinator, 'executeTrade');
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome).not.toBe('BOUGHT');
    expect(exec).not.toHaveBeenCalled();
  });

  it('DEVNET_LIVE is refused unless: devnet cluster, coordinator armed LIVE, the cluster check passes, and the code matches', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    expect((await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE })).error).toMatch(/LIVE/); // coordinator is PAPER
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    expect((await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: 'nope' })).error).toMatch(/confirmation code/);
    vi.stubEnv('ALLOWED_CLUSTER', 'mainnet-beta');
    expect((await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE })).error).toMatch(/mainnet-beta/);
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
    expect(autoSnipeController.getMode()).toBe('DEVNET_LIVE');
  });

  it('DEVNET_LIVE uses the fixed small size and allows only one open position', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: true, message: 'ok', txHash: 't', amountSol: AUTO_DEVNET_ORDER_SOL, positionId: 'dv1', feesPaidLamports: 0 });
    // R3: an adopted airdrop (RECOVERED) is not a position the app chose; it must not take the only slot
    workstationDb.savePosition({
      id: 'dv-recovered', mint: Keypair.generate().publicKey.toBase58(), symbol: 'DUST', name: 'DUST', tokenDecimals: 6, tokenQuantityRaw: '5',
      entryPriceSol: 1e-9, currentPriceSol: 1e-9, currentValueSol: 0, costBasisLamports: 0, realizedPnLSol: 0, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: 'RECOVERED:dust', entryTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === 'dv-recovered')!, status: 'CLOSED' } as any);
    expect(d.outcome).toBe('BOUGHT');
    expect(snipe.mock.calls[0][0].amountSolOverride).toBe(AUTO_DEVNET_ORDER_SOL);

    workstationDb.savePosition({
      id: 'dv-open', mint: Keypair.generate().publicKey.toBase58(), symbol: 'O', name: 'O', tokenDecimals: 6, tokenQuantityRaw: '1',
      entryPriceSol: 1, currentPriceSol: 1, currentValueSol: 0, costBasisLamports: 1e6, realizedPnLSol: 0, status: 'OPEN',
      venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: 'dv', entryTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    const d2 = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d2.outcome).toBe('DROPPED');
    expect(d2.reason).toMatch(/MAX_OPEN_POSITIONS/);
    workstationDb.savePosition({ ...workstationDb.loadPositions().find((p) => p.id === 'dv-open')!, status: 'CLOSED' } as any); // do not leak an open LIVE row into later tests
  });

  it('R6: a buy that was sent and may have landed (unconfirmed / fill unreadable) counts against the DEVNET session cap, a plain rejection does not', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    const remaining = () => autoSnipeController.getStatus().session!.budgetsLeft.spendSol;
    const start = remaining();
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    snipe.mockResolvedValueOnce({ success: false, message: 'RISK_REJECTED: nope', txHash: '' });
    await autoSnipeController.submitCandidate(cand(newPool()));
    expect(remaining()).toBeCloseTo(start, 6);
    snipe.mockResolvedValueOnce({ success: false, message: 'UNCONFIRMED: did not confirm. The transaction was sent and may still land', txHash: '' });
    await autoSnipeController.submitCandidate(cand(newPool()));
    expect(remaining()).toBeCloseTo(start - AUTO_DEVNET_ORDER_SOL, 6);
  });

  it('L2: every candidate re-checks the coordinator mode (PAPER auto with LIVE armed, DEVNET_LIVE with the coordinator in PAPER)', async () => {
    // PAPER auto was started while the coordinator was PAPER; afterwards someone arms LIVE.
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome).toBe('REJECTED');
    expect(d.stage).toBe('mode');
    expect(d.reason).toMatch(/PAPER auto refused/);
    expect(snipe).not.toHaveBeenCalled();
    snipe.mockRestore();

    // DEVNET_LIVE started LIVE and armed; afterwards the coordinator drops to PAPER (kill switch, disarm).
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    const setDevnet = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(setDevnet.ok, setDevnet.error).toBe(true);
    vi.mocked(executionCoordinator.getExecutionMode).mockReturnValue('PAPER');
    vi.mocked(executionCoordinator.isLiveArmed).mockReturnValue(false);
    const snipe2 = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const d2 = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d2.outcome).toBe('REJECTED');
    expect(d2.reason).toMatch(/DEVNET_LIVE auto refused/);
    expect(snipe2).not.toHaveBeenCalled();
  });

  it('L9: a DEVNET_LIVE buy that would pass the real-SOL session spend limit is refused before it is sent', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    (autoSnipeController as any).session.spentSol = 0.02 - AUTO_DEVNET_ORDER_SOL / 2;
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome).toBe('REJECTED');
    expect(d.stage).toBe('budget');
    expect(d.reason).toMatch(/exceed the session spend limit/);
    expect(snipe).not.toHaveBeenCalled();
  });

  it('kill drops to OFF and can exit what the session opened; later candidates are dropped', async () => {
    await setAutoMode('PAPER');
    const d = await autoSnipeController.submitCandidate(cand(newPool()));
    expect(d.outcome, d.reason).toBe('BOUGHT');
    const r = await autoSnipeController.kill({ exitAll: true, reason: 'test' });
    expect(r.mode).toBe('OFF');
    expect(r.closed).toBe(1);
    expect(workstationDb.loadPositions().find((p) => p.id === d.positionId)!.status).toBe('CLOSED');
    expect((await autoSnipeController.submitCandidate(cand(newPool()))).reason).toBe('AUTO_OFF');
    expect(autoSnipeController.getStatus().killReason).toBe('test');
  });

  it('both candidate sources hand over to the controller and never call execution directly', () => {
    const fn = (src: string, start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
    const pump = fs.readFileSync('server/pumpfunService.ts', 'utf8');
    const trig = fn(pump, 'private async evaluateAutoSnipeTriggers', 'public evaluateCalloutConfluence');
    expect(trig).toContain('autoSnipeController.submitCandidate');
    expect(trig).not.toMatch(/executeSnipe\(|executeTrade\(/);
    const agg = fs.readFileSync('server/memecoinAggregator.ts', 'utf8');
    const loop = fn(agg, 'private startAutonomousSniperLoop', 'public ingestOnChainCreateEvent');
    expect(loop).toContain('autoSnipeController.submitCandidate');
    expect(loop).not.toMatch(/executeSnipe\(|executeTrade\(/);
  });

  it('clients cannot set dry-run or fixed-size, and the mode schema rejects unknown modes', () => {
    expect(AutoModeSchema.safeParse({ mode: 'MAINNET_LIVE' }).success).toBe(false);
    expect(AutoModeSchema.safeParse({ mode: 'SHADOW' }).success).toBe(true);
    const src = fs.readFileSync('server/execution/tradeInputs.ts', 'utf8');
    expect(src).toContain("'dryRun'");
    expect(src).toContain("'amountSolOverride'");
    const server = fs.readFileSync('server.ts', 'utf8');
    for (const route of ["'/api/auto/mode'", "'/api/auto/kill'", "'/api/auto/status'"]) {
      expect(server).toContain(`${route}, requireOperatorAuth`);
    }
  });
});

describe('G2b: the controller accepts only watch-window releases', () => {
  beforeEach(() => { memecoinAggregator.setConfluenceGating(false); solPriceService.setPrice(150, 'TEST_FIXTURE'); });
  afterEach(async () => { await resetAuto(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('a candidate the window never saw, or still holds, or declared DEAD, is dropped before any execution call', async () => {
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    const never = newPumpPool('NONE');
    const d1 = await autoSnipeController.submitCandidate(cand(never.mint));
    expect([d1.outcome, d1.stage, d1.reason]).toEqual(['DROPPED', 'watch', 'NOT_IN_WATCH_WINDOW']);

    const pending = newPumpPool('NONE');
    watchWindow.watch(pending.mint, Keypair.generate().publicKey.toBase58());
    const d2 = await autoSnipeController.submitCandidate(cand(pending.mint));
    expect(d2.reason).toMatch(/^WATCH_PENDING/);

    const dead = newPumpPool('DEAD');
    const d3 = await autoSnipeController.submitCandidate(cand(dead.mint));
    expect([d3.outcome, d3.stage]).toEqual(['DROPPED', 'watch']);
    expect(d3.reason).toMatch(/^WATCH_DEAD: CREATOR_SOLD/);
    expect(snipe).not.toHaveBeenCalled();
    // every drop is journaled with its reason
    for (const m of [never.mint, pending.mint, dead.mint]) {
      const rows = workstationDb.loadDecisions({ mint: m });
      expect(rows.map((r) => r.stage)).toEqual(['queue', 'watch']);
    }
  });

  it('HOT goes straight on to the execution stages; READY must also clear the confluence score (70)', async () => {
    await setAutoMode('PAPER');
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe').mockResolvedValue({ success: false, message: 'stub', txHash: '' });
    await autoSnipeController.submitCandidate(cand(newPumpPool('HOT').mint));
    expect(snipe.mock.calls[0][0].enforceConfluence).toBeFalsy();
    await autoSnipeController.submitCandidate(cand(newPumpPool('READY').mint));
    expect(snipe.mock.calls[1][0].enforceConfluence).toBe(true);
    expect(snipe.mock.calls[1][0].minConfluenceScore).toBe(70);
  });
});
