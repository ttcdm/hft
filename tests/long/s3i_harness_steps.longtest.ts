import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * LONG BEHAVIOUR TEST, 3I: the devnet harness's Stage 3 steps (s), (t), (u) and (n) dry-run on the local validator by
 * scripts/localnet/harness_steps.ts (the same step functions `npm run devnet:e2e` runs, the app's real coordinator, feed listener,
 * watch window and funder lookup, the real pump program). Every line must PASS and every temp wallet must end empty.
 */
describe('3I: the Stage 3 harness steps on the local validator', () => {
  it('(s), (t), (u) and (n) pass, the budget check refuses underfunded, every temp wallet is refunded', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/localnet/harness_steps.ts'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, encoding: 'utf8', timeout: 280_000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
    expect(fails, out.slice(-3000)).toEqual([]);
    for (const step of ['(s) A1', '(t) B7/B10', '(u) B3', '(n) 3C', 'every temp wallet refunded']) expect(out).toContain(step);
    expect(r.status, out.slice(-3000)).toBe(0);
  });
});
