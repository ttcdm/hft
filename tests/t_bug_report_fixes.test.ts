import { describe, it, expect, afterEach, vi } from 'vitest';
import { ExecutionCoordinator, SELL_SLIPPAGE_LADDER_BPS } from '../server/execution/coordinator';
import { executionConfig, parseSellSlippageCap } from '../server/solana/executionConfig';
import { AuthManager, authManager, apiAuthGate, requireOperatorAuth, verifyWsAuth } from '../server/middleware/auth';
import { errorHandler, isSafeExternalUrl, publicHealthBody, WalletConfigSchema } from '../server/middleware/enterprise';
import { socialScanner } from '../server/socialScanner';

/**
 * T (outside bug report, triaged 2026-10-26): T1 arming after a restart that had the kill switch on, T2 the sell-ladder cap, T3 the
 * OPERATOR role, T4 public health and error bodies, T5 URL checks, Telegram help text. T6 (back-off after a rate-limited exit) is pinned in
 * s245_rate_limited_send.test.ts (c). Throwaway coordinators and sessions only; no RPC, nothing signed or sent.
 */
const made: ExecutionCoordinator[] = [];
const make = () => { const c = new ExecutionCoordinator(false); made.push(c); return c; };
const capDefault = executionConfig.getConfig().maxSellSlippageBps;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  executionConfig.updateConfig({ maxSellSlippageBps: capDefault });
  while (made.length) made.pop()!.cleanup();
});

describe('T1: LIVE does not arm while KILL_SWITCH_WAS_ON is raised', () => {
  const blocks = (r: string) => /kill switch was on before the restart/i.test(r);

  it('readiness lists it, arming refuses with it, and clearing the alert removes the reason', () => {
    vi.stubEnv('ALLOW_LIVE_REAL_MONEY_TRADING', 'true');
    const c = make();
    expect(c.getLiveReadiness().reasons.some(blocks)).toBe(false);
    (c as any).raiseOperatorAlert('KILL_SWITCH_WAS_ON', 'The kill switch was on before the restart (t1) and is off now.');
    expect(c.getLiveReadiness().reasons.some(blocks)).toBe(true);
    const armed = c.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
    expect(armed.success).toBe(false);
    expect((armed.reasons ?? []).some(blocks)).toBe(true);
    expect(c.isLiveArmed()).toBe(false);
    c.clearHalt(); // POST /api/auto/resume {clearHalt:true}
    expect(c.getLiveReadiness().reasons.some(blocks)).toBe(false);
  });
});

describe('T2: MAX_SELL_SLIPPAGE_BPS caps the sell retry ladder', () => {
  it('unset keeps 4000; a whole number from 100 to 4000 is taken; anything else stops startup', () => {
    expect(parseSellSlippageCap(undefined)).toBe(4000);
    expect(parseSellSlippageCap(' ')).toBe(4000);
    expect(parseSellSlippageCap('2500')).toBe(2500);
    for (const bad of ['abc', '0', '99', '4001', '25.5', 'NaN', '-800']) expect(() => parseSellSlippageCap(bad)).toThrow(/MAX_SELL_SLIPPAGE_BPS/);
  });

  it('no step goes above the cap; the default cap leaves the ladder as it was', () => {
    const c = make();
    const at = (count: number) => { (c as any).exitFailures.set('t2', { count, nextAttemptAt: 0, lastError: 'x' }); return c.exitSlippageBps('t2'); };
    expect([0, 1, 2, 3, 9].map(at)).toEqual([...SELL_SLIPPAGE_LADDER_BPS, SELL_SLIPPAGE_LADDER_BPS.at(-1)]);
    executionConfig.updateConfig({ maxSellSlippageBps: 1500 });
    expect([0, 1, 2, 3, 9].map(at)).toEqual([800, 1500, 1500, 1500, 1500]);
  });
});

