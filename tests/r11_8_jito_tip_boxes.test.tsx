import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, typeInto, FakeServer } from './helpers/domApp';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { pumpFunService } from '../server/pumpfunService';
import { AutoSnipeRulesSchema } from '../server/execution/tradeInputs';

/**
 * R11-8: the Sniper "Jito tip (SOL)" box and the Rules "Jito Priority Tip" box showed the literal "undefined": loading the server
 * config replaced the client defaults, and that config has no tip (C6: absent means the dynamic policy decides). A typed tip was
 * overwritten within 5 s, Instant Snipe then sent no tip while one was shown, and the Rules tip could not be saved. The boxes now show
 * "auto" (nothing sent) or the typed tip, keep a typed tip across config loads, send exactly that, and the Rules tip saves.
 * The config and rules bodies are the real services' replies.
 */
const MINT = 'So11111111111111111111111111111111111111112';
describe('R11-8: the Jito tip boxes show the tip in use and keep a typed one', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/memecoins/config'] = () => ({ json: { status: 'OK', config: memecoinAggregator.getConfig() } });
    server.routes['/api/memecoins/trade'] = () => ({ json: { status: 'OK', result: { success: false, message: 'stub' } } });
    server.routes['/api/pumpfun/callouts'] = () => ({ json: { callouts: [], leaderboard: [], autoSnipeRules: pumpFunService.getAutoSnipeRules() } });
    server.routes['/api/pumpfun/callouts/rules'] = (b) => {
      const parsed = AutoSnipeRulesSchema.safeParse(b);
      if (!parsed.success) return { status: 400, json: { success: false, status: 'REJECTED', error: parsed.error.issues[0]?.message } };
      return { json: { status: 'OK', rules: pumpFunService.updateAutoSnipeRules(parsed.data as any) } };
    };
  });
  afterEach(async () => { await removeDom(); });

  const openSniperTab = async (name: RegExp) => {
    await renderApp();
    await click(document.getElementById('btn-nav-telegram-tracker'));
    await click([...document.querySelectorAll('button')].find((b) => name.test(b.textContent || ''))!);
    await flush(10);
  };

  it('Sniper: "auto" until typed; a typed tip survives a config load and is what the snipe sends', async () => {
    expect((memecoinAggregator.getConfig() as any).jitoTipSol).toBeUndefined(); // the real config has no tip
    await openSniperTab(/Autonomous Sniper/);
    const box = () => document.querySelector('[data-testid="sniper-jito-tip"]') as HTMLInputElement;
    expect(box().value).not.toMatch(/undefined/);
    expect(document.querySelector('[data-testid="sniper-jito-tip-in-use"]')?.textContent).toMatch(/^auto/);
    expect(document.querySelector('[data-testid="sniper-jito-tip-problem"]')).toBeNull();
    await typeInto(box(), '0.0007');
    await click(document.querySelector('button[title="Refresh Data"]')); // a config load, as the 5 s poll does
    await flush(5);
    expect(box().value).toBe('0.0007');
    await typeInto(document.querySelector('input[placeholder^="e.g. CzLSuj"]'), MINT);
    await click([...document.querySelectorAll('button')].find((b) => /SNIPE CA|Snipe CA|Snipe/i.test(b.textContent || '') && b.closest('div')?.querySelector('input[placeholder^="e.g. CzLSuj"]'))!);
    await flush(5);
    const trade = server.calls.filter((c) => c.url === '/api/memecoins/trade' && c.method === 'POST');
    expect(trade).toHaveLength(1);
    expect(trade[0].body.jitoTipSol).toBe(0.0007);
  });

  it('Sniper: with the box empty ("auto") the snipe sends no tip', async () => {
    await openSniperTab(/Autonomous Sniper/);
    await typeInto(document.querySelector('input[placeholder^="e.g. CzLSuj"]'), MINT);
    await click([...document.querySelectorAll('button')].find((b) => /Snipe/i.test(b.textContent || '') && b.closest('div')?.querySelector('input[placeholder^="e.g. CzLSuj"]'))!);
    await flush(5);
    const trade = server.calls.filter((c) => c.url === '/api/memecoins/trade' && c.method === 'POST');
    expect(trade).toHaveLength(1);
    expect('jitoTipSol' in trade[0].body).toBe(false);
  });

  it('Rules: "auto" until typed, and a typed tip saves and stays', async () => {
    await openSniperTab(/Pump\.fun|Hot Callouts|Callouts/);
    await click([...document.querySelectorAll('button')].find((b) => /Auto-Sniper Strategy Rules/.test(b.textContent || ''))!);
    const box = () => document.querySelector('[data-testid="rule-jitoPriorityTipSol"]') as HTMLInputElement;
    expect(box()).not.toBeNull();
    expect(box().value).not.toMatch(/undefined/);
    expect(document.querySelector('[data-testid="rule-jitoPriorityTipSol-in-use"]')?.textContent).toMatch(/^auto/);
    await typeInto(box(), '0.0009');
    await click([...document.querySelectorAll('button')].find((b) => /Save Strategy Rules/.test(b.textContent || ''))!);
    await flush(5);
    const save = server.calls.filter((c) => c.url === '/api/pumpfun/callouts/rules' && c.method === 'POST');
    expect(save.at(-1)?.body.jitoPriorityTipSol).toBe(0.0009);
    expect(pumpFunService.getAutoSnipeRules().jitoPriorityTipSol).toBe(0.0009);
    expect(box().value).toBe('0.0009');
  });
});
