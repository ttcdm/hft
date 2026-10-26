import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WatchWindow, WATCH_MAX_CANDIDATES } from '../server/signals/watchWindow';
import { buildBoard } from '../server/board';

/** Q6c: the window held 10 launches and refused the rest with no trace. */
describe('Q6c: watch window capacity is sized for a real feed and refusals are counted', () => {
  const mint = () => Keypair.generate().publicKey.toBase58();

  it('holds at least 50 launches, and the launch past the cap is counted and announced', () => {
    expect(WATCH_MAX_CANDIDATES).toBeGreaterThanOrEqual(50);
    const w = new WatchWindow({ maxCandidates: 3 });
    const refused: any[] = [];
    w.on('refused', (e) => refused.push(e));
    const t0 = Date.now();
    const mints = [mint(), mint(), mint(), mint(), mint()];
    mints.forEach((m) => w.watch(m, 'creator', t0));
    expect(w.getSnapshot(t0).capacity).toEqual({ active: 3, max: 3, refusedFull: 2, lastRefusedMint: mints[4] });
    expect(refused).toHaveLength(2);
    expect(refused[1]).toMatchObject({ mint: mints[4], active: 3, max: 3, refusedFull: 2 });
  });

  it('the board carries the capacity', () => {
    const board = buildBoard();
    expect(board.watchCapacity).toMatchObject({ max: WATCH_MAX_CANDIDATES });
    expect(typeof board.watchCapacity.refusedFull).toBe('number');
  });
});