describe('T3: a READONLY session can read but never act', () => {
  const res = () => { const r: any = { statusCode: 200 }; r.status = vi.fn((s: number) => { r.statusCode = s; return r; }); r.json = vi.fn(() => r); return r; };
  const req = (method: string, url: string, token: string) => ({ method, originalUrl: url, url, headers: { authorization: `Bearer ${token}` }, ip: '127.0.0.1' }) as any;

  it('apiAuthGate lets a READONLY token GET and refuses its POST; an OPERATOR token passes both', () => {
    const ro = authManager.createSession('READONLY').token;
    const op = authManager.createSession('OPERATOR').token;
    const run = (mw: any, method: string, token: string) => { const next = vi.fn(); const r = res(); mw(req(method, '/api/wallet/state', token), r, next); return next.mock.calls.length === 1 ? 'next' : r.statusCode; };
    expect(run(apiAuthGate, 'GET', ro)).toBe('next');
    expect(run(apiAuthGate, 'POST', ro)).toBe(401);
    expect(run(requireOperatorAuth, 'POST', ro)).toBe(401);
    expect(run(apiAuthGate, 'POST', op)).toBe('next');
    expect(run(requireOperatorAuth, 'POST', op)).toBe('next');
  });

  it('the trading WebSocket is operator-only; isOperatorToken follows the role and expiry', () => {
    expect(verifyWsAuth(authManager.createSession('READONLY').token)).toBe(false);
    expect(verifyWsAuth(authManager.createSession('OPERATOR').token)).toBe(true);
    const a = new AuthManager();
    expect(a.isOperatorToken(a.createSession('OPERATOR').token)).toBe(true);
    expect(a.isOperatorToken(a.createSession('READONLY').token)).toBe(false);
    expect(a.isOperatorToken('nope')).toBe(false);
  });
});

describe('T4: public health and error bodies say less', () => {
  const run = (err: any) => { const r: any = {}; r.status = vi.fn(() => r); r.json = vi.fn(() => r); errorHandler(err, { originalUrl: '/api/x', method: 'POST' } as any, r, vi.fn()); return r.json.mock.calls[0][0].error; };

  it('in production an unclassified 500 returns a generic message with the correlationId, and no details', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const e: any = new Error('SQLITE_CANTOPEN: /Users/someone/secret/path/workstation.db');
    e.details = { file: '/Users/someone/secret' };
    const body = run(e);
    expect(body.message).not.toMatch(/SQLITE|Users/);
    expect(body.message).toContain(body.correlationId);
    expect(body.details).toBeUndefined();
  });

  it('a classified error, a 4xx, or any error outside production keeps its message', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(run(Object.assign(new Error('INSUFFICIENT_BALANCE: x'), { code: 'INSUFFICIENT_BALANCE', statusCode: 500 })).message).toMatch(/INSUFFICIENT_BALANCE/);
    expect(run(Object.assign(new Error('bad input'), { statusCode: 400 })).message).toBe('bad input');
    vi.stubEnv('NODE_ENV', 'development');
    expect(run(new Error('SQLITE_CANTOPEN: x')).message).toMatch(/SQLITE_CANTOPEN/);
  });

  it('GET /api/health (no token) answers with its status only: no pid, versions, uptime or memory', () => {
    expect(publicHealthBody()).toEqual({ status: 'ONLINE' });
  });
});

describe('T5: URL checks', () => {
  it('metadata addresses written as IPv6 are refused; loopback and private IPv4 stay allowed for localnet', () => {
    for (const u of ['http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[fd00:ec2::254]/', 'http://[fd00::]/', 'http://[fe80::1]/'])
      expect(isSafeExternalUrl(u), u).toBe(false);
    for (const u of ['http://127.0.0.1:8899', 'http://[::1]:8899', 'http://192.168.1.10:8899', 'https://api.devnet.solana.com'])
      expect(isSafeExternalUrl(u), u).toBe(true);
  });

  it('rpcEndpoint takes http(s) only; ws(s) is refused with the HTTP/HTTPS message', () => {
    const r = WalletConfigSchema.safeParse({ rpcEndpoint: 'wss://api.devnet.solana.com' });
    expect(r.success).toBe(false);
    expect(JSON.stringify((r as any).error.issues)).toMatch(/HTTP or HTTPS/);
    expect(WalletConfigSchema.safeParse({ rpcEndpoint: 'https://api.devnet.solana.com' }).success).toBe(true);
  });
});

describe('Telegram help text', () => {
  it('/help no longer offers /panic_sell as if Telegram could deliver it', async () => {
    const { reply } = await socialScanner.processTelegramCommand('/help');
    expect(reply).toMatch(/\/panic_sell/);
    expect(reply).toMatch(/Telegram does not deliver it/);
  });
});
