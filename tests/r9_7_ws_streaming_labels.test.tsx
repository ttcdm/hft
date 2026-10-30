import './helpers/domGlobals';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, installFakeServer, flush, FakeServer } from './helpers/domApp';

/**
 * R9-7, Tracker half: with the browser offline the Tracker kept "WS STREAMING" and "SCREEN UPDATES LIVE": each screen kept its own flag,
 * set true by any frame (and by the cached frame replayed on subscribe) and re-checked only on its 5 to 6 s poll. Both labels now come
 * from engineClient's useWsStreaming(), which re-checks every second and on every socket change. Only WebSocket and fetch are stubbed.
 */
class ControlledSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: ControlledSocket[] = [];
  readyState = 0;
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(public url: string) { ControlledSocket.all.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.({}); }
  addEventListener() {} removeEventListener() {}
  async open() { this.readyState = 1; await this.onopen?.({}); }
  frame(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

describe('R9-7: the Tracker live labels follow the socket', () => {
  let server: FakeServer;
  beforeAll(async () => {
    installDom();
    server = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    vi.stubGlobal('WebSocket', ControlledSocket);
    (window as any).WebSocket = ControlledSocket;
    localStorage.setItem('apex_operator_token', 'tok');
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => { await removeDom(); });

  const live = async () => {
    const s = ControlledSocket.all[ControlledSocket.all.length - 1];
    await act(async () => {
      await s.open();
      s.frame({ type: 'AUTHENTICATED', authenticated: true });
      s.frame({ type: 'PUMP_HOT_CALLOUTS', data: { callouts: [], leaderboard: [], status: {} } });
      s.frame({ type: 'MEMECOIN_SNAPSHOT', data: { pools: [], positions: [], config: {} } });
    });
    await flush();
  };

  it('"SCREEN UPDATES LIVE" and "WS STREAMING" leave within about a second of the browser going offline', async () => {
    const { engineClient } = await import('../src/services/engineClient');
    const { PumpFunHotCalloutsView } = await import('../src/components/PumpFunHotCalloutsView');
    const { MemecoinSocialSniperModal } = await import('../src/components/MemecoinSocialSniperModal');
    void engineClient;
    await live();
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<><PumpFunHotCalloutsView /><MemecoinSocialSniperModal isOpen onClose={() => {}} /></>); });
    await flush(10);
    expect(el.textContent).toMatch(/SCREEN UPDATES LIVE/);
    expect(el.textContent).toMatch(/WS STREAMING/);
    await act(async () => { window.dispatchEvent(new (window as any).Event('offline')); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
    await flush();
    expect(el.textContent).not.toMatch(/SCREEN UPDATES LIVE/);
    expect(el.textContent).not.toMatch(/WS STREAMING/);
    await act(async () => root.unmount());
  }, 15_000);
});
