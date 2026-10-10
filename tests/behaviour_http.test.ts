import net from 'node:net';
import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { startApp, startRpcStub, scratchDir, haltInSeparateProcess, MAINNET_GENESIS, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

/**
 * Behaviour tests: the real server process, its real HTTP API, a recording RPC stub. Each asserts an outcome (status,
 * refusal text, what reached the RPC), not that some source line exists. Chain state itself is covered by `npm run localnet:e2e`.
 */
const trade = () => ({ mint: Keypair.generate().publicKey.toBase58(), symbol: 'BHV', name: 'Behaviour', amountSol: 0.01, currentPriceSol: 1e-7, liquidityUsd: 20000 });
const sends = (s: RpcStub) => s.count('sendTransaction') + s.count('simulateTransaction');
const dirs: string[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const dir = () => { const d = scratchDir('behaviour-'); dirs.push(d); return d; };

describe('mainnet guard over HTTP: a server pointed at a mainnet RPC can never arm or send', () => {
  let rpc: RpcStub; let app: AppHandle;
  beforeAll(async () => {
    rpc = await startRpcStub(MAINNET_GENESIS); // the RPC answers with the MAINNET genesis hash
    app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, ALLOW_LIVE_REAL_MONEY_TRADING: 'true' });
    handles.push(app);
  }, 90_000);
  afterAll(() => rpc.close());

  it('the RPC is reported unhealthy, can-arm says no, and arming with the right code is refused with 403', async () => {
    const can = await app.call('GET', '/api/execution/can-arm');
    expect(can.json.allowed).toBe(false);
    expect(can.json.reasons.join(' ')).toMatch(/RPC health is DISCONNECTED/);
    expect(app.logs()).toMatch(/CLUSTER_GUARD: genesis hash 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d does not match/);
    const arm = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
    expect(arm.status).toBe(403);
    expect(arm.json.success).toBe(false);
    expect((await app.call('GET', '/api/execution/mode')).json.isLiveArmed).toBe(false);
  });

  it('stays unarmable after a heartbeat and a Reconcile click (the check is sticky, not a boot-time snapshot)', async () => {
    const before = rpc.count('getGenesisHash');
    await new Promise((r) => setTimeout(r, 11_000)); // one 10 s feed heartbeat must pass; it used to flip the RPC back to HEALTHY
    expect(rpc.count('getGenesisHash')).toBeGreaterThan(before); // the heartbeat re-checked the genesis itself
    const rec = await app.call('POST', '/api/execution/reconcile');
    expect(rec.json.result.status).toBe('OFFLINE');
    const can = (await app.call('GET', '/api/execution/can-arm')).json;
    expect(can.allowed).toBe(false);
    expect(can.reasons.join(' ')).toMatch(/RPC health is DISCONNECTED/);
    const arm = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
    expect(arm.status).toBe(403);
  }, 60_000);

  it('nothing was sent to the mainnet-answering RPC', () => {
    expect(sends(rpc)).toBe(0);
  });
});

describe('kill switch input is strict (R6s)', () => {
  let rpc: RpcStub; let app: AppHandle;
  beforeAll(async () => {
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    handles.push(app);
  }, 90_000);
  afterAll(() => rpc.close());

  it('an empty POST or a junk value is 400 and changes nothing; the string "false" means false', async () => {
    const state = async () => (await app.call('POST', '/api/execution/kill-switch', { activate: 'false' })).json;
    expect((await state()).killSwitchActive).toBe(false);
    for (const body of [{}, { activate: 'maybe' }, { activate: 1 }, { activate: null }]) {
      const r = await app.call('POST', '/api/execution/kill-switch', body);
      expect(r.status).toBe(400);
    }
    expect((await state()).killSwitchActive).toBe(false);
    expect((await app.call('POST', '/api/execution/kill-switch', { activate: 'true' })).json.killSwitchActive).toBe(true);
    // a body-less or junk request must not reset a tripped switch either
    expect((await app.call('POST', '/api/execution/kill-switch', {})).status).toBe(400);
    expect((await app.call('POST', '/api/execution/kill-switch', { activate: false })).json.killSwitchActive).toBe(false);
  });
});

