import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, executionCoordinator } from '../server/execution/coordinator';
import { emergencyStop, PANIC_BUY_SETTLE_WAIT_MS } from '../server/execution/emergencyStop';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { HardenedRiskEngine, riskEngine } from '../server/risk/riskEngine';
import { solPriceService } from '../server/market/solPriceService';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { workstationDb } from '../server/db/database';
import { resetAuto, setAutoMode } from './fixtures/auto';
import { createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';

/**
 * G (money-path test gaps D3, C1, A6) on the module singletons the operator routes use: the real emergencyStop, memecoinAggregator and
 * ExecutionCoordinator. Doubles only for the curve read (held on a gate), the close itself, and a buy in flight. Keys are throwaway values.
 */
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const freshMint = () => Keypair.generate().publicKey.toBase58();
const inFlight = () => (executionCoordinator as any).liveBuysInFlight as Map<string, Promise<void>>;

function seedLive(m: string): string {
  const id = `g-panic-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  workstationDb.savePosition({
    id, mint: m, symbol: 'GP', name: 'G panic', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 1e-7, currentPriceSol: 1e-7,
    currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE',
    entryTxSignature: `GSeeded${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  } as any);
  return id;
}

const waitDefault = PANIC_BUY_SETTLE_WAIT_MS.value;
beforeEach(() => solPriceService.setPrice(150, 'TEST_FIXTURE'));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  PANIC_BUY_SETTLE_WAIT_MS.value = waitDefault;
  inFlight().clear();
  await resetAuto();
  executionCoordinator.clearHalt();
  riskEngine.setKillSwitch(false);
  executionCoordinator.armLiveTrading(false);
  (executionCoordinator as any).executionMode = 'PAPER';
  memecoinAggregator.setConfluenceGating(true);
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
});

describe('G D3: the panic sells what a manual LIVE buy in flight opens', () => {
  it('waits for the buy, then sells the position it opened', async () => {
    const m = freshMint();
    let opened = '';
    // a manual buy past the risk gate: it settles 50 ms into the panic and leaves a LIVE position (what executeTrade registers, see the D3 case in g_money_path_fixes)
    inFlight().set(m, new Promise<void>((r) => setTimeout(() => { opened = seedLive(m); inFlight().delete(m); r(); }, 50)));
    const close = vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0, status: 'CLOSED' } as any);

    const report = await emergencyStop({ exitAll: true, reason: 'g-d3' });

    expect(opened).not.toBe('');
    expect(close.mock.calls.map((c) => c[0])).toContain(opened); // before the fix the panic read the positions at once and missed it
    expect(report.failed).toEqual([]);
  });

  it('a buy still unsettled when the wait ends is reported as BUY_IN_FLIGHT, not hidden', async () => {
    PANIC_BUY_SETTLE_WAIT_MS.value = 30;
    const m = freshMint();
    inFlight().set(m, new Promise<void>(() => undefined));
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0, status: 'CLOSED' } as any);

    const report = await emergencyStop({ exitAll: true, reason: 'g-d3-stuck' });

    expect(report.failed.some((f) => f.id === `buy-${m}` && /^BUY_IN_FLIGHT/.test(f.error))).toBe(true);
  });
});

describe('G C1: a PAPER snipe never turns LIVE because someone armed while it was reading', () => {
  it('the click captured PAPER: the coordinator refuses it as MODE_CHANGED and nothing is sent', async () => {
    memecoinAggregator.setConfluenceGating(false);
    const mint = freshMint(); // no pool yet, so the snipe reads the curve first (the await an arm can land in)
    const held = gate();
    let reading!: () => void;
    const curveRead = new Promise<void>((r) => { reading = r; });
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async () => { reading(); await held.p; return createSimulatedBondingCurveState(); });
    const trade = vi.spyOn(executionCoordinator, 'executeTrade');
    const send = vi.spyOn(executionCoordinator as any, 'submitAndConfirmWithRetry');
    expect(executionCoordinator.getExecutionMode()).toBe('PAPER');

    const snipe = memecoinAggregator.executeSnipe({ contractAddress: mint, amountUsd: 0, amountSolOverride: 0.0055, platform: 'PUMP_FUN', provenance: 'REAL_ONCHAIN', slippagePct: 6 });
    await curveRead;
    (executionCoordinator as any).executionMode = 'LIVE'; // an operator arms LIVE while the click is still reading
    held.open();
    const res = await snipe;

    expect(trade).toHaveBeenCalled();
    expect(trade.mock.calls[0][0].executionMode).toBe('PAPER'); // was undefined, so the coordinator ran it in its current mode, LIVE
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/MODE_CHANGED/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('G A6: after a panic and a restart, nothing can buy and the operator is told the kill switch was on', () => {
  const made: ExecutionCoordinator[] = [];
  afterEach(() => { while (made.length) made.pop()!.cleanup(); });
  const restart = () => { const c = new ExecutionCoordinator(true); made.push(c); return c; }; // what a restart builds: the default singleton

  it('panic, restart: auto OFF, PAPER, disarmed, kill switch off, KILL_SWITCH_WAS_ON raised once and cleared by the resume path', async () => {
    await setAutoMode('PAPER');
    await emergencyStop({ exitAll: false, reason: 'g-a6 operator panic' });
    expect(riskEngine.isKillSwitchActive()).toBe(true);
    expect(workstationDb.getKillSwitchTripBeforeRestart()).toBe('g-a6 operator panic');

    const after = restart();
    expect(workstationDb.getSetting('auto.mode')).toBe('OFF');
    expect(after.getExecutionMode()).toBe('PAPER');
    expect(after.isLiveArmed()).toBe(false);
    expect(new HardenedRiskEngine().isKillSwitchActive()).toBe(false); // by decision (2026-10-26): the flag is not persisted
    const alert = after.getOperatorAlerts().find((a) => a.code === 'KILL_SWITCH_WAS_ON' && !a.cleared);
    expect(alert?.message).toMatch(/g-a6 operator panic/);

    expect(restart().getOperatorAlerts().some((a) => a.code === 'KILL_SWITCH_WAS_ON')).toBe(false); // this boot only, not every boot
    after.clearHalt();
    expect(after.getOperatorAlerts().some((a) => a.code === 'KILL_SWITCH_WAS_ON' && !a.cleared)).toBe(false);
  });

  it('a switch reset before the restart raises nothing, and test or script coordinators never journal or alert', () => {
    riskEngine.setKillSwitch(true, 'g-a6 tripped then reset');
    riskEngine.setKillSwitch(false, 'operator reset');
    expect(restart().getOperatorAlerts().some((a) => a.code === 'KILL_SWITCH_WAS_ON')).toBe(false);
    new HardenedRiskEngine().setKillSwitch(true, 'a test engine');
    expect(workstationDb.getKillSwitchTripBeforeRestart()).toBeNull();
  });
});
