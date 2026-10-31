import './helpers/domGlobals';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { installDom, removeDom } from './helpers/domApp';

/**
 * R12-8: "Clear Token" ended the session on screen, but the open websocket stayed authenticated and kept streaming. And every frame set
 * `lastMessageAt`, AUTH_ERROR included, so a socket whose token the server refused still read as "streaming" for about 30 s.
 * The only stub is the WebSocket itself (the network boundary); engineClient runs as shipped.
 */
class ControlledSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: ControlledSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  closed = false;
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(public url: string) { ControlledSocket.all.push(this); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.({}); }
  addEventListener() {} removeEventListener() {}
  async open() { this.readyState = 1; await this.onopen?.({}); }
  frame(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

describe('R12-8: clearing the token ends the websocket session', () => {
  let ec: typeof import('../src/services/engineClient');
  beforeAll(async () => {
    installDom();
    vi.stubGlobal('WebSocket', ControlledSocket);
    (window as any).WebSocket = ControlledSocket;
    localStorage.setItem('apex_operator_token', 'tok-1');
    ec = await import('../src/services/engineClient');
  });
  afterAll(async () => { await removeDom(); });

  it('Clear Token closes the authenticated socket, and it no longer reads as streaming', async () => {
    const s = ControlledSocket.all[0];
    await s.open();
    expect(s.sent.some((m) => m.type === 'AUTH' && m.token === 'tok-1')).toBe(true);
    s.frame({ type: 'AUTHENTICATED', authenticated: true });
    s.frame({ type: 'PUMP_HOT_CALLOUTS', data: { callouts: [], leaderboard: [], status: {} } });
    expect(ec.engineClient.isWsConnected()).toBe(true);
    ec.setOperatorSessionToken('');
    expect(s.closed).toBe(true);
    expect(ec.engineClient.isWsConnected()).toBe(false);
  });

  it('AUTH_ERROR frames do not keep a socket "streaming"', async () => {
    localStorage.setItem('apex_operator_token', 'tok-2');
    await new Promise((r) => setTimeout(r, 3200)); // the client reconnects 3 s after a close
    const s = ControlledSocket.all[ControlledSocket.all.length - 1];
    expect(s).not.toBe(ControlledSocket.all[0]);
    await s.open();
    s.frame({ type: 'AUTHENTICATED', authenticated: true });
    s.frame({ type: 'MEMECOIN_SNAPSHOT', data: { pools: [], positions: [], config: {} } });
    const t0 = Date.now();
    expect(ec.engineClient.isWsConnected(t0)).toBe(true);
    // the token is refused from here on: only AUTH_ERROR frames arrive
    const later = t0 + ec.WS_QUIET_MS + 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    s.frame({ type: 'AUTH_ERROR', action: 'SNIPE_MEMECOIN', error: 'Invalid operator session token' });
    expect(ec.engineClient.isWsConnected(later)).toBe(false);
    vi.restoreAllMocks();
  }, 10_000);

  it('the browser going offline marks the socket down at once', async () => {
    const s = ControlledSocket.all[ControlledSocket.all.length - 1];
    s.frame({ type: 'MEMECOIN_SNAPSHOT', data: { pools: [], positions: [], config: {} } });
    expect(ec.engineClient.isWsConnected()).toBe(true);
    window.dispatchEvent(new (window as any).Event('offline'));
    expect(ec.engineClient.isWsConnected()).toBe(false);
  });
});
