import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { secretPathGuard, viteDevServerOptions } from '../server/security/secretPaths';

/**
 * K2 #21: `npm run dev` serves the project root through Vite middleware and the /api auth gate does not cover static paths.
 * This boots the real Vite dev middleware on a temp project that holds the real secret file names, with and without the guard.
 */
const SECRET = 'TOPSECRET-VALUE';
let root: string;
const servers: Array<{ close: () => void }> = [];

async function boot(opts: { guard: boolean; hardenedVite: boolean }): Promise<string> {
  const app = express();
  const vite: ViteDevServer = await createViteServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'spa',
    server: opts.hardenedVite ? viteDevServerOptions() : { middlewareMode: true, hmr: false },
  });
  if (opts.guard) app.use(secretPathGuard(root));
  app.use(vite.middlewares);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push({ close: () => { srv.close(); void vite.close(); } });
  return `http://127.0.0.1:${(srv.address() as any).port}`;
}

const get = async (base: string, p: string) => {
  const r = await fetch(base + p);
  return { status: r.status, text: await r.text() };
};
const LEAKS = ['/env.txt', '/apex_workstation.db', '/apex_engine.wal', '/server.log', '/.apex_trading_keypair.json', '/.overnight/inbox/x.patch', '/.agents/t.md'];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'k2dev-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>ok</title><div id=root></div>');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.js'), 'export const a = 1;');
  for (const f of ['env.txt', 'apex_workstation.db', 'apex_engine.wal', 'server.log', '.apex_trading_keypair.json', '.env']) fs.writeFileSync(path.join(root, f), SECRET);
  for (const d of ['.overnight/inbox', '.agents']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, '.overnight/inbox/x.patch'), SECRET);
  fs.writeFileSync(path.join(root, '.agents/t.md'), SECRET);
});
afterAll(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(root, { recursive: true, force: true });
});

describe('K2 #21: dev server does not serve secret or state files', () => {
  it('baseline: plain Vite middleware at the project root DOES serve env.txt (the finding is real)', async () => {
    const base = await boot({ guard: false, hardenedVite: false });
    const r = await get(base, '/env.txt');
    expect(r.status).toBe(200);
    expect(r.text).toContain(SECRET);
  });

  it('Vite fs.deny alone (our options) blocks the secret files', async () => {
    const base = await boot({ guard: false, hardenedVite: true });
    for (const p of LEAKS) {
      const r = await get(base, p);
      expect(r.text, p).not.toContain(SECRET);
    }
  });

  it('the guard alone blocks them, including encoded, query and traversal tricks', async () => {
    const base = await boot({ guard: true, hardenedVite: false });
    const tricks = [...LEAKS, '/env.txt?raw', '/env.txt?import&raw', '/%65nv.txt', '/%2565nv.txt', '/src/../env.txt', '/./env.txt', `/@fs${root}/env.txt`, '/.env', '/..%2fenv.txt'];
    for (const p of tricks) {
      const r = await get(base, p);
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain(SECRET);
    }
  });

  it('with both in place the app itself still loads', async () => {
    const base = await boot({ guard: true, hardenedVite: true });
    expect((await get(base, '/')).status).toBe(200);
    const js = await get(base, '/src/app.js');
    expect(js.status).toBe(200);
    expect(js.text).toContain('export const a');
    for (const p of LEAKS) expect((await get(base, p)).text, p).not.toContain(SECRET);
  });
});
