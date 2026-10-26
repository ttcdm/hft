import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'node:net';
import type { Request, Response } from 'express';
import { rateLimiter, LOGIN_RATE_LIMIT, WalletConfigSchema } from '../server/middleware/enterprise';
import { authManager } from '../server/middleware/auth';
import { walletTrader } from '../server/walletTrader';
import { executionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { riskEngine } from '../server/risk/riskEngine';
import { workstationDb } from '../server/db/database';

/**
 * Stage 3 task 3G (P3.6: N-67, N-8, N-19, N-5, N-10, N-4). API inputs cannot silently change limits, and auth follows the token.
 * The real server.ts runs in process; the only doubles are pass-through spies (nothing is mocked) and the balance sync, which is
 * stubbed so a config save does not start the RPC balance read.
 */

let base = '';
let token = '';
let httpServer: import('node:http').Server;

beforeAll(async () => {
  const mod = await import('../server');
  httpServer = mod.server;
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
  token = authManager.createSession('OPERATOR').token;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

const call = async (method: 'GET' | 'POST', route: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000), // a hang guard, not a timing assertion
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const positionCap = async () => (await call('GET', '/api/diagnostics/system')).json.riskControls.maxPositionSol as number;

describe('3G N-67: a wallet config save changes only the limits it sends', () => {
  const capBefore = riskEngine.getLimits().maxPositionSol;
  const cfgBefore = walletTrader.getConfig();
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    riskEngine.updateLimits({ maxPositionSol: capBefore });
    // put the stored config back as it was (each field is sent, so each is applied)
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    await walletTrader.updateConfig({
      jitoBlockEngineUrl: cfgBefore.jitoBlockEngineUrl,
      slippageToleranceBps: cfgBefore.slippageToleranceBps,
      capitalTier: cfgBefore.capitalTier,
      riskLimits: { ...cfgBefore.riskLimits },
    });
    vi.restoreAllMocks();
  });

  it('a cap of 0.005 SOL stays 0.005 after a save with empty riskLimits, and after one without riskLimits', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    expect((await call('POST', '/api/wallet/config', { riskLimits: { maxPositionSizeSol: 0.005 } })).status).toBe(200);
    expect(await positionCap()).toBe(0.005);
    const slippage = walletTrader.getConfig().slippageToleranceBps;
    expect((await call('POST', '/api/wallet/config', { riskLimits: {} })).status).toBe(200);
    expect(await positionCap()).toBe(0.005); // on B0 the schema default put it back to 0.02
    expect((await call('POST', '/api/wallet/config', {})).status).toBe(200); // riskLimits was required on B0
    expect(await positionCap()).toBe(0.005);
    expect(walletTrader.getConfig().riskLimits.maxPositionSizeSol).toBe(0.005);
    expect(walletTrader.getConfig().slippageToleranceBps).toBe(slippage); // and no default slippage (600 bps) was written over it
  });

  it('a save that leaves the cap out does not push a limit to the risk engine', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const push = vi.spyOn(riskEngine, 'updateLimits');
    expect((await call('POST', '/api/wallet/config', { riskLimits: { stopLossPct: 25 } })).status).toBe(200);
    expect(push).not.toHaveBeenCalled();
  });

  it('the schema sets no field the request left out', () => {
    expect(WalletConfigSchema.parse({})).toEqual({});
    expect(WalletConfigSchema.parse({ riskLimits: {} })).toEqual({ riskLimits: {} });
  });

  it('maxDailyLossUsd is refused with a 400 and nothing in the request is applied', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const stored = walletTrader.getConfig().riskLimits.maxDailyLossUsd;
    const r = await call('POST', '/api/wallet/config', { slippageToleranceBps: 1234, riskLimits: { maxDailyLossUsd: 50, maxPositionSizeSol: 0.005 } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/MAX_DAILY_LOSS_USD/);
    expect(walletTrader.getConfig().riskLimits.maxDailyLossUsd).toBe(stored);
    expect(walletTrader.getConfig().slippageToleranceBps).not.toBe(1234);
    expect(await positionCap()).toBe(capBefore);
  });
});

