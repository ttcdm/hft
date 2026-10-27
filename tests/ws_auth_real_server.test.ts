import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { authManager } from '../server/middleware/auth';
import { walletTrader } from '../server/walletTrader';

/**
 * The WebSocket auth flow against the real server.ts handler (round 1 #31), replacing the copied-handler tests in
 * adversarialConcurrencyAndSecurityM1.test.ts Mission 4. The real server runs in process on an ephemeral port; a real ws client talks to it.
 */
let wsUrl = '';
let httpServer: import('node:http').Server;

beforeAll(async () => {
  const mod = await import('../server');
  httpServer = mod.server;
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  wsUrl = `ws://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}/ws/engine`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

afterEach(() => vi.restoreAllMocks());

async function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(wsUrl, { headers });
  const frames: any[] = [];
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.once('close', (code, reason) => r({ code, reason: reason.toString() })));
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  return { ws, frames, closed };
}

const has = (frames: any[], type: string) => frames.some((f) => f.type === type);

describe('WebSocket auth on the real server', () => {
  it('an unauthenticated client gets AUTH_REQUIRED and no sensitive broadcast', async () => {
    const c = await connect();
    await vi.waitFor(() => expect(has(c.frames, 'AUTH_REQUIRED')).toBe(true));
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    walletTrader.emit('wallet_state_updated', walletTrader.getState());
    await new Promise((r) => setTimeout(r, 200));
    expect(c.frames.map((f) => f.type)).toEqual(['AUTH_REQUIRED']);
    c.ws.close();
  });

  it('a forged token gets AUTH_ERROR and still receives nothing', async () => {
    const c = await connect();
    await vi.waitFor(() => expect(has(c.frames, 'AUTH_REQUIRED')).toBe(true));
    c.ws.send(JSON.stringify({ action: 'AUTHENTICATE', token: 'forged_token_0000' }));
    await vi.waitFor(() => expect(has(c.frames, 'AUTH_ERROR')).toBe(true));
    expect(c.frames.find((f) => f.type === 'AUTH_ERROR').error).toBe('INVALID_OPERATOR_TOKEN');
    expect(has(c.frames, 'AUTHENTICATED')).toBe(false);
    walletTrader.emit('wallet_state_updated', walletTrader.getState());
    await new Promise((r) => setTimeout(r, 200));
    expect(has(c.frames, 'WALLET_STATE_UPDATED')).toBe(false);
    c.ws.close();
  });

  it('a valid operator token authenticates, gets the private snapshots, and then receives broadcasts', async () => {
    const c = await connect();
    c.ws.send(JSON.stringify({ action: 'AUTHENTICATE', token: authManager.createSession('OPERATOR').token }));
    await vi.waitFor(() => expect(has(c.frames, 'AUTHENTICATED')).toBe(true));
    await vi.waitFor(() => expect(has(c.frames, 'MEMECOIN_SNAPSHOT')).toBe(true));
    const seen = c.frames.length;
    walletTrader.emit('wallet_state_updated', walletTrader.getState());
    await vi.waitFor(() => expect(c.frames.slice(seen).some((f) => f.type === 'WALLET_STATE_UPDATED')).toBe(true));
    c.ws.close();
  });

  it('a mutating action before AUTHENTICATE closes the socket (4002) and runs nothing', async () => {
    // R4-12 (F): before it authenticates, a socket may send only AUTHENTICATE; anything else closes it (it used to answer
    // UNAUTHORIZED_MUTATION and keep the socket open).
    const panic = vi.spyOn(walletTrader, 'panicLiquidateAll');
    const c = await connect();
    await vi.waitFor(() => expect(has(c.frames, 'AUTH_REQUIRED')).toBe(true));
    c.ws.send(JSON.stringify({ action: 'PANIC_LIQUIDATE' }));
    const closed = await c.closed;
    expect(closed.code).toBe(4002);
    expect(closed.reason).toBe('Authenticate first');
    expect(c.frames.map((f) => f.type)).toEqual(['AUTH_REQUIRED']);
    expect(panic).not.toHaveBeenCalled();
  });

  it('a foreign Origin is closed with 4003', async () => {
    const c = await connect({ origin: 'https://evil-attacker-site.com' });
    const closed = await c.closed;
    expect(closed.code).toBe(4003);
    expect(closed.reason).toBe('Unauthorized WebSocket Origin');
    expect(has(c.frames, 'AUTH_REQUIRED')).toBe(false);
  });
});