describe('PAPER never sends, and the kill switch refuses new trades', () => {
  let rpc: RpcStub; let app: AppHandle;
  beforeAll(async () => {
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    handles.push(app);
  }, 90_000);
  afterAll(() => rpc.close());

  it('starts in PAPER and disarmed', async () => {
    const m = (await app.call('GET', '/api/execution/mode')).json;
    expect(m.mode).toBe('PAPER');
    expect(m.isLiveArmed).toBe(false);
  });

  it('a PAPER trade with no market data is refused with a stated reason, in PAPER, and nothing reaches the RPC', async () => {
    const r = await app.call('POST', '/api/execution/trade', trade());
    // The stub RPC has no bonding curve for a random mint, so the paper gate fails closed (price impact unknown). That is the
    // outcome asserted: a stated refusal, not a 5xx, in PAPER, with nothing sent. A filled paper trade needs curve data (localnet:e2e).
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(r.json.executionMode).toBe('PAPER');
    expect(String(r.json.error)).toMatch(/PRICE_IMPACT_TOO_HIGH/);
    expect(sends(rpc)).toBe(0);
  });

  it('with the kill switch on, a trade is refused as KILL_SWITCH_ACTIVE and nothing is sent; resetting it lifts the refusal', async () => {
    const on = await app.call('POST', '/api/execution/kill-switch', { activate: true });
    expect(on.json.killSwitchActive).toBe(true);
    const refused = await app.call('POST', '/api/execution/trade', trade());
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toMatch(/KILL_SWITCH_ACTIVE/);
    expect(sends(rpc)).toBe(0);
    const off = await app.call('POST', '/api/execution/kill-switch', { activate: false });
    expect(off.json.killSwitchActive).toBe(false);
    const after = await app.call('POST', '/api/execution/trade', trade());
    expect(String(after.json.error ?? '')).not.toMatch(/KILL_SWITCH_ACTIVE/);
  });
});

describe('a halt journaled by one run is enforced by the next', () => {
  it('after a restart on the same database, trades and exits are refused as TRADING_HALTED until the halt is cleared', async () => {
    const d = dir();
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      haltInSeparateProcess(`${d}/app.db`, 'behaviour test halt');
      const app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
      handles.push(app);
      const status = await app.call('GET', '/api/auto/status');
      expect(String(status.json.status?.haltReason ?? status.json.haltReason)).toMatch(/behaviour test halt/);
      const refused = await app.call('POST', '/api/execution/trade', trade());
      expect(refused.status).toBe(400);
      expect(String(refused.json.error)).toMatch(/TRADING_HALTED/);
      expect(sends(rpc)).toBe(0);
      // R12: the restored halt is visible in readiness, not only in the trade refusal
      const can = (await app.call('GET', '/api/execution/can-arm')).json;
      expect(can.allowed).toBe(false);
      expect(can.reasons.join(' ')).toMatch(/All trading is halted: behaviour test halt/);

      await app.call('POST', '/api/auto/resume', { clearHalt: true });
      const after = await app.call('POST', '/api/execution/trade', trade());
      expect(String(after.json.error ?? '')).not.toMatch(/TRADING_HALTED/);
    } finally {
      await rpc.close();
    }
  }, 120_000);
});

