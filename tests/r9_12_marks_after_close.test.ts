import { describe, it, expect, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { executionCoordinator } from '../server/execution/coordinator';
import { workstationDb } from '../server/db/database';
import { buildSystemChecks } from '../server/system/systemChecks';

/**
 * R9-12: the "Position marks" row counted every uncleared POSITION_MARK_UNAVAILABLE alert, and the alert is cleared only inside the exit
 * pass for open positions. So once the position closed, the WARN (and the CRITICAL in the alert list) stayed for good.
 */
const now = Date.now();
const seed = (id: string, status: 'OPEN' | 'CLOSED') => workstationDb.savePosition({
  id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'R912', name: id, tokenDecimals: 6, tokenQuantityRaw: '1000000000',
  entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0.001, unrealizedPnLSol: 0, costBasisLamports: 1_000_000, realizedPnLSol: 0, status,
  venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `sig-${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
} as any);
const coord = executionCoordinator as any;
const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) {
    coord.clearOperatorAlert('POSITION_MARK_UNAVAILABLE', id);
    const p = workstationDb.loadPositions().find((x) => x.id === id); if (p) workstationDb.savePosition({ ...p, status: 'CLOSED' } as any);
  }
});

describe('R9-12: a mark alert for a position that is no longer open does not hold the marks row', () => {
  it('open position: WARN; after the close: the row and the alert list no longer count it', () => {
    const id = `r912-${now}`; ids.push(id);
    seed(id, 'OPEN');
    coord.raiseOperatorAlert('POSITION_MARK_UNAVAILABLE', 'No price for R912 for 200s', id);
    let r = buildSystemChecks();
    expect(r.checks.find((c) => c.id === 'marks')!.status).toBe('WARN');
    expect(r.operatorAlerts.some((a) => a.code === 'POSITION_MARK_UNAVAILABLE' && a.positionId === id)).toBe(true);

    seed(id, 'CLOSED');
    r = buildSystemChecks();
    const marks = r.checks.find((c) => c.id === 'marks')!;
    expect(marks.status).not.toBe('WARN');
    expect(marks.detail).toMatch(/1 mark alert\(s\) for positions no longer open are not counted/);
    expect(r.operatorAlerts.some((a) => a.code === 'POSITION_MARK_UNAVAILABLE' && a.positionId === id)).toBe(false);
  });
});
