import { describe, it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';

// The guard in tests/setup/devnetGuard.ts must refuse non-loopback hosts for every client path,
// including net.connect/http.get, which pass an already-normalized argument array to Socket.connect.
describe('K1b: test network guard', () => {
  const attempt = (fn: () => void) =>
    new Promise<string>((resolve) => {
      try { fn(); resolve('no-throw'); } catch (e: any) { resolve(String(e.message)); }
    });

  it('refuses net.connect to a public host', async () => {
    (globalThis as any).__expectNetworkGuardHits = true;
    try {
      const msg = await attempt(() => { net.connect({ host: '93.184.216.34', port: 80 }).on('error', () => undefined).destroy(); });
      expect(msg).toMatch(/TEST_NETWORK_GUARD/);
    } finally { (globalThis as any).__expectNetworkGuardHits = false; (globalThis as any).__networkGuardHits.length = 0; }
  });

  it('refuses a plain http.get to a public host', async () => {
    (globalThis as any).__expectNetworkGuardHits = true;
    try {
      const outcome = await new Promise<string>((resolve) => {
        try {
          const req = http.get('http://example.com/', () => resolve('connected'));
          req.on('error', (e) => resolve(String(e.message)));
        } catch (e: any) { resolve(String(e.message)); }
      });
      expect(outcome).toMatch(/TEST_NETWORK_GUARD/);
    } finally { (globalThis as any).__expectNetworkGuardHits = false; (globalThis as any).__networkGuardHits.length = 0; }
  });

  it('still allows loopback', async () => {
    const srv = http.createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    const body = await new Promise<string>((res, rej) => http.get(`http://127.0.0.1:${port}/`, (r) => { let d=''; r.on('data', c => d+=c); r.on('end', () => res(d)); }).on('error', rej));
    srv.close();
    expect(body).toBe('ok');
  });
});

describe('T15: loopback in any spelling is allowed, everything else is refused', () => {
  const connectTo = (host: string) => { const s = new net.Socket(); try { s.connect({ port: 9, host }); } catch (e: any) { return String(e.message); } finally { s.on('error', () => undefined); s.destroy(); } return 'no-throw'; };
  it('127.0.0.0/8 and the IPv4-mapped form pass the guard; a public address and a lookalike do not', () => {
    (globalThis as any).__expectNetworkGuardHits = true;
    try {
      for (const ok of ['127.0.0.2', '127.255.255.254', '::ffff:127.0.0.1']) expect(connectTo(ok), ok).not.toMatch(/TEST_NETWORK_GUARD/);
      for (const bad of ['128.0.0.1', '1.1.1.1', '127.0.0.1.evil.example', 'localhost.evil.example']) expect(connectTo(bad), bad).toMatch(/TEST_NETWORK_GUARD/);
    } finally { (globalThis as any).__expectNetworkGuardHits = false; (globalThis as any).__networkGuardHits.length = 0; }
  });
});
