import { describe, it, expect, vi, afterEach } from 'vitest';
import { emergencyStopThroughApp, type HarnessSteps } from '../scripts/devnet_e2e_steps';

/**
 * Devnet run 2026-10-27 (fresh scratch, wallet HGMC): (m) used the DEVNET_LIVE session's budget, so (e''') could no longer set
 * DEVNET_LIVE (A31/A71: setting the mode again does not reset a used session). The step now raises the budget through the operator's
 * budget route (setBudget, what POST /api/auto/budget runs) to the real-SOL cap and tries again. The real step; app singletons are stubs.
 */
afterEach(() => vi.restoreAllMocks());

function harness(firstRefusal: string | null) {
  const recs: Array<{ step: string; ok: boolean; detail: string }> = [];
  const budgets: Array<{ maxBuys: number; maxSpendSol: number }> = [];
  let setModeCalls = 0;
  const s = {
    mint: 'MINT', rec: (step: string, ok: boolean, detail = '') => recs.push({ step, ok, detail }),
    sleep: async () => undefined, link: (x: string) => x, chainErr: async () => null,
    coordinator: { syncRealWalletBalance: async () => undefined, executeTrade: async () => ({ success: true, lifecycleState: 'CONFIRMED', txSignature: 'SIG' }) },
    buildBuyRequest: async () => ({}),
    db: { loadTransactions: () => [], loadPositions: () => [] },
    stop: {
      telegram: { processTelegramCommand: async () => ({ reply: 'EMERGENCY DUMP COMPLETE', actionTaken: 'PANIC_SELL_EXECUTED' }) },
      emergencyStop: async () => ({ autoStopped: true }),
      setKillSwitch: () => undefined,
      arm: () => ({ success: true, message: '' }),
      auto: {
        setMode: async (mode: string) => {
          setModeCalls++;
          if (firstRefusal && setModeCalls === 1) return { ok: false, mode: 'OFF', error: firstRefusal };
          if (firstRefusal && budgets.length === 0) return { ok: false, mode: 'OFF', error: firstRefusal };
          return { ok: true, mode };
        },
        getStatus: () => ({ mode: 'OFF', killed: true }),
        submitCandidate: async () => ({ outcome: 'DROPPED', reason: '' }),
        setBudget: (b: { maxBuys: number; maxSpendSol: number }) => { budgets.push(b); return { ok: true }; },
        maxSessionSpendSol: () => 0.06,
      },
    },
  } as unknown as HarnessSteps;
  return { s, recs, budgets };
}

describe("(e''') sets DEVNET_LIVE even after (m) used the session budget", () => {
  it('a SESSION_BUDGET_USED refusal raises the budget through the budget route and sets DEVNET_LIVE', async () => {
    const h = harness('DEVNET_LIVE is refused: SESSION_BUDGET_USED: the DEVNET_LIVE session started ... Setting the mode again does not reset it.');
    await emergencyStopThroughApp(h.s);
    expect(h.budgets).toEqual([{ maxBuys: 50, maxSpendSol: 0.06 }]);
    expect(h.recs.find((r) => r.step.endsWith('auto DEVNET_LIVE set'))?.ok).toBe(true);
  });

  it('any other refusal is not worked around', async () => {
    const h = harness('DEVNET_LIVE is refused: TRADING_HALTED: x');
    await emergencyStopThroughApp(h.s);
    expect(h.budgets).toEqual([]);
    expect(h.recs.find((r) => r.step.endsWith('auto DEVNET_LIVE set'))?.ok).toBe(false);
  });
});