describe('3G N-8, N-19: Jito can be turned off, and a refused Jito URL changes nothing', () => {
  const jitoBefore = executionConfig.getConfig().jitoBlockEngineUrl;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    executionCoordinator.setJitoBlockEngineUrl(jitoBefore);
  });

  it("jitoBlockEngineUrl '' calls setJitoBlockEngineUrl('') and the stored URL becomes ''", async () => {
    expect(jitoBefore).not.toBe(''); // the test env configures a loopback block engine, so there is something to turn off
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const setJito = vi.spyOn(executionCoordinator, 'setJitoBlockEngineUrl');
    expect((await call('POST', '/api/wallet/config', { jitoBlockEngineUrl: '' })).status).toBe(200);
    expect(setJito).toHaveBeenCalledWith('');
    expect(walletTrader.getConfig().jitoBlockEngineUrl).toBe('');
    expect(executionCoordinator.getJitoReadiness().enabled).toBe(false);
  });

  it('a save without jitoBlockEngineUrl leaves Jito alone', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const setJito = vi.spyOn(executionCoordinator, 'setJitoBlockEngineUrl');
    expect((await call('POST', '/api/wallet/config', { slippageToleranceBps: 700 })).status).toBe(200);
    expect(setJito).not.toHaveBeenCalled();
  });

  it('a refused (mainnet) Jito URL leaves the RPC endpoint and the stored Jito URL unchanged', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const setRpc = vi.spyOn(executionCoordinator, 'setRpcEndpoint');
    const before = walletTrader.getConfig();
    await expect(
      walletTrader.updateConfig({ rpcEndpoint: 'http://127.0.0.1:18999', jitoBlockEngineUrl: 'https://mainnet.block-engine.jito.wtf' })
    ).rejects.toThrow(/refusing to configure a mainnet Jito block engine URL/);
    expect(setRpc).not.toHaveBeenCalled(); // B0 switched the RPC first, then stored the URL, then the transport refused it
    expect(walletTrader.getConfig().rpcEndpoint).toBe(before.rpcEndpoint);
    expect(walletTrader.getConfig().jitoBlockEngineUrl).toBe(before.jitoBlockEngineUrl);
  });

  it('on localnet a Jito URL is refused with a localnet message, not the mainnet one', async () => {
    vi.stubEnv('ALLOWED_CLUSTER', 'localnet');
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const r = await call('POST', '/api/wallet/config', { jitoBlockEngineUrl: 'https://ny.block-engine.example.org' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/not used on localnet/);
    expect(r.json.error).not.toMatch(/mainnet/);
  });

  it('the Jito URL is returned as its origin only, by the save and by the wallet state', async () => {
    vi.spyOn(walletTrader, 'syncRpcBalance').mockResolvedValue(null);
    const keyed = 'https://block-engine.example.org/api/v1/bundles?uuid=SECRET-JITO-KEY';
    const saved = await call('POST', '/api/wallet/config', { jitoBlockEngineUrl: keyed });
    expect(saved.status).toBe(200);
    const state = await call('GET', '/api/wallet/state');
    for (const cfg of [saved.json.config, state.json.config]) expect(cfg.jitoBlockEngineUrl).toBe('https://block-engine.example.org');
    expect(JSON.stringify([saved.json, state.json])).not.toContain('SECRET-JITO-KEY');
  });
});

describe('3G N-5: the rate limiter keys on the peer address, login is limited harder, idle buckets go', () => {
  const fakeReq = (remoteAddress: string, apiKey?: string) =>
    ({ socket: { remoteAddress }, headers: apiKey ? { 'x-api-key': apiKey } : {}, ip: remoteAddress }) as unknown as Request;
  const fakeRes = () => {
    const r: any = { statusCode: 200, headers: {} as Record<string, string> };
    r.setHeader = (k: string, v: string) => { r.headers[k] = v; return r; };
    r.status = (c: number) => { r.statusCode = c; return r; };
    r.json = () => r;
    return r as Response & { statusCode: number };
  };
  afterEach(() => vi.useRealTimers());

  it('200 requests from one address with 200 different x-api-key values get 429s after the burst', () => {
    const limiter = rateLimiter({ maxTokens: 120, refillRatePerSec: 30 });
    vi.useFakeTimers(); // no refill between the requests: the clock does not move
    let passed = 0;
    let limited = 0;
    for (let i = 0; i < 200; i++) {
      const res = fakeRes();
      limiter(fakeReq('10.0.0.7', `key-${i}`), res, () => { passed++; });
      if (res.statusCode === 429) limited++;
    }
    expect(passed).toBe(120);
    expect(limited).toBe(80);
  });

  it('a bucket idle for a full refill period is dropped', () => {
    vi.useFakeTimers();
    const limiter = rateLimiter({ maxTokens: 10, refillRatePerSec: 1 });
    for (let i = 0; i < 50; i++) limiter(fakeReq(`10.0.1.${i}`), fakeRes(), () => {});
    expect(limiter.bucketCount()).toBe(50);
    vi.advanceTimersByTime(10_000); // 10 tokens at 1/s: every bucket is full again
    limiter(fakeReq('10.0.2.1'), fakeRes(), () => {});
    expect(limiter.bucketCount()).toBe(1);
  });

  it('POST /api/auth/login: the sixth wrong password in a row from one address gets a 429, whatever x-api-key says', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= LOGIN_RATE_LIMIT.maxTokens; i++) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': `guess-${i}` },
        body: JSON.stringify({ password: `wrong-${i}` }),
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, LOGIN_RATE_LIMIT.maxTokens).every((s) => s === 401)).toBe(true);
    expect(statuses[LOGIN_RATE_LIMIT.maxTokens]).toBe(429);
  });
});

describe('3G N-10: /api/workstation/events clamps limit to 1..200', () => {
  it('limit=-1 and limit=abc return at most 50 events', async () => {
    for (let i = 0; i < 60; i++) workstationDb.logJournal('S3G_TEST_EVENT', `s3g-${i}`, 'PAPER', { i });
    for (const q of ['-1', 'abc', '0']) {
      const r = await call('GET', `/api/workstation/events?limit=${q}`);
      expect(r.status, q).toBe(200);
      expect(r.json.count, q).toBe(50);
    }
    expect((await call('GET', '/api/workstation/events?limit=3')).json.count).toBe(3);
  });
});

