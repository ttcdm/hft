import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { authManager } from '../server/middleware/auth';

/**
 * R4-12: the /ws/engine socket had no frame size cap (the ws default is 100 MiB) and JSON-parsed every frame before authentication.
 * Now frames are capped at 64 KiB (close 1009) and an unauthenticated socket that sends anything but AUTHENTICATE is closed (4002).
 * The real server.ts, imported in process (it starts no trading under vitest), and a real ws client.
 */
let base = '';
let httpServer: import('node:http').Server;
let WS_MAX_PAYLOAD_BYTES = 0;

beforeAll(async () => {
  const mod: any = await import('../server');
  httpServer = mod.server;
  WS_MAX_PAYLOAD_BYTES = mod.WS_MAX_PAYLOAD_BYTES;
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  base = `ws://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}/ws/engine`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

async function open() {
  const ws = new WebSocket(base);
  const frames: any[] = [];
  ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
  ws.on('error', () => undefined); // a close for a too-large frame may surface as an error on the client too
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  return { ws, frames, closed };
}

describe('R4-12: /ws/engine frame cap and auth-first', () => {
  it('the cap is 64 KiB', () => {
    expect(WS_MAX_PAYLOAD_BYTES).toBe(64 * 1024);
  });

  it('a 1 MiB frame closes the socket with 1009 (message too big), before any auth', async () => {
    const s = await open();
    s.ws.send(JSON.stringify({ action: 'AUTHENTICATE', token: 'x'.repeat(1024 * 1024) }));
    expect(await s.closed).toBe(1009);
  });

  it('an unauthenticated socket that sends a command (even with a valid token in it) or non-JSON is closed with 4002', async () => {
    const token = authManager.createSession('OPERATOR').token;
    const a = await open();
    a.ws.send(JSON.stringify({ action: 'CLOSE_POSITION', positionId: 'nope', sellPct: 100, sessionToken: token }));
    expect(await a.closed).toBe(4002);
    expect(a.frames.some((f) => f.type === 'POSITION_CLOSED_RESULT')).toBe(false);
    const b = await open();
    b.ws.send('not json at all');
    expect(await b.closed).toBe(4002);
  });

  it('AUTHENTICATE first still works, and a failed AUTHENTICATE leaves the socket open for a retry', async () => {
    const s = await open();
    s.ws.send(JSON.stringify({ action: 'AUTHENTICATE', token: 'wrong-token-wrong-token' }));
    await expect.poll(() => s.frames.some((f) => f.type === 'AUTH_ERROR')).toBe(true);
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
    s.ws.send(JSON.stringify({ type: 'AUTH', action: 'AUTH', token: authManager.createSession('OPERATOR').token }));
    await expect.poll(() => s.frames.some((f) => f.type === 'AUTHENTICATED')).toBe(true);
    s.ws.send(JSON.stringify({ action: 'SOMETHING_HARMLESS' })); // after auth, other frames are not a reason to close
    await new Promise((r) => setTimeout(r, 200));
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
    s.ws.close();
  });
});
