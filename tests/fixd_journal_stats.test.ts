import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { autoSnipeController, STATS_ROW_LIMIT } from '../server/auto/controller';
import { workstationDb } from '../server/db/database';
import { resetAuto } from './fixtures/auto';

/**
 * R6-3: the auto panel's stats mixed modes with auto OFF, read only the newest 5,000 rows without saying so, and took PnL from solDelta,
 * which a PAPER exit (and any exit booked outside closePosition) never writes, so a PAPER session showed 0 SOL and a 0% win rate.
 * The real controller over the in-memory journal and position ledger.
 */
function closedPosition(mode: 'PAPER' | 'LIVE', pnl: number): string {
  const id = `r63-${mode}-${Math.random().toString(36).slice(2)}`;
  workstationDb.savePosition({
    id, mint: Keypair.generate().publicKey.toBase58(), symbol: 'S', name: 'S', tokenDecimals: 6, tokenQuantityRaw: '0', costBasisLamports: 5e6,
    entryPriceSol: 1e-7, currentPriceSol: 1e-7, currentValueSol: 0, realizedPnLSol: pnl, entryTxSignature: id, entryTimestamp: Date.now() - 1000,
    executionMode: mode, status: 'CLOSED', lastUpdatedTimestamp: Date.now(),
  } as any);
  return id;
}

describe('R6-3: auto panel stats are per mode, from the ledger, with their window', () => {
  afterEach(async () => { vi.restoreAllMocks(); await resetAuto(); });

  it('with auto OFF, the last mode auto ran in is counted alone; PnL and win rate come from realized PnL', () => {
    const live = closedPosition('LIVE', -0.004);
    workstationDb.logDecision({ autoMode: 'DEVNET_LIVE', mint: 'x', stage: 'fill', outcome: 'BOUGHT', reason: 't', positionId: live });
    const paper = closedPosition('PAPER', 0.002);
    workstationDb.logDecision({ autoMode: 'PAPER', mint: 'y', stage: 'queue', outcome: 'QUEUED', reason: 't' });
    workstationDb.logDecision({ autoMode: 'PAPER', mint: 'y', stage: 'fill', outcome: 'BOUGHT', reason: 't', positionId: paper, inputs: { feesSol: 0.0001 } });
    // the PAPER exit wrote no solDelta (coordinator Q8): only the ledger knows its +0.002

    const s = autoSnipeController.getJournalStats();
    expect(s.mode).toBe('PAPER');
    expect(s.bought).toBe(1);
    expect(s.closed).toBe(1);
    expect(s.netPnlSol).toBeCloseTo(0.002, 12);
    expect(s.winRate).toBe(1);
    expect(s.truncated).toBe(false);
    expect(s.rowLimit).toBe(STATS_ROW_LIMIT);
    expect(s.rowsCounted).toBeGreaterThanOrEqual(2);
    expect(s.windowStart).not.toBeNull();
    expect(s.pnlSource).toBe('position ledger realizedPnLSol');
    expect(s.notes.join(' ')).toMatch(/PAPER auto rows only/);

    const l = autoSnipeController.getJournalStats({ mode: 'DEVNET_LIVE' });
    expect(l.mode).toBe('DEVNET_LIVE');
    expect(l.netPnlSol).toBeCloseTo(-0.004, 12);
    expect(l.winRate).toBe(0);
  });

  it('an exit booked outside closePosition (no EXITED row) is not counted as a total loss', () => {
    const id = closedPosition('PAPER', 0.0011); // closed by startup sell recovery: ledger booked, no exit row in the journal
    workstationDb.logDecision({ autoMode: 'PAPER', mint: 'z', stage: 'fill', outcome: 'BOUGHT', reason: 't', positionId: id, solDelta: -0.005 });
    const s = autoSnipeController.getJournalStats({ mode: 'PAPER' });
    expect(s.netPnlSol).toBeGreaterThan(0);
  });
});
