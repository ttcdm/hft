import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { installDom, removeDom, installFakeServer, renderApp, click, flush, typeInto, FakeServer } from './helpers/domApp';

/**
 * R13-7: the Memecoin console's /panic_sell and /dump_all ran the full emergency stop (kill switch, auto killed, LIVE disarmed, every
 * ACTIVE position sold) on one Enter: handleSendTerminal posted straight to the operator webhook, and a second Enter sent a second panic.
 * They now ask in the in-page confirm (Enter cannot accept it) first, and only one console panic can be out at a time.
 */
describe('R13-7: console /panic_sell and /dump_all ask first', () => {
  let server: FakeServer;
  beforeEach(() => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    server.routes['/api/auth/session'] = () => ({ json: { success: true } });
    server.routes['/api/telegram/webhook'] = (b) => ({ json: { success: true, result: { reply: `ran ${b?.message?.text}` } } });
  });
  afterEach(async () => { await removeDom(); });

  const webhookPosts = () => server.calls.filter((c) => c.url === '/api/telegram/webhook' && c.method === 'POST');
  const openConsole = async () => {
    await renderApp();
    await click(document.getElementById('btn-nav-telegram-tracker'));
    await click([...document.querySelectorAll('button')].find((b) => /Telegram Bot Control Hub/.test(b.textContent || ''))!);
    await flush(5);
    return document.querySelector('input[placeholder^="Type /snipe"]') as HTMLInputElement;
  };
  const enter = async (el: Element) => {
    await act(async () => { el.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await flush(3);
  };

  for (const cmd of ['/panic_sell', '/dump_all now']) {
    it(`${cmd}: Enter opens the confirm and sends nothing; Cancel sends nothing; the red button sends it once`, async () => {
      const input = await openConsole();
      await typeInto(input, cmd);
      await enter(input);
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toMatch(/EMERGENCY STOP/);
      expect(webhookPosts()).toEqual([]);
      // a second Enter on the console while the confirm is open does not queue a second panic
      await enter(input);
      await click(document.querySelector('[data-testid="confirm-cancel"]'));
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(webhookPosts()).toEqual([]);
      await typeInto(input, cmd);
      await enter(input);
      await click(document.querySelector('[data-testid="confirm-ok"]'));
      await flush(5);
      expect(webhookPosts().map((c) => c.body.message.text)).toEqual([cmd]);
    });
  }

  it('other commands are sent on Enter as before', async () => {
    const input = await openConsole();
    await typeInto(input, '/status');
    await enter(input);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(webhookPosts().map((c) => c.body.message.text)).toEqual(['/status']);
  });
});
