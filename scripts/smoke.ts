/**
 * Runtime smoke test (D3). Boots dist/server.cjs on a random port with a sanitized env,
 * exercises the unauthenticated and authenticated entry points and the /ws/engine
 * handshake, then checks the process output. Never talks to mainnet or Jito.
 *
 *   npm run build && npm run smoke
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = process.cwd();
const BUNDLE = path.join(ROOT, 'dist', 'server.cjs');
const BOOT_TIMEOUT_MS = 40_000;
const FORBIDDEN_LOG = [/ERR_[A-Z_]+/, /unhandled(Rejection| rejection)/i, /mainnet/i, /jito\.wtf/i, /api\.mainnet-beta/i];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('server did not answer /api/health before the boot timeout');
}

function wsHandshake(port: number, token: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/engine`, { headers: { origin: `http://127.0.0.1:${port}` } });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`ws handshake timed out; saw: ${seen.join(',') || 'nothing'}`));
    }, 10_000);
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      seen.push(msg.type);
      if (msg.type === 'AUTH_REQUIRED') ws.send(JSON.stringify({ type: 'AUTH', token }));
      if (msg.type === 'AUTHENTICATED') {
        clearTimeout(timer);
        ws.close();
        resolve(seen);
      }
      if (msg.type === 'AUTH_ERROR') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('ws AUTH rejected with a valid token'));
      }
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on('close', (code) => {
      if (code === 4003) {
        clearTimeout(timer);
        reject(new Error('ws origin rejected (4003)'));
      }
    });
  });
}

async function main(): Promise<void> {
  if (!existsSync(BUNDLE)) throw new Error('dist/server.cjs missing: run `npm run build` first');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(12).toString('hex');

  // Sanitized env: nothing inherited except what node needs. No RPC, Jito, signer or API keys.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    APP_PORT: String(port),
    OPERATOR_PASSWORD: password,
  };

  const out: string[] = [];
  const child = spawn(process.execPath, [BUNDLE], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });

  const steps: string[] = [];
  const step = (name: string) => steps.push(`ok  ${name}`);
  let failure: Error | null = null;

  try {
    await waitForHealth(base, Date.now() + BOOT_TIMEOUT_MS);
    step('GET /api/health');

    const root = await fetch(`${base}/`);
    if (!root.ok || !(await root.text()).includes('<div id="root"')) throw new Error('GET / did not serve the SPA');
    step('GET / serves the SPA');

    const bad = await fetch(`${base}/api/auth/session`);
    if (bad.status !== 401) throw new Error(`GET /api/auth/session without a token returned ${bad.status}, expected 401`);
    step('GET /api/auth/session rejects no token');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const loginBody: any = await login.json();
    if (!login.ok || !loginBody.token) throw new Error(`POST /api/auth/login failed: ${login.status}`);
    step('POST /api/auth/login');

    const sess = await fetch(`${base}/api/auth/session`, { headers: { authorization: `Bearer ${loginBody.token}` } });
    if (!sess.ok) throw new Error(`GET /api/auth/session with token returned ${sess.status}`);
    step('GET /api/auth/session with token');

    const seen = await wsHandshake(port, loginBody.token);
    step(`/ws/engine handshake (${seen.join(' -> ')})`);

    await sleep(1500); // let background loops log anything unexpected
  } catch (e) {
    failure = e as Error;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]);
    if (exited === null) child.kill('SIGKILL');
  }

  const log = out.join('');
  const hits = FORBIDDEN_LOG.filter((re) => re.test(log)).map(String);
  console.log(steps.join('\n'));
  if (failure) {
    console.error(`SMOKE FAILED: ${failure.message}\n--- server output (tail) ---\n${log.split('\n').slice(-30).join('\n')}`);
    process.exit(1);
  }
  if (hits.length) {
    console.error(`SMOKE FAILED: forbidden pattern(s) in server output: ${hits.join(', ')}\n${log.split('\n').slice(-30).join('\n')}`);
    process.exit(1);
  }
  console.log('SMOKE OK');
}

main().catch((e) => {
  console.error(`SMOKE FAILED: ${e.message}`);
  process.exit(1);
});