describe('arming policy and readiness, through the real API', () => {
  const ENV = (rpc: RpcStub, extra: Record<string, string> = {}) => ({ SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, ...extra });
  const ARM = 'CONFIRM_LIVE_TRADING_RISK';

  it('REAL_MONEY_PROHIBITED: without ALLOW_LIVE_REAL_MONEY_TRADING=true arming is refused even with the right code', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const app = await startApp(dir(), ENV(rpc)); handles.push(app);
      const r = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: ARM });
      expect(r.status).toBe(403);
      expect(r.json.message).toMatch(/REAL_MONEY_PROHIBITED/);
      expect((await app.call('GET', '/api/execution/mode')).json).toMatchObject({ mode: 'PAPER', isLiveArmed: false });
    } finally { await rpc.close(); }
  }, 90_000);

  it('only the exact confirmation code arms; arm, kill switch and disarm move the mode as stated; nothing is sent', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const app = await startApp(dir(), ENV(rpc, { ALLOW_LIVE_REAL_MONEY_TRADING: 'true' })); handles.push(app);
      for (const code of ['', 'CONFIRM', 'CONFIRM_LIVE_TRADING', 'YES_ARM', '123456']) {
        const bad = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: code });
        expect(bad.status, `code "${code}"`).toBe(403);
      }
      expect((await app.call('GET', '/api/execution/mode')).json.isLiveArmed).toBe(false);

      const ok = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: ARM });
      expect(ok.status).toBe(200);
      expect((await app.call('GET', '/api/execution/mode')).json).toMatchObject({ mode: 'LIVE', isLiveArmed: true });

      // LIVE with no readable curve (the RPC has no accounts), and a caller-suggested price: refused, nothing is signed or sent.
      const live = await app.call('POST', '/api/execution/trade', trade());
      expect(live.json.success).toBe(false);
      expect(live.json.error).toMatch(/MARKET_DATA_UNAVAILABLE: Could not fetch real Pump\.fun bonding curve/); // the caller's own currentPriceSol is not used in LIVE
      expect(sends(rpc)).toBe(0);

      // the kill switch disarms LIVE and readiness then refuses a re-arm
      await app.call('POST', '/api/execution/kill-switch', { activate: true });
      expect((await app.call('GET', '/api/execution/mode')).json).toMatchObject({ mode: 'PAPER', isLiveArmed: false });
      const can = (await app.call('GET', '/api/execution/can-arm')).json;
      expect(can.allowed).toBe(false);
      expect(can.reasons.join(' ')).toMatch(/Emergency risk kill switch is active/);
      expect((await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: ARM })).status).toBe(403);

      await app.call('POST', '/api/execution/kill-switch', { activate: false });
      expect((await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: ARM })).status).toBe(200);
      expect((await app.call('POST', '/api/execution/arm', { arm: false })).status).toBe(200);
      expect((await app.call('GET', '/api/execution/mode')).json).toMatchObject({ mode: 'PAPER', isLiveArmed: false });
      expect(sends(rpc)).toBe(0);
    } finally { await rpc.close(); }
  }, 120_000);

  it('an empty wallet and an unreachable RPC each make can-arm refuse, with the reason named', async () => {
    const poor = await startRpcStub(LOCALNET_STUB_GENESIS, { lamports: 1_000_000 }); // 0.001 SOL, below the 0.015 reserve
    try {
      const app = await startApp(dir(), ENV(poor, { ALLOW_LIVE_REAL_MONEY_TRADING: 'true' })); handles.push(app);
      const can = (await app.call('GET', '/api/execution/can-arm')).json;
      expect(can.allowed).toBe(false);
      expect(can.reasons.join(' ')).toMatch(/Insufficient spendable wallet balance/);
      expect((await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: ARM })).status).toBe(403);
    } finally { await poor.close(); }

    const dead = await startRpcStub(LOCALNET_STUB_GENESIS);
    const url = dead.url;
    await dead.close(); // nothing listens any more
    const app2 = await startApp(dir(), { SOLANA_RPC_URL: url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, ALLOW_LIVE_REAL_MONEY_TRADING: 'true' });
    handles.push(app2);
    const can2 = (await app2.call('GET', '/api/execution/can-arm')).json;
    expect(can2.allowed).toBe(false);
    expect(can2.reasons.join(' ')).toMatch(/RPC health is DISCONNECTED/);
  }, 120_000);
});

