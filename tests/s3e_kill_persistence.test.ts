import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
import { DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';

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

  it('an operator setting a mode again clears the saved kill; the next restart restores normally', async () => {
    await setAutoMode('PAPER');
    await autoSnipeController.kill({ reason: 's3e' });
    await setAutoMode('SHADOW');
    expect(workstationDb.getSetting('auto.kill')).toBeNull();
    expect(autoSnipeController.getStatus().killed).toBe(false);
    simulateRestart();
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('SHADOW');
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
