import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { Keypair } from '@solana/web3.js';

/**
 * Behaviour-test harness: boots the REAL server (`tsx server.ts`) as a child process on a scratch database and a throwaway
 * signer key, with its RPC pointed at a loopback JSON-RPC stub that records every method the app calls. Tests then drive the
 * real HTTP API and assert on responses, on what reached the RPC (a send is a `sendTransaction` call) and on the database.
 * The stub is a recorder, not a chain: where chain state matters use `npm run localnet:e2e`.
 */
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const LOCALNET_STUB_GENESIS = 'LocaLnetStubGenesis1111111111111111111111111';

export interface RpcStub {
  url: string;
  methods: string[];
  count(method: string): number;
  close(): Promise<void>;
}

export async function startRpcStub(genesisHash: string, opts: { lamports?: number } = {}): Promise<RpcStub> {
  const methods: string[] = [];
  const answer = (method: string): unknown => {
    switch (method) {
      case 'getGenesisHash': return genesisHash;
      case 'getHealth': return 'ok';
      case 'getVersion': return { 'solana-core': '2.0.0' };
      case 'getSlot': case 'getBlockHeight': return 1000;
      case 'getLatestBlockhash': return { context: { slot: 1000 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1100 } };
      case 'getBalance': return { context: { slot: 1000 }, value: opts.lamports ?? 5_000_000_000 };
      case 'getMultipleAccounts': return { context: { slot: 1000 }, value: [] };
      case 'getAccountInfo': return { context: { slot: 1000 }, value: null };
      case 'getTokenAccountsByOwner': return { context: { slot: 1000 }, value: [] };
      case 'getSignatureStatuses': return { context: { slot: 1000 }, value: [] };
      default: return null;
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let reply: unknown;
      try {
        const j = JSON.parse(body);
        const one = (m: any) => { methods.push(m.method); return { jsonrpc: '2.0', id: m.id, result: answer(m.method) }; };
        reply = Array.isArray(j) ? j.map(one) : one(j);
      } catch {
        reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    count: (m) => methods.filter((x) => x === m).length,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface AppHandle {
  base: string;
  token: string;
  dbPath: string;
  logs: () => string;
  call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: any }>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

export function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Throwaway signer key file; never the repo keypair, never a funded key. */
export function throwawayKeyFile(dir: string): string {
  const f = path.join(dir, 'throwaway.json');
  fs.writeFileSync(f, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return f;
}

const baseEnv = (dir: string, extra: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? dir,
  NODE_ENV: 'production',
  APEX_ENV_FILE: '', // never the real .env
  APEX_DB_PATH: path.join(dir, 'app.db'),
  SIGNER_KEYPAIR_PATH: throwawayKeyFile(dir),
  OPERATOR_PASSWORD: 'behaviour-test-password',
  SOLANA_WS_URL: 'ws://127.0.0.1:9',
  JITO_BLOCK_ENGINE_URL: 'http://127.0.0.1:9',
  APEX_DISABLE_EXTERNAL_FEEDS: 'true', // no price/pump feeds from a child process: it is outside the vitest network guard
  ...extra,
});

export async function startApp(dir: string, env: Record<string, string>): Promise<AppHandle> {
  const port = await freePort();
  const full = { ...baseEnv(dir, env), APP_PORT: String(port) };
  const child: ChildProcess = spawn(path.resolve('node_modules/.bin/tsx'), [path.resolve('server.ts')], { cwd: dir, env: full, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log.slice(-2000)}`);
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!up) { child.kill('SIGKILL'); throw new Error(`server did not come up:\n${log.slice(-2000)}`); }
  const login = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: full['OPERATOR_PASSWORD'] }) })).json();
  const token: string = login.token;
  return {
    base, token, dbPath: full['APEX_DB_PATH'], logs: () => log,
    async call(method, route, body) {
      const res = await fetch(base + route, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    stop: () => new Promise<void>((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }),
  };
}

/** Run the real coordinator in a separate process against `dbPath` and halt all trading, so the halt is journaled the way production does it. */
export function haltInSeparateProcess(dbPath: string, reason: string): void {
  const code = `process.env.APEX_ENV_FILE='';process.env.APEX_DB_PATH=${JSON.stringify(dbPath)};process.env.NODE_ENV='production';` +
    `import('./server/execution/coordinator').then(({ executionCoordinator }) => { executionCoordinator.haltAll(${JSON.stringify(reason)}); setTimeout(() => process.exit(0), 200); });`;
  execFileSync(path.resolve('node_modules/.bin/tsx'), ['-e', code], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SOLANA_RPC_URL: 'http://127.0.0.1:9', SOLANA_WS_URL: 'ws://127.0.0.1:9', JITO_BLOCK_ENGINE_URL: 'http://127.0.0.1:9', SIGNER_KEYPAIR_PATH: throwawayKeyFile(path.dirname(dbPath)) }, timeout: 60_000 });
}
