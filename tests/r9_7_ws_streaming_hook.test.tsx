import './helpers/domGlobals';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installDom, removeDom, flush } from './helpers/domApp';

/** R9-7 (Tracker half): useWsStreaming() goes false when the socket goes quiet, closes or the browser goes offline. */
class ControlledSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: ControlledSocket[] = [];
  readyState = 0;
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(public url: string) { ControlledSocket.all.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.({}); }
  addEventListener() {} removeEventListener() {}
}

describe('R9-7: useWsStreaming', () => {
  beforeAll(() => {
    installDom();
    vi.stubGlobal('WebSocket', ControlledSocket);
    (window as any).WebSocket = ControlledSocket;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => { await removeDom(); });

  it('live after a data frame; down within a second of going quiet, and at once on close', async () => {
    const { useWsStreaming, WS_QUIET_MS } = await import('../src/services/engineClient');
    function Label() { return <span>{useWsStreaming() ? 'LIVE' : 'DOWN'}</span>; }
    const s = ControlledSocket.all[0];
    s.readyState = 1;
    await act(async () => { await s.onopen?.({}); });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<Label />); });
    expect(el.textContent).toBe('DOWN');
    await act(async () => {
      s.onmessage({ data: JSON.stringify({ type: 'AUTHENTICATED' }) });
      s.onmessage({ data: JSON.stringify({ type: 'MEMECOIN_PRICE_UPDATE', data: { pools: [], positions: [] } }) });
    });
    expect(el.textContent).toBe('LIVE');
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => t0 + WS_QUIET_MS + 1);
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    expect(el.textContent).toBe('DOWN');
    vi.restoreAllMocks();
    await act(async () => { s.onmessage({ data: JSON.stringify({ type: 'MEMECOIN_PRICE_UPDATE', data: { pools: [], positions: [] } }) }); });
    expect(el.textContent).toBe('LIVE');
    await act(async () => { s.close(); });
    expect(el.textContent).toBe('DOWN');
    await flush();
    await act(async () => root.unmount());
  });
});