describe('the real server enforces auth and input validation on every route that can trade', () => {
  let rpc: RpcStub; let app: AppHandle;
  beforeAll(async () => {
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    handles.push(app);
  }, 90_000);
  afterAll(() => rpc.close());

  const src = fs.readFileSync('server.ts', 'utf8');
  const TRADE_ROUTES = [...src.matchAll(/^app\.post\('(\/api\/(?:execution\/(?:trade|close|arm)|wallet\/(?:snipe|close-position|toggle-trading|panic-liquidate)|memecoins\/[a-z/-]*snipe[a-z-]*|pumpfun\/[a-z/-]*snipe[a-z-]*|auto\/(?:mode|kill|resume)|signals\/[a-z/:]*snipe[a-z-]*))'/gm)].map((m) => m[1].replace(/:[A-Za-z]+/g, 'x'));

  it('finds the trading routes it is about to hit', () => {
    expect(TRADE_ROUTES.length).toBeGreaterThanOrEqual(8);
  });

  it('every trading route answers 401 without a token, over the wire', async () => {
    for (const r of TRADE_ROUTES) {
      const res = await fetch(app.base + r, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, r).toBe(401);
    }
  });

  it('with a token, a body that tries to choose its own provenance or carries junk is refused (never a 2xx, never a send)', async () => {
    for (const r of TRADE_ROUTES) {
      if (/panic-liquidate|toggle-trading|execution\/arm|auto\/(kill|resume)/.test(r)) continue; // no client-chosen trade fields; with none given they can only disarm
      const res = await app.call('POST', r, { ...trade(), provenance: 'REAL_ONCHAIN', source: 'SIGNAL', signalTimestamp: Date.now() });
      expect(res.status, r).toBeGreaterThanOrEqual(400);
      expect(res.status, r).toBeLessThan(500);
    }
    expect(sends(rpc)).toBe(0);
  });
});

describe('boolean fields are read strictly: the string "false" is false', () => {
  it('POST /api/auto/kill with exitAll "false" does not exit anything; a non-boolean is a 400', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS }); handles.push(app);
      const r = await app.call('POST', '/api/auto/kill', { exitAll: 'false' });
      expect(r.status).toBe(200);
      expect(r.json.closed ?? 0).toBe(0);
      expect((await app.call('POST', '/api/auto/kill', { exitAll: 'maybe' })).status).toBe(400);
      // arm:"false" must not be read as arm:true (it would then reach the confirmation-code check instead of a plain disarm)
      const disarm = await app.call('POST', '/api/execution/arm', { arm: 'false' });
      expect(disarm.status).toBe(200);
    } finally { await rpc.close(); }
  }, 90_000);
});

describe('deny-by-default on the real server: no route is reachable without a token, in any spelling', () => {
  it('every non-public /api route answers 401 unauthenticated (case, slash and trailing-slash variants), and signer overwrite is refused', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      // a huge burst so the limiter never answers: a 429 would say nothing about the auth gate
      const app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, APEX_RATE_LIMIT_BURST: '100000' }); handles.push(app);
      const src = fs.readFileSync('server.ts', 'utf8') + fs.readFileSync('server/market/marketRoutes.ts', 'utf8');
      const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'(\/api\/[^']*)'/g)].map((m) => ({ method: m[1].toUpperCase(), path: m[2].replace(/:[A-Za-z]+/g, 'x') }));
      expect(routes.length).toBeGreaterThan(50);
      expect((await app.call('POST', '/api/signer/generate', { forceOverwrite: true })).status).toBe(403);
      expect((await fetch(`${app.base}/api/auth/session`)).status).toBe(401);
      const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/login']);
      // the route list must include the market routes registered outside server.ts, or the walk would not cover them
      expect(routes.some((r) => r.path === '/api/market/orderbook')).toBe(true);
      const leaks: string[] = [];
      for (const r of routes) {
        if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
        for (const v of [r.path, '/API' + r.path.slice(4), r.path.toUpperCase(), '//' + r.path.slice(1), r.path + '/']) {
          const res = await fetch(app.base + v, { method: r.method, headers: { 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' });
          if (res.status !== 401) leaks.push(`${r.method} ${v} -> ${res.status}`);
        }
      }
      expect(leaks).toEqual([]); // exactly 401 for every spelling; the limiter is out of the way
    } finally { await rpc.close(); }
  }, 180_000);
});

