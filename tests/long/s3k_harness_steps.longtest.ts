import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * LONG BEHAVIOUR TEST, 3K: the devnet harness's step (m) for 3B dry-run on the local validator by scripts/localnet/harness_steps_3k.ts
 * (the same step function `npm run devnet:e2e` runs, through the app's real auto controller and coordinator in-process). Needs 3B applied:
 * before it, (m)'s spentSol line FAILs, which is the point of the step. Every other line must PASS and every temp wallet must end empty.
 */
describe('3K: the (m) harness step on the local validator', () => {
  it('(m) passes and every temp wallet is refunded', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/localnet/harness_steps_3k.ts'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, encoding: 'utf8', timeout: 280_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
    expect(fails, out.slice(-3000)).toEqual([]);
    for (const step of ["(m) 3B: DEVNET_LIVE session spend: spentSol equals the wallet's drop", 'every temp wallet refunded']) expect(out).toContain(step);
    expect(r.status, out.slice(-3000)).toBe(0);
  });
});
