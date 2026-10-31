import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, typeInto, FakeServer } from './helpers/domApp';
import { pumpFunService } from '../server/pumpfunService';
import { AutoSnipeRulesSchema } from '../server/execution/tradeInputs';
import { parseDecimalText } from '../src/utils/numberInput';

/**
 * R11-9: the strategy-rule boxes took out-of-range values with no message (min caller win rate 150 or -5, max elapsed 0). The server
 * refused the save with a 400, the UI showed nothing, and the box kept the refused value while the server kept the old one. Each box
 * now checks the server's own range and says so; Save is refused while a box is out of range; a refusal by the server is shown under
 * the form and the boxes go back to what the server holds. The rules route answers with the real schema and service.
 */
describe('R11-9: strategy-rule boxes check the range and show a refusal', () => {
  let server: FakeServer;
  let refuse: string | null = null;
  beforeEach(() => {
    installDom();
    refuse = null;
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/pumpfun/callouts'] = () => ({ json: { callouts: [], leaderboard: [], autoSnipeRules: pumpFunService.getAutoSnipeRules() } });
    server.routes['/api/pumpfun/callouts/rules'] = (b) => {
      if (refuse) return { status: 400, json: { success: false, status: 'REJECTED', error: refuse } };
      const parsed = AutoSnipeRulesSchema.safeParse(b);
      if (!parsed.success) return { status: 400, json: { success: false, status: 'REJECTED', error: parsed.error.issues[0]?.message } };
      return { json: { status: 'OK', rules: pumpFunService.updateAutoSnipeRules(parsed.data as any) } };
    };
  });
  afterEach(async () => { await removeDom(); });

  const openRules = async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-telegram-tracker'));
    await click([...document.querySelectorAll('button')].find((b) => /Auto-Sniper Strategy Rules/.test(b.textContent || ''))!);
    await flush(5);
  };
  const box = (k: string) => document.querySelector(`[data-testid="rule-${k}"]`) as HTMLInputElement;
  const problem = (k: string) => document.querySelector(`[data-testid="rule-${k}-problem"]`)?.textContent ?? '';
  const save = () => [...document.querySelectorAll('button')].find((b) => /Save Strategy Rules/.test(b.textContent || '')) as HTMLButtonElement;
  const posts = () => server.calls.filter((c) => c.url === '/api/pumpfun/callouts/rules' && c.method === 'POST');

  it('the range is the server schema\'s', () => {
    expect(parseDecimalText('150', { min: 0, max: 100 })).toEqual({ ok: false, reason: expect.stringMatching(/0 to 100/) });
    expect(parseDecimalText('-5', { min: 0, max: 100 }).ok).toBe(false);
    expect(parseDecimalText('50', { min: 0, max: 100 })).toEqual({ ok: true, value: 50 });
  });

  for (const [k, v] of [['minCallerWinRate2x', '150'], ['minCallerWinRate2x', '-5'], ['maxElapsedSeconds', '0'], ['maxEntryMultiple', '0.5']] as const) {
    it(`${k} = ${v}: the box says it is out of range and Save sends nothing`, async () => {
      await openRules();
      await typeInto(box(k), v);
      expect(problem(k)).toMatch(/from .* to /);
      expect(save().disabled).toBe(true);
      await click(save());
      expect(posts()).toEqual([]);
    });
  }

  it('a refusal by the server is shown and the boxes go back to what the server holds', async () => {
    await openRules();
    const before = pumpFunService.getAutoSnipeRules().minAvgMultiple;
    refuse = 'minAvgMultiple: refused by the test server';
    await typeInto(box('minAvgMultiple'), '7');
    await click(save());
    await flush(5);
    expect(posts()).toHaveLength(1);
    expect(document.querySelector('[data-testid="rules-save-result"]')?.textContent).toMatch(/refused by the test server/);
    expect(box('minAvgMultiple').value).toBe(String(before));
  });
});
