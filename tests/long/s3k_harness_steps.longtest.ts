import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * LONG BEHAVIOUR TEST, 3K: the devnet harness's steps (m) for 3B and (o) for 3E dry-run on the local validator by
 * scripts/localnet/harness_steps_3k.ts (the same step functions `npm run devnet:e2e` runs; (m) through the app's real auto controller and
 * coordinator in-process, (o) through server.ts in child processes). Needs 3B and 3E applied: before them, (m)'s spentSol line and (o)'s
 * two lines after the crash FAIL, which is the point of the steps. Every other line must PASS and every temp wallet must end empty.
 */
describe('3K: the (m) and (o) harness steps on the local validator', () => {
  it('(m) and (o) pass and every temp wallet is refunded', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/localnet/harness_steps_3k.ts'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, encoding: 'utf8', timeout: 280_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
    expect(fails, out.slice(-3000)).toEqual([]);
    for (const step of ["(m) 3B: DEVNET_LIVE session spend: spentSol equals the wallet's drop", '(o) 3E: kill survives a restart: boot 4: can-arm lists KILL_SWITCH_WAS_ON', 'every temp wallet refunded']) expect(out).toContain(step);
    expect(r.status, out.slice(-3000)).toBe(0);
  });
});
