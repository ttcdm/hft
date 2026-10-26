import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { startApp, scratchDir } from './helpers/liveServer';
import { AutoResumeSchema } from '../server/execution/tradeInputs';
import { Keypair } from '@solana/web3.js';
import { autoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { emergencyStop } from '../server/execution/emergencyStop';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { solPriceService } from '../server/market/solPriceService';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';
import { evaluateKillTriggers, READINESS_RED_LIMIT_MS, type KillContext } from '../server/auto/killSwitch';
import { DEVNET_CONFIRMATION_CODE, LOSS_TRIGGER_TRADES } from '../server/auto/controller';
import { EXPECTANCY_WINDOW, MAX_CONSECUTIVE_LOSSES } from '../server/auto/killSwitch';
import { autoEvidencePnl } from '../server/auto/journalStats';

/**
 * 3E (R1-43, R1-118): a kill is saved before its first await, so a crash or a close that never returns cannot leave the old mode saved
 * for restorePersisted to bring back; the kill reason survives the restart too.
 */

/** What a restart does to the controller: memory is gone, the database stays. */
function simulateRestart(): void {
  const c = autoSnipeController as any;
  c.mode = 'OFF';
  c.session = null;
  c.killed = false;
  c.killReason = null;
  c.downgradeReason = null;
  c.triggers = [];
}

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

function seedOwnedActivePaper(): string {
  const id = `s3e-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'S3E', name: 'S3E', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
    entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN',
    venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: id, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  } as any);
  workstationDb.logDecision({ autoMode: 'PAPER', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 's3e seed', positionId: id });
  return id;
}

beforeEach(() => {
  memecoinAggregator.setConfluenceGating(false);
  solPriceService.setPrice(150, 'TEST_FIXTURE');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetAuto();
  vi.unstubAllEnvs();
  riskEngine.setKillSwitch(false);
  executionCoordinator.clearHalt();
  workstationDb.setSetting('auto.mode', null);
  workstationDb.setSetting('auto.kill', null);
  // 3E: losing auto trades a test seeded would count in every later test; acknowledge them, and let the clock move past the acknowledgement
  workstationDb.setSetting('auto.lossTriggerAck', { ts: Date.now() });
  await new Promise((r) => setTimeout(r, 5));
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
});

describe('3E: the kill is saved before its awaits', () => {
  it('a kill whose closePosition never resolves still leaves auto.mode OFF and the kill reason saved', async () => {
    await setAutoMode('PAPER');
    expect(workstationDb.getSetting('auto.mode')).toBe('PAPER');
    seedOwnedActivePaper();
    const close = vi.spyOn(executionCoordinator, 'closePosition').mockImplementation(() => new Promise(() => { /* never settles */ }));

    void autoSnipeController.kill({ exitAll: true, reason: 's3e hung close' });
    await vi.waitFor(() => expect(close).toHaveBeenCalled()); // the kill is past its wait and stuck inside the close

    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
    expect(workstationDb.getSetting<{ reason: string }>('auto.kill')?.reason).toBe('s3e hung close');
  });

  it('the emergency stop, with an auto buy in flight, has auto.mode OFF saved while it waits for that buy', async () => {
    await setAutoMode('PAPER');
    const held = gate();
    const realExecute = executionCoordinator.executeTrade.bind(executionCoordinator);
    const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockImplementation(async (req) => { await held.p; return realExecute(req); });
    const { mint } = newPumpPool('HOT');
    const buy = autoSnipeController.submitCandidate({ mint, symbol: 'S3E', source: 'TEST', amountUsd: 0.7, provenance: 'REAL_ONCHAIN' });
    await vi.waitFor(() => expect(exec).toHaveBeenCalled());

    const stop = emergencyStop({ exitAll: false, reason: 's3e panic' });
    await vi.waitFor(() => expect(autoSnipeController.getStatus().killed).toBe(true));
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF'); // the buy is still held: the kill has not reached its end yet
    expect(workstationDb.getSetting<{ reason: string }>('auto.kill')?.reason).toBe('s3e panic');

    held.open();
    await Promise.all([buy, stop]);
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('kill, restart: restorePersisted returns OFF and the status still says killed, with the reason', async () => {
    await setAutoMode('PAPER');
    await autoSnipeController.kill({ reason: 's3e operator kill' });
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(r.note).toMatch(/killed before the restart/);
    const st = autoSnipeController.getStatus();
    expect(st.mode).toBe('OFF');
    expect(st.killed).toBe(true);
    expect(st.killReason).toBe('s3e operator kill');
  });

  it('a saved kill wins over a saved trading mode (a crash mid-kill on an older build), and the saved mode is corrected to OFF', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    workstationDb.setSetting('auto.kill', { reason: 'crash mid-kill', ts: Date.now() });
    workstationDb.setSetting('auto.mode', 'PAPER');
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(autoSnipeController.getStatus().killReason).toBe('crash mid-kill');
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
  });

  it('an operator setting a mode again clears the saved kill; the next restart is not killed (and starts OFF, by design)', async () => {
    await setAutoMode('PAPER');
    await autoSnipeController.kill({ reason: 's3e' });
    await setAutoMode('SHADOW');
    expect(workstationDb.getSetting('auto.kill')).toBeNull();
    expect(autoSnipeController.getStatus().killed).toBe(false);
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(r.note).toMatch(/last run was in SHADOW/);
    expect(autoSnipeController.getStatus().killed).toBe(false);
  });
});

const healthyReadiness = () => vi.spyOn(executionCoordinator, 'getLiveReadiness').mockReturnValue({
  ready: true, reasons: [], checkedAt: Date.now(),
  components: {
    rpc: { healthy: true, latencyMs: 1, status: 'HEALTHY' }, pumpFeed: { healthy: true, lastEventAgeMs: 0, status: 'HEALTHY' },
    markFeed: { healthy: true, lastMarkAgeMs: 0, status: 'HEALTHY' }, jito: { healthy: true, status: 'HEALTHY' },
    db: { healthy: true, status: 'HEALTHY' }, signer: { healthy: true, status: 'READY' },
  },
} as any);

describe('3E: WALLET_UNKNOWN only after the balance has been unknown for longer than READINESS_RED_LIMIT_MS', () => {
  const liveCtx = (over: Partial<KillContext>): KillContext => ({
    mode: 'DEVNET_LIVE', closedNetPnlSol: [], dailyTotalPnlSol: 0, maxDailyLossSol: 0.02, slippageBreaches: 0, readinessRed: [],
    walletSol: null, reserveSol: 0.015, maxTradeSol: 0.005, ...over,
  });
  const codes = (c: KillContext) => evaluateKillTriggers(c).map((t) => t.code);

  it('the rule: unknown for up to the limit is no trigger, past it is; a caller that does not track the time still fires at once', () => {
    expect(codes(liveCtx({ walletUnknownForMs: 0 }))).toEqual([]);
    expect(codes(liveCtx({ walletUnknownForMs: READINESS_RED_LIMIT_MS }))).toEqual([]);
    expect(codes(liveCtx({ walletUnknownForMs: READINESS_RED_LIMIT_MS + 1 }))).toEqual(['WALLET_UNKNOWN']);
    expect(codes(liveCtx({}))).toEqual(['WALLET_UNKNOWN']);
    expect(codes(liveCtx({ walletUnknownForMs: Number.NaN }))).toEqual(['WALLET_UNKNOWN']); // a broken clock fails closed
  });

  it('on the controller: one null balance gives no trigger; 11 s of nulls (injected clock) give WALLET_UNKNOWN and disarm LIVE', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    healthyReadiness();
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('LIVE');
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockReturnValue(true);
    const arm = vi.spyOn(executionCoordinator, 'armLiveTrading').mockImplementation(() => ({ success: true } as any));
    const bal = vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);

    const realNow = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + offset);

    bal.mockReturnValue(null);
    expect(await autoSnipeController.checkTriggers()).toEqual([]); // the first failed read
    expect(autoSnipeController.getMode()).toBe('DEVNET_LIVE');
    offset = 5_000;
    expect(await autoSnipeController.checkTriggers()).toEqual([]);

    // a good read in between restarts the count
    bal.mockReturnValue(1);
    expect(await autoSnipeController.checkTriggers()).toEqual([]);
    bal.mockReturnValue(null);
    offset = 9_000;
    expect(await autoSnipeController.checkTriggers()).toEqual([]);
    offset = 9_000 + 11_000;
    const hits = await autoSnipeController.checkTriggers();
    expect(hits.map((h) => h.code)).toEqual(['WALLET_UNKNOWN']);
    expect(autoSnipeController.getMode()).toBe('SHADOW');
    expect(arm).toHaveBeenCalledWith(false);
  });
});

/** A closed PAPER trade the auto trader bought (a BOUGHT journal row names it), as an earlier session leaves behind. */
function seedClosedAutoTrade(pnl: number): string {
  const id = `s3e-c-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'S3E', name: 'S3E', tokenDecimals: 6, tokenQuantityRaw: '0', entryPriceSol: 1,
    currentPriceSol: 1, currentValueSol: 0, costBasisLamports: 1e6, realizedPnLSol: pnl, status: 'CLOSED', venue: 'PUMP_BONDING_CURVE',
    executionMode: 'PAPER', entryTxSignature: id, entryTimestamp: now - 1000, recordUpdatedAt: now, updatedAt: now,
  } as any);
  workstationDb.logDecision({ autoMode: 'PAPER', mint: 'm', stage: 'fill', outcome: 'BOUGHT', reason: 's3e earlier session', positionId: id });
  return id;
}
const lose = (i: number) => (i % 2 ? -0.00012 : -0.00008);

