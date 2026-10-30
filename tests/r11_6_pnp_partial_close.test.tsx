import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';

/**
 * R11-6: Plug & Play Close on a PARTIALLY_CLOSED row showed no result: the server answered {"status":"CLOSED"}, but the row stayed
 * PARTIALLY_CLOSED with its Close button until a reload. The result was set only after a full re-read of three endpoints, and any read
 * that came back late could put the old row back. The reply now shows at once, the row takes the status the close returned, and an
 * older read that lands after a newer one is dropped.
 */
const now = Date.now();
const partial = { id: 'r116', mint: 'So11111111111111111111111111111111111111112', symbol: 'PRT', tokenDecimals: 6, tokenQuantityRaw: '500000', costBasisLamports: 1_000_000,
  currentValueSol: 0.0005, status: 'PARTIALLY_CLOSED', executionMode: 'PAPER', entryTimestamp: now, lastMarkTimestamp: now };

describe('R11-6: a Close on a PARTIALLY_CLOSED row shows its result and the row follows', () => {
  let server: FakeServer;
  let hang = false;
  const pending: Array<() => void> = [];
  beforeEach(() => {
    installDom();
    hang = false;
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    let rows: any[] = [partial];
    server.routes['/api/workstation/positions'] = () => ({ json: { success: true, positions: rows } });
    server.routes['/api/wallet/close-position'] = () => { rows = [{ ...partial, status: 'CLOSED' }]; return { json: { success: true, data: { success: true, realizedPnLSol: 0.0002, status: 'CLOSED' } } }; };
    const realFetch = (window as any).fetch;
    const f = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      // a positions read made while `hang` is set answers with the rows as they were then, but only once the test releases it
      const res = realFetch(input, init);
      if (hang && /workstation\/positions/.test(url)) await new Promise<void>((r) => pending.push(r));
      return res;
    };
    (window as any).fetch = f;
    (globalThis as any).fetch = f;
  });
  afterEach(async () => { pending.forEach((r) => r()); await removeDom(); });

  it('the reply is shown at once and the row is CLOSED, whatever an older read says', async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    await click([...document.querySelectorAll('button')].find((b) => /^Open Positions/.test((b.textContent || '').trim()))!);
    const close = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close' && b.className.includes('text-rose-300'));
    expect(close).toBeTruthy();
    // a read starts before the close and is slow (Refresh State), then the close goes out
    hang = true;
    await click(document.querySelector('button[title="Refresh State"]'));
    hang = false;
    await click(close!);
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(5);
    expect(document.body.textContent).toMatch(/Closed 100% of \$PRT, realized \+0\.000200 SOL/);
    expect(document.body.textContent).not.toMatch(/PARTIALLY_CLOSED/);
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Close' && b.className.includes('text-rose-300'))).toBe(false);
    // the slow read that started before the close lands now, with the old row: it must not put PARTIALLY_CLOSED back
    pending.splice(0).forEach((r) => r());
    await flush(10);
    expect(document.body.textContent).toMatch(/Closed 100% of \$PRT/);
    expect(document.body.textContent).not.toMatch(/PARTIALLY_CLOSED/);
  });

  it('a refused close shows the reason through the shared outcome text', async () => {
    server.routes['/api/wallet/close-position'] = () => ({ status: 400, json: { success: false, error: 'Position not found or already closed' } });
    await renderApp();
    await click(document.getElementById('btn-nav-plug-and-play'));
    await flush(10);
    await click([...document.querySelectorAll('button')].find((b) => /^Open Positions/.test((b.textContent || '').trim()))!);
    await click([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close' && b.className.includes('text-rose-300'))!);
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush(5);
    expect(document.body.textContent).toMatch(/\$PRT is no longer open/);
  });
});
