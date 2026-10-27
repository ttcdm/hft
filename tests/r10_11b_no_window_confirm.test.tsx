import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, FakeServer } from './helpers/domApp';
import { ConfirmHost, confirmLiveClick } from '../src/components/ConfirmDialog';
import { liveClickWarning } from '../src/utils/tradingMode';

/**
 * R10-11 (follow-up): after PANIC and KILL AUTO, the header RESUME, the sell confirms and the LIVE snipe warnings still used
 * window.confirm, where Enter accepts. They all go through the in-page confirm dialog now.
 */
const dialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null;
const enterOn = async (el: Element): Promise<boolean> => {
  const ev = new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => { el.dispatchEvent(ev); });
  return ev.defaultPrevented;
};

describe('R10-11: no window.confirm is left in the dashboard', () => {
  it('src has no window.confirm or bare confirm() call', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            const code = /^\s*(\*|\/\*)/.test(line) ? '' : line.replace(/\/\/.*$/, ''); // comments may name it
            if (/\bwindow\.confirm\b|(^|[^\w.])confirm\(/.test(code)) hits.push(`${p}:${i + 1}`);
          });
        }
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});

describe('R10-11: RESUME, sells and LIVE snipes confirm in the dialog', () => {
  let server: FakeServer;
  beforeEach(() => {
    const win = installDom();
    win.confirm = () => { throw new Error('window.confirm must not be used'); };
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
  });
  afterEach(async () => { await removeDom(); });

  it('header RESUME: the dialog opens on Cancel, Enter does not accept, a click resumes', async () => {
    await renderApp();
    const btn = () => document.getElementById('btn-emergency-kill-switch');
    await click(btn());
    expect(server.killSwitchActive).toBe(true);
    const later = Date.now() + 2500;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    await click(btn());
    expect(dialog()?.textContent).toMatch(/RESUME TRADING\?/);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('confirm-cancel');
    expect(await enterOn(document.querySelector('[data-testid="confirm-ok"]')!)).toBe(true);
    await click(document.querySelector('[data-testid="confirm-cancel"]'));
    expect(server.killSwitchActive).toBe(true);
    await click(btn());
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    await flush();
    expect(server.killSwitchActive).toBe(false);
  });

  it('a LIVE snipe warning: the same dialog, a click says yes, Cancel says no', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<ConfirmHost />); });
    const warning = liveClickWarning({ live: true, cluster: 'devnet' } as any, 'Sniping $X for 0.01 SOL')!;
    let answer: boolean | undefined;
    await act(async () => { void confirmLiveClick(warning).then((a) => { answer = a; }); });
    expect(dialog()?.textContent).toMatch(/REAL transaction/);
    expect(await enterOn(document.querySelector('[data-testid="confirm-ok"]')!)).toBe(true);
    await click(document.querySelector('[data-testid="confirm-ok"]'));
    expect(answer).toBe(true);
    await act(async () => { void confirmLiveClick(warning).then((a) => { answer = a; }); });
    await click(document.querySelector('[data-testid="confirm-cancel"]'));
    expect(answer).toBe(false);
    await act(async () => root.unmount());
  });
});