describe('3E: NEGATIVE_EXPECTANCY and LOSS_STREAK over the last auto trades across sessions, with an operator acknowledgement', () => {
  beforeEach(() => { healthyReadiness(); });

  it('autoEvidencePnl: owned trades only, after the acknowledgement, the last n, oldest first', () => {
    const rows = [
      { id: 'a', realizedPnLSol: -1, lastUpdatedTimestamp: 10 },
      { id: 'manual', realizedPnLSol: -9, lastUpdatedTimestamp: 20 },
      { id: 'b', realizedPnLSol: -2, lastUpdatedTimestamp: 30 },
      { id: 'c', realizedPnLSol: 3, lastUpdatedTimestamp: 40 },
    ];
    const owned = new Set(['a', 'b', 'c']);
    expect(autoEvidencePnl(rows, owned, { afterTs: null, n: 20 })).toEqual([-1, -2, 3]);
    expect(autoEvidencePnl(rows, owned, { afterTs: 10, n: 20 })).toEqual([-2, 3]); // closed at the acknowledgement: no longer counts
    expect(autoEvidencePnl(rows, owned, { afterTs: null, n: 2 })).toEqual([-2, 3]);
    expect(LOSS_TRIGGER_TRADES).toBe(Math.max(EXPECTANCY_WINDOW, MAX_CONSECUTIVE_LOSSES));
  });

  it('20 losing auto trades from earlier sessions give NEGATIVE_EXPECTANCY in a new session, and it drops to SHADOW', async () => {
    await setAutoMode('PAPER');
    for (let i = 0; i < EXPECTANCY_WINDOW; i++) seedClosedAutoTrade(lose(i) + (i === 5 ? 0.0002 : 0)); // one win: no streak of 20
    (autoSnipeController as any).session.startedAt = Date.now() + 60_000; // the session started after those trades closed
    const hits = await autoSnipeController.checkTriggers();
    expect(hits.map((h) => h.code)).toContain('NEGATIVE_EXPECTANCY');
    expect(autoSnipeController.getMode()).toBe('SHADOW');
  });

  it('a new session (also after a restart) is refused while the losses are unacknowledged; the acknowledgement lets it start, and the count starts afresh', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    for (let i = 0; i < MAX_CONSECUTIVE_LOSSES; i++) seedClosedAutoTrade(-0.0001);
    const refused = await autoSnipeController.setMode('PAPER');
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^LOSS_TRIGGERS_NEED_ACK: LOSS_STREAK/);
    expect(refused.error).toMatch(/ackLossTriggers/);
    expect(autoSnipeController.getMode()).toBe('OFF');

    await new Promise((res) => setTimeout(res, 2));
    expect(autoSnipeController.resume({ ackLossTriggers: true })).toMatchObject({ lossTriggersAcked: true });
    expect(workstationDb.loadDecisions({ stage: 'risk', limit: 5 }).some((d) => /acknowledged the loss triggers/.test(d.reason))).toBe(true);
    const ok = await autoSnipeController.setMode('PAPER');
    expect(ok.ok, ok.error).toBe(true);
    expect(await autoSnipeController.checkTriggers()).toEqual([]);
  });

  it('losing trades the operator opened by hand never count', async () => {
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    for (let i = 0; i < EXPECTANCY_WINDOW; i++) {
      const id = `s3e-m-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      workstationDb.savePosition({
        id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'M', name: 'M', tokenDecimals: 6, tokenQuantityRaw: '0', entryPriceSol: 1,
        currentPriceSol: 1, currentValueSol: 0, costBasisLamports: 1e6, realizedPnLSol: lose(i), status: 'CLOSED', venue: 'PUMP_BONDING_CURVE',
        executionMode: 'PAPER', entryTxSignature: id, entryTimestamp: now - 1000, recordUpdatedAt: now, updatedAt: now,
      } as any);
    }
    const ok = await autoSnipeController.setMode('PAPER');
    expect(ok.ok, ok.error).toBe(true);
    expect(await autoSnipeController.checkTriggers()).toEqual([]);
  });
});

describe('3E over HTTP: kill, restart on the same database (real server, two processes)', () => {
  it('auto kill then the kill switch, stop, start again: status OFF and killed with the reason, can-arm names KILL_SWITCH_WAS_ON; resume takes ackLossTriggers', async () => {
    expect(AutoResumeSchema.parse({ ackLossTriggers: true })).toEqual({ ackLossTriggers: true });
    const dir = scratchDir('s3e-restart');
    const env = { AUTO_SNIPE_ENABLED: 'true' };
    let app = await startApp(dir, env);
    try {
      const mode = await app.call('POST', '/api/auto/mode', { mode: 'SHADOW' });
      expect(mode.status, JSON.stringify(mode.json)).toBe(200);
      expect((await app.call('POST', '/api/auto/kill', { reason: 's3e http kill' })).json.status.killed).toBe(true);
      expect((await app.call('POST', '/api/execution/kill-switch', { activate: true })).json.killSwitchActive).toBe(true);
    } finally {
      await app.stop();
    }
    app = await startApp(dir, env);
    try {
      const st = (await app.call('GET', '/api/auto/status')).json;
      expect(st.mode).toBe('OFF');
      expect(st.killed).toBe(true);
      expect(st.killReason).toBe('operator kill switch');
      const can = (await app.call('GET', '/api/execution/can-arm')).json;
      expect(JSON.stringify(can.reasons)).toMatch(/KILL_SWITCH_WAS_ON/);
      const res = await app.call('POST', '/api/auto/resume', { ackLossTriggers: true });
      expect(res.status).toBe(200);
      expect(res.json.lossTriggersAcked).toBe(true);
    } finally {
      await app.stop();
    }
  }, 300_000);
});
