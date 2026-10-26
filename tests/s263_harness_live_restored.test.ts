import { describe, it, expect, vi, afterEach } from 'vitest';
import { releaseGatesOnChain, type HarnessSteps, type ChainKit } from '../scripts/devnet_e2e_steps';

/**
 * S263 (review 2026-10-24, findings 4 and 9): the devnet step (k) leaves LIVE exactly as it found it, even when something inside the step
 * armed it and then threw (the curve-cap check re-arms LIVE for its fresh-read buy), and a refund that fails is a FAIL line, not INFO.
 * The real step function; the app singletons and the chain kit are stubs (no network).
 */
afterEach(() => vi.restoreAllMocks());

function harness(wasArmed: boolean) {
  const recs: Array<{ step: string; ok: boolean }> = [];
  const armCalls: boolean[] = [];
  let armed = wasArmed;
  const s = {
    rec: (step: string, ok: boolean) => recs.push({ step, ok }),
    sleep: async () => undefined,
    link: (x: string) => x,
    stop: {
      arm: (a: boolean) => { armCalls.push(a); armed = a; return { success: true, message: '' }; },
      auto: {
        // the step re-arms LIVE inside (as the curve-cap check does), then throws
        setMode: async (mode: string) => {
          if (mode === 'SHADOW') { armed = true; armCalls.push(true); throw new Error('injected failure inside the step'); }
          return { ok: true, mode };
        },
        getStatus: () => ({ mode: 'OFF', killed: false }),
        submitCandidate: async () => ({ outcome: 'DROPPED', reason: '' }),
      },
    },
  } as unknown as HarnessSteps;
  const deps = {
    decisions: () => [], curveState: async () => null, progressPct: () => null, capPct: 60,
    buildBuyRequestFor: async () => ({}) as any, balanceSol: async () => 0, isLiveArmed: () => wasArmed,
  };
  return { s, deps, recs, armCalls, armedNow: () => armed };
}

describe('S263: step (k) puts LIVE back as it was', () => {
  it('disarmed before the step: disarmed after it, though the step armed LIVE and then threw', async () => {
    const h = harness(false);
    await releaseGatesOnChain(h.s, {} as ChainKit, { snapshot: () => ({ released: [], watching: [] }) } as any, {}, h.deps as any);
    expect(h.armedNow()).toBe(false);
    expect(h.armCalls.at(-1)).toBe(false);
    expect(h.recs.some((r) => r.step === '(k) release gates' && !r.ok)).toBe(true); // the throw is recorded as a FAIL
  });

  it('armed before the step: armed again after it', async () => {
    const h = harness(true);
    await releaseGatesOnChain(h.s, {} as ChainKit, { snapshot: () => ({ released: [], watching: [] }) } as any, {}, h.deps as any);
    expect(h.armedNow()).toBe(true);
  });
});
