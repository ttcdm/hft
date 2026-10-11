import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFile } from 'child_process';
import express from 'express';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { secretPathGuard, viteDevServerOptions, viteFsDeny, isServableInDev } from '../server/security/secretPaths';

/**
 * Dev-mode blank page: the browser asks for /@vite/client with Sec-Fetch-Dest: script. `**\/dist/**` in server.fs.deny matched
 * node_modules/vite/dist/client, so Vite answered 404 and React never mounted. Without that header Vite falls back to index.html (200),
 * which is why a plain fetch passed while the page stayed blank. These tests send the header a browser sends.
 */
let root: string;
let base: string;
let vite: ViteDevServer;
let srv: http.Server;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'k2b-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>t</title><div id="root">EMPTY</div><script type="module" src="/src/main.js"></script>');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/main.js'), "document.getElementById('root').textContent = 'MOUNTED';");
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/server.cjs'), 'SECRET-BUILD-OUTPUT');
  const app = express();
  vite = await createViteServer({ root, configFile: false, logLevel: 'silent', appType: 'spa', server: viteDevServerOptions(root) });
  app.use(secretPathGuard(root));
  app.use(vite.middlewares);
  srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => { srv.close(); await vite.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('the hardened dev server still serves Vite\'s own client', () => {
  it('/@vite/client with Sec-Fetch-Dest: script is JavaScript, not a 404', async () => {
    const r = await fetch(`${base}/@vite/client`, { headers: { 'Sec-Fetch-Dest': 'script', Accept: '*/*' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toMatch(/javascript/);
    expect(await r.text()).toContain('createHotContext');
  });

  it('the app entry module is served as JavaScript too', async () => {
    const r = await fetch(`${base}/src/main.js`, { headers: { 'Sec-Fetch-Dest': 'script' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toMatch(/javascript/);
  });

  it('the project\'s own dist/ is still denied', async () => {
    for (const dest of ['script', 'empty', 'document']) {
      const r = await fetch(`${base}/dist/server.cjs`, { headers: { 'Sec-Fetch-Dest': dest } });
      expect(await r.text(), dest).not.toContain('SECRET-BUILD-OUTPUT');
    }
  });

  it('the deny globs name the project dist only, and the path guard lets a package\'s dist through', () => {
    const deny = viteFsDeny(root);
    expect(deny).not.toContain('**/dist/**');
    expect(deny.some((g) => g.endsWith('/dist/**') && g.includes(path.basename(root)))).toBe(true);
    expect(isServableInDev('node_modules/vite/dist/client/client.mjs')).toBe(true);
    expect(isServableInDev('dist/server.cjs')).toBe(false);
    expect(isServableInDev('node_modules/x/.env')).toBe(false);
    expect(isServableInDev('.git/config')).toBe(false);
  });

  // headless_shell ships with the Playwright browsers; absent elsewhere, in which case the header tests above are the proof.
  const chrome = ['/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  it.skipIf(!chrome)('a real browser mounts the page (the root element is filled in)', async () => {
    // async on purpose: the dev server runs in this process, and a blocking spawn would starve it
    const out = await new Promise<string>((resolve) => {
      execFile(chrome as string, ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--virtual-time-budget=5000', '--dump-dom', base + '/'], { timeout: 60_000 }, (_e, stdout) => resolve(String(stdout)));
    });
    expect(out).toContain('MOUNTED');
    expect(out).not.toContain('>EMPTY<');
  }, 90_000);
});
