import fs from 'fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { executionCoordinator, MARK_STALE_MS, MARK_ALERT_AFTER_MS } from '../server/execution/coordinator';
import { RealMarkPriceService } from '../server/execution/reconciliation';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';

// Real coordinator + real ExitEngine + SQLite. Only the network read is faked.
const MINTS = [
  'So11111111111111111111111111111111111111112',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
];
const open = (mint: string) => workstationDb.loadPositions().find((p) => p.mint === mint)!;

async function enter(mint: string) {
  const res = await executionCoordinator.executeTrade({
    mint, symbol: 'C4', name: 'C4', amountSol: 0.005, jitoTipSol: 0.0001, source: 'AUTO_SNIPER',
    provenance: 'REAL_ONCHAIN', currentPriceSol: 0.0001,
  });
  expect(res.success, res.error).toBe(true);
}

function ageMark(mint: string, ageMs: number, price?: number) {
  const p = open(mint);
  p.lastMarkTimestamp = Date.now() - ageMs;
  if (price !== undefined) p.currentPriceSol = price;
  workstationDb.savePosition(p);
}

describe('C4: exits keep working on stale marks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    riskEngine.setKillSwitch(false);
  });

  it('stop-loss fires after 30s of stale feed when the direct read returns a price', async () => {
    await enter(MINTS[0]);
    ageMark(MINTS[0], 30_000);
    vi.spyOn(executionCoordinator, 'updatePositionMarkPrices').mockResolvedValue(undefined as any);
    const direct = vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({
      [MINTS[0]]: { priceSol: 0.00006, source: 'ON_CHAIN_BONDING_CURVE', timestamp: Date.now() },
    } as any);
    await executionCoordinator.evaluateAndProcessExits();
    expect(direct).toHaveBeenCalledWith(expect.anything(), [MINTS[0]], expect.any(String));
    expect(open(MINTS[0]).status).toBe('CLOSED');
  });

  it('no direct read, 30s stale: nothing fires and no alert yet; past the alert age an operator alert is raised', async () => {
    await enter(MINTS[1]);
    ageMark(MINTS[1], 30_000, 0.00001); // -90% on paper, but unpriced
    vi.spyOn(executionCoordinator, 'updatePositionMarkPrices').mockResolvedValue(undefined as any);
    vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({} as any);
    await executionCoordinator.evaluateAndProcessExits();
    expect(open(MINTS[1]).status).not.toBe('CLOSED');
    expect(executionCoordinator.getOperatorAlerts().filter((a) => a.positionId === open(MINTS[1]).id)).toHaveLength(0);

    ageMark(MINTS[1], MARK_ALERT_AFTER_MS + 5_000);
    await executionCoordinator.evaluateAndProcessExits();
    const alerts = executionCoordinator.getOperatorAlerts().filter((a) => a.positionId === open(MINTS[1]).id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].code).toBe('POSITION_MARK_UNAVAILABLE');
    expect(open(MINTS[1]).status).not.toBe('CLOSED');
    expect(executionCoordinator.getDiagnostics().operatorAlerts?.some((a) => a.code === 'POSITION_MARK_UNAVAILABLE')).toBe(true);

    // repeated ticks do not stack alerts
    await executionCoordinator.evaluateAndProcessExits();
    expect(executionCoordinator.getOperatorAlerts().filter((a) => a.positionId === open(MINTS[1]).id)).toHaveLength(1);
  });

  it('a returning mark clears the alert and lets the exit run', async () => {
    await enter(MINTS[2]);
    ageMark(MINTS[2], MARK_ALERT_AFTER_MS + 5_000);
    vi.spyOn(executionCoordinator, 'updatePositionMarkPrices').mockResolvedValue(undefined as any);
    const q = vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockResolvedValue({} as any);
    await executionCoordinator.evaluateAndProcessExits();
    const id = open(MINTS[2]).id;
    expect(executionCoordinator.getOperatorAlerts().some((a) => a.positionId === id)).toBe(true);

    q.mockResolvedValue({ [MINTS[2]]: { priceSol: 0.00006, source: 'ON_CHAIN_BONDING_CURVE', timestamp: Date.now() } } as any);
    await executionCoordinator.evaluateAndProcessExits();
    expect(executionCoordinator.getOperatorAlerts().some((a) => a.positionId === id)).toBe(false);
    expect(open(MINTS[2]).status).toBe('CLOSED');
  });

  it('lastUpdatedTimestamp no longer hides staleness: a never-marked position ages from its entry', () => {
    expect(MARK_STALE_MS).toBe(15_000);
    const src = fs.readFileSync('server/execution/coordinator.ts', 'utf8');
    const block = src.slice(src.indexOf('public async evaluateAndProcessExits'));
    expect(block.slice(0, 900)).not.toMatch(/lastMarkTimestamp \|\| pos\.lastUpdatedTimestamp/);
  });
});