describe('R1/R2/R3s: the server survives hostile requests and the gate cannot be walked around', () => {
  it('an absolute-form request target is still gated; a repeated query parameter is a 400, not a crash; the bot token is never on the wire', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS }); handles.push(app);
      const port = new URL(app.base).port;

      // raw request line `GET http://x/api/wallet/state` through Node's real HTTP parser (fetch cannot send this form)
      const raw = (target: string, extraHeaders = '') => new Promise<number>((resolve, reject) => {
        const s = net.connect(Number(port), '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${extraHeaders}Connection: close\r\n\r\n`));
        let buf = '';
        s.on('data', (d) => (buf += d));
        s.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)));
        s.on('error', reject);
      });
      for (const t of ['http://x/api/wallet/state', 'http://x/API/wallet/state', 'HTTP://x//api/wallet/state', 'http://x/api/workstation/positions?x=1']) {
        expect(await raw(t), t).toBe(401);
      }
      expect(await raw('http://x/api/wallet/state', `Authorization: Bearer ${app.token}\r\n`)).toBe(200);

      // the crash: ?symbol=a&symbol=b used to call .replace on an array inside an async handler and kill the process
      for (const q of ['symbol=a&symbol=b', 'symbol[x]=1', 'symbol[]=1']) {
        const r = await app.call('GET', `/api/market/ticker?${q}`);
        expect(r.status, q).toBe(400);
      }
      expect((await app.call('GET', '/api/health')).status).toBe(200); // still alive

      // the Telegram bot token is not in the config or the WebSocket snapshot
      await app.call('POST', '/api/memecoins/config', { telegramBotToken: 'SECRET-TOKEN-123456:ABC', telegramChatId: '1' });
      const cfg = await app.call('GET', '/api/memecoins/config');
      expect(JSON.stringify(cfg.json)).not.toContain('SECRET-TOKEN');
      const frames: string[] = [];
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/engine`);
        ws.onmessage = (m) => { frames.push(String(m.data)); };
        ws.onopen = () => ws.send(JSON.stringify({ action: 'AUTHENTICATE', token: app.token }));
        setTimeout(() => { ws.close(); resolve(); }, 2500);
      });
      expect(frames.join('\n')).toContain('MEMECOIN_SNAPSHOT');
      expect(frames.join('\n')).not.toContain('SECRET-TOKEN');
    } finally { await rpc.close(); }
  }, 120_000);
});

describe('R4s/R5s/R10s over the real server', () => {
  it('Save Config with an empty token keeps the stored one; a HEAD health probe needs no token; an unknown /api path is a JSON 404, not index.html', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const app = await startApp(dir(), { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS }); handles.push(app);

      // R4s: the UI cannot see the stored token, so Save Config posts ''. That must not wipe it.
      await app.call('POST', '/api/telegram/config', { botToken: '123456:ABC-token-for-test', chatId: '1' });
      expect((await app.call('GET', '/api/telegram/config')).json.config.botTokenSet).toBe(true);
      const save = await app.call('POST', '/api/telegram/config', { botToken: '', chatId: '2' });
      expect(save.json.config.botTokenSet).toBe(true);
      expect(save.json.config.chatId).toBe('2'); // the other field did change
      expect(JSON.stringify(save.json)).not.toContain('ABC-token');

      // R5s: the container healthcheck / curl -I send HEAD
      const head = await fetch(`${app.base}/api/health`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      const headOther = await fetch(`${app.base}/api/wallet/state`, { method: 'HEAD' });
      expect(headOther.status).toBe(401); // only /api/health is public for HEAD

      // R10s: with a token, a path that is no route answers 404 JSON; without one it is still 401
      const unknown = await fetch(`${app.base}/api/this-route-does-not-exist`, { headers: { Authorization: `Bearer ${app.token}` } });
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('content-type') ?? '').toMatch(/json/);
      expect((await unknown.json()).success).toBe(false);
      expect((await fetch(`${app.base}/api/this-route-does-not-exist`)).status).toBe(401);
    } finally { await rpc.close(); }
  });
});
