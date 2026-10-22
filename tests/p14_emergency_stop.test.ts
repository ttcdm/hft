import fs from 'node:fs';
import net from 'node:net';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, afterEach, afterAll, beforeAll, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import WebSocket from 'ws';
import { autoSnipeController, DEVNET_CONFIRMATION_CODE } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { socialScanner } from '../server/socialScanner';
import { workstationDb } from '../server/db/database';
import { riskEngine } from '../server/risk/riskEngine';
import { solPriceService } from '../server/market/solPriceService';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { authManager } from '../server/middleware/auth';
import { emergencyStop } from '../server/execution/emergencyStop';
import { SniperAutoHeader } from '../src/components/MemecoinSocialSniperModal';
import { setAutoMode, resetAuto, newPumpPool } from './fixtures/auto';
import { watchWindow } from '../server/signals/watchWindow';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

/**
 * P1.4 (N-0, N-11, N-12, N-1, N-2, R1-119, R1-29, N-3, N-6): one emergency stop for the kill switch, the HTTP and WebSocket panics and
 * Telegram /panic_sell. Real ExecutionCoordinator, AutoSnipeController, walletTrader and server.ts routes (imported in process, so the
 * spies below reach them); doubles only where a trade would leave the process (the curve read, the coordinator's mode getters to stand
 * in for an armed LIVE session) and to hold a call on a gate. The kill-switch / re-arm test runs the real server as a child on a stub RPC.
 */

const freshMint = () => Keypair.generate().publicKey.toBase58();
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const row = (id: string) => workstationDb.loadPositions().find((p) => p.id === id);

async function paperBuy(): Promise<string> {
  const r = await executionCoordinator.executeTrade({
    mint: freshMint(), symbol: 'P14', name: 'P14', amountSol: 0.005, jitoTipSol: 0.0001, source: 'MANUAL',
    provenance: 'MANUAL_OPERATOR', currentPriceSol: 0.0001, signalTimestamp: Date.now(),
  });
  expect(r.success, r.error).toBe(true);
  return r.positionId!;
}

function seedLive(): string {
  const id = `p14-live-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  workstationDb.savePosition({
    id, mint: freshMint(), symbol: 'LIV', name: 'P14 live', tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: 1e-7,
    currentPriceSol: 1e-7, currentValueSol: 0.0001, costBasisLamports: 100_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE',
    executionMode: 'LIVE', entryTxSignature: `P14Seeded${id}`, entryTimestamp: now, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  } as any);
  return id;
}

/** Close every ACTIVE row left by a test, so the next one starts flat (panic sells every mode). */
async function flatten() {
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) {
    if (p.executionMode === 'PAPER') await executionCoordinator.closePosition(p.id, 100, 'MANUAL');
    else workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
  }
}

// ---- the real server.ts, in process -----------------------------------------------------------------------------------------
let base = '';
let token = '';
let httpServer: import('node:http').Server;

beforeAll(async () => {
  const mod = await import('../server');
  httpServer = mod.server;
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(httpServer.address() as net.AddressInfo).port}`;
  token = authManager.createSession('OPERATOR').token;
  // server.ts sets the watch window's score function to the live confluence score; the fixture's HOT releases need a score
  watchWindow.setScoreFn(() => 80);
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

const call = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
  const res = await fetch(base + route, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000), // a hang guard (N-6: a throwing route used to never answer), not a timing assertion
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** An authenticated WebSocket client; resolves the first frame of `type` after `send`. */
async function wsClient() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/engine`);
  const frames: any[] = [];
  const waiters: Array<{ type: string; resolve: (f: any) => void }> = [];
  ws.on('message', (m) => {
    const f = JSON.parse(m.toString());
    frames.push(f);
    for (const w of waiters.splice(0)) { if (f.type === w.type) w.resolve(f); else waiters.push(w); }
  });
  await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j); });
  const next = (type: string) => new Promise<any>((resolve) => {
    const seen = frames.find((f) => f.type === type);
    if (seen) { frames.splice(frames.indexOf(seen), 1); resolve(seen); } else waiters.push({ type, resolve });
  });
  ws.send(JSON.stringify({ action: 'AUTHENTICATE', sessionToken: token }));
  await next('AUTHENTICATED');
  return { ws, next, send: (o: any) => ws.send(JSON.stringify({ ...o, sessionToken: token })), close: () => ws.close() };
}

beforeEach(() => {
  solPriceService.setPrice(150, 'TEST_FIXTURE');
  memecoinAggregator.setConfluenceGating(false);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetAuto();
  vi.unstubAllEnvs();
  executionCoordinator.clearHalt();
  riskEngine.setKillSwitch(false);
  executionCoordinator.armLiveTrading(false);
  await flatten();
});

describe('P1.4 N-0: a DEVNET_LIVE session that sees LIVE disarmed or the kill switch on turns itself OFF for good', () => {
  /** The coordinator stands in for an armed LIVE session; `armed` is what its two mode getters report. */
  async function devnetLiveSession() {
    const state = { armed: true };
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockImplementation(() => (state.armed ? 'LIVE' : 'PAPER'));
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockImplementation(() => state.armed);
    vi.spyOn(executionCoordinator, 'getRealWalletBalanceSol').mockReturnValue(1);
    const ok = await autoSnipeController.setMode('DEVNET_LIVE', { confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(ok.ok, ok.error).toBe(true);
    return state;
  }

  it('disarm, then arm again: the next candidate is refused and auto is OFF; after re-arming a candidate is dropped, never BOUGHT', async () => {
    const state = await devnetLiveSession();
    const snipe = vi.spyOn(memecoinAggregator, 'executeSnipe');
    state.armed = false; // someone disarmed LIVE (any route)
    // a HOT release reaches the controller through the real watch-window listener, and the explicit candidate after it
    const d1 = await autoSnipeController.submitCandidate({ mint: newPumpPool('HOT').mint, source: 'TEST', provenance: 'REAL_ONCHAIN' });
    expect(d1.outcome).not.toBe('BOUGHT');
    expect(autoSnipeController.getMode()).toBe('OFF');
    expect(autoSnipeController.getStatus().downgradeReason).toMatch(/DEVNET_LIVE turned OFF: the coordinator is PAPER and LIVE is not armed/);
    expect(workstationDb.loadDecisions({ stage: 'mode', limit: 20 }).some((d) => /DEVNET_LIVE turned OFF/.test(d.reason))).toBe(true);
    state.armed = true; // LIVE armed again, without CONFIRM_AUTO_DEVNET
    const d2 = await autoSnipeController.submitCandidate({ mint: newPumpPool('HOT').mint, source: 'TEST', provenance: 'REAL_ONCHAIN' });
    expect(d2.outcome).not.toBe('BOUGHT');
    expect(d2.reason).toBe('AUTO_OFF');
    expect(snipe).not.toHaveBeenCalled();
    expect(autoSnipeController.getStatus().mode).toBe('OFF');
  });

  it('kill switch on, off, arm again: the status read alone already shows OFF, and a candidate is not BOUGHT', async () => {
    await devnetLiveSession();
    riskEngine.setKillSwitch(true);
    expect(autoSnipeController.getStatus().mode).toBe('OFF');
    riskEngine.setKillSwitch(false);
    const d = await autoSnipeController.submitCandidate({ mint: newPumpPool('HOT').mint, source: 'TEST', provenance: 'REAL_ONCHAIN' });
    expect(d.outcome).not.toBe('BOUGHT');
    expect(autoSnipeController.getMode()).toBe('OFF');
  });

  it('the 5 s monitor tick does the same, before any trigger is judged', async () => {
    const state = await devnetLiveSession();
    state.armed = false;
    expect(await autoSnipeController.checkTriggers()).toEqual([]);
    expect(autoSnipeController.getMode()).toBe('OFF');
  });
});

describe('P1.4 N-11 / R1-119: Telegram /panic_sell sells the open LIVE position, with the protective panic reason', () => {
  it('a seeded LIVE OPEN position is closed with EMERGENCY_PANIC_LIQUIDATION; a CLOSED PAPER row is not attempted', async () => {
    const liveId = seedLive();
    const paperId = await paperBuy();
    await executionCoordinator.closePosition(paperId, 100, 'MANUAL');
    expect(row(paperId)!.status).toBe('CLOSED');
    // LIVE is armed until something disarms it: the getter follows the real armLiveTrading calls
    const arm = vi.spyOn(executionCoordinator, 'armLiveTrading');
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockImplementation(() => (arm.mock.calls.some((c) => c[0] === false) ? 'PAPER' : 'LIVE'));
    vi.spyOn(executionCoordinator, 'isLiveArmed').mockImplementation(() => !arm.mock.calls.some((c) => c[0] === false));
    const close = vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0.001, status: 'CLOSED' });

    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(arm).toHaveBeenCalledWith(false); // the stop disarms LIVE before it sells
    expect(close).toHaveBeenCalledWith(liveId, 100, 'EMERGENCY_PANIC_LIQUIDATION');
    expect(close.mock.calls.map((c) => c[0])).not.toContain(paperId);
    expect(r.reply).toMatch(/EMERGENCY DUMP COMPLETE/);
    expect(r.reply).toMatch(/Closed 1: LIV/);
    expect(r.actionTaken).toBe('PANIC_SELL_EXECUTED');
    expect(riskEngine.isKillSwitchActive()).toBe(true);
    expect(autoSnipeController.getStatus().killed).toBe(true);
  });

  it('a failed close is reported as still open, not as sold (Q23)', async () => {
    seedLive();
    vi.spyOn(executionCoordinator, 'closePosition').mockResolvedValue({ success: false, pnlSol: 0, error: 'RPC down' });
    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(r.reply).toMatch(/INCOMPLETE/);
    expect(r.reply).toMatch(/Still open: LIV \(RPC down\)/);
    expect(r.actionTaken).toBe('PANIC_SELL_PARTIAL');
  });
});

describe('P1.4 N-1: the HTTP panic waits for an auto buy in flight before it reads the positions to sell', () => {
  /**
   * In LIVE a buy that was sent cannot be called back, so the panic must read its sell list only after that buy has settled (its
   * position then exists and is sold). In PAPER no await sits between the risk gate and the fill, so the held buy below is refused by
   * the kill switch when released; what this test pins down is the order: the buy settles first, the panic reads ACTIVE rows after.
   */
  it('a held auto buy: start the HTTP panic, release the buy; the panic reads the positions only after the buy settled, and nothing stays open', async () => {
    await setAutoMode('PAPER');
    const seq: string[] = [];
    let panicStarted = false;
    const held = gate();
    const realExecute = executionCoordinator.executeTrade.bind(executionCoordinator);
    const exec = vi.spyOn(executionCoordinator, 'executeTrade').mockImplementation(async (req) => {
      await held.p;
      const r = await realExecute(req);
      seq.push(`buy-settled:${r.success ? r.positionId : r.error}`);
      return r;
    });
    const realLoad = workstationDb.loadPositions.bind(workstationDb);
    vi.spyOn(workstationDb, 'loadPositions').mockImplementation((mode?: any, status?: any) => {
      if (panicStarted && mode === undefined && status === 'ACTIVE') seq.push('panic-read');
      return realLoad(mode, status);
    });
    const decided = new Promise<any>((resolve) => autoSnipeController.once('decision', resolve));
    newPumpPool('HOT'); // the release goes to the controller through server.ts's real watch-window wiring, as in production
    await vi.waitFor(() => expect(exec, JSON.stringify(autoSnipeController.getDecisions(3))).toHaveBeenCalled(), { timeout: 10_000 });

    panicStarted = true;
    const panic = call('POST', '/api/wallet/panic-liquidate', {});
    await vi.waitFor(() => expect(autoSnipeController.getStatus().killed).toBe(true)); // the panic has started (kill sets this before it waits)
    expect(seq).not.toContain('panic-read');
    held.open();
    const [decision, r] = await Promise.all([decided, panic]);
    expect(r.status).toBe(200);
    expect(seq[0]).toMatch(/^buy-settled:/);
    expect(seq.indexOf('panic-read')).toBeGreaterThan(0);
    if (decision.positionId) {
      const failedIds = (r.json.data.failed as any[]).map((f) => f.id);
      expect(row(decision.positionId)!.status === 'CLOSED' || failedIds.includes(decision.positionId)).toBe(true);
    }
    expect(realLoad(undefined, 'ACTIVE')).toEqual([]);
    expect(autoSnipeController.getMode()).toBe('OFF');
  });
});

describe('P1.4 step 3: the emergency stop disarms LIVE', () => {
  // Audit 2026-10-22: with `armLiveTrading(false)` removed from emergencyStop, every test in this file still passed (two tests elsewhere
  // caught it). The claim is pinned here, in the file named for it.
  it('emergencyStop({ exitAll: false }) calls armLiveTrading(false) and leaves the coordinator disarmed, in PAPER', async () => {
    const arm = vi.spyOn(executionCoordinator, 'armLiveTrading');
    const report = await emergencyStop({ exitAll: false, reason: 'p14 disarm' });
    expect(report.killSwitchActivated).toBe(true);
    expect(arm).toHaveBeenCalledWith(false);
    expect(executionCoordinator.isLiveArmed()).toBe(false);
    expect(executionCoordinator.getExecutionMode()).toBe('PAPER');
  });
});

describe('P1.4 N-2: the WebSocket PANIC_LIQUIDATE runs the same stop', () => {
  it('leaves auto killed:true and OFF', async () => {
    await setAutoMode('PAPER');
    const c = await wsClient();
    try {
      c.send({ action: 'PANIC_LIQUIDATE' });
      const f = await c.next('PANIC_LIQUIDATION_RESULT');
      expect(f.data.killSwitchActivated).toBe(true);
      expect(f.data.autoStopped).toBe(true);
      const st = autoSnipeController.getStatus();
      expect(st.killed).toBe(true);
      expect(st.mode).toBe('OFF');
    } finally { c.close(); }
  });
});

describe('P1.4 R1-29: a panic during a take-profit partial waits for it and sells the remainder', () => {
  it('hold the TP1 sell, run the panic, release: the position ends CLOSED', async () => {
    const id = await paperBuy();
    const held = gate();
    const realFetch = PumpCurveService.fetchPumpMarketState.bind(PumpCurveService);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockImplementation(async (a: any) => { await held.p; return realFetch(a).catch(() => null); });
    const wait = vi.spyOn(executionCoordinator, 'waitForPositionExit');
    const tp1 = executionCoordinator.closePosition(id, 33, 'TAKE_PROFIT_1');
    const panic = emergencyStop({ exitAll: true, reason: 'p14 test' });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(id)); // the panic met EXIT_IN_PROGRESS and is waiting for the partial
    held.open();
    const [partial, report] = await Promise.all([tp1, panic]);
    expect(partial.success, partial.error).toBe(true);
    expect(row(id)!.status).toBe('CLOSED');
    expect(report.succeeded.map((s) => s.id)).toContain(id);
    expect(report.failed).toEqual([]);
    expect(executionCoordinator.isPanicActive()).toBe(false); // cleared in the finally
  });
});

describe('P1.4 N-3: /api/execution/close always closes as "Operator close"', () => {
  it('during a halt a close with reason "anything" closes; reason "STOP_LOSS" is journaled as an operator close with the text as a note', async () => {
    const a = await paperBuy();
    const b = await paperBuy();
    executionCoordinator.haltAll('p14 halt');
    const r1 = await call('POST', '/api/execution/close', { positionId: a, sellPct: 100, reason: 'anything' });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(row(a)!.status).toBe('CLOSED');
    const r2 = await call('POST', '/api/execution/close', { positionId: b, sellPct: 100, reason: 'STOP_LOSS' });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    const rows = workstationDb.loadDecisions({ stage: 'exit', limit: 50 }).filter((d) => d.positionId === b);
    expect(rows.find((d) => d.outcome === 'EXITED')!.reason).toBe('Operator close');
    expect(rows.some((d) => d.reason === 'STOP_LOSS')).toBe(false);
    expect(rows.find((d) => d.outcome === 'INFO')!.reason).toBe('operator close note: STOP_LOSS');
  });
});

describe('P1.4 N-6: a throwing route answers 500 and a failing WebSocket action gets an error frame', () => {
  it('executeSnipe rejects: POST /api/memecoins/trade is 500 and WS SNIPE_MEMECOIN gets {type: SNIPE_MEMECOIN_RESULT, success:false}', async () => {
    vi.spyOn(memecoinAggregator, 'executeSnipe').mockRejectedValue(new Error('p14 boom'));
    const r = await call('POST', '/api/memecoins/trade', { contractAddress: freshMint(), amountUsd: 5 });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).toMatch(/p14 boom/);
    const c = await wsClient();
    try {
      c.send({ action: 'SNIPE_MEMECOIN', contractAddress: freshMint(), amountUsd: 5 });
      const f = await c.next('SNIPE_MEMECOIN_RESULT');
      expect(f).toMatchObject({ success: false, error: 'p14 boom' });
    } finally { c.close(); }
  });
});

describe('P1.4 N-12: the sniper screen mirrors the auto mode, read-only', () => {
  it('shows no DISARMED label while auto is DEVNET_LIVE, names the mode and points to the Auto panel', () => {
    const html = renderToStaticMarkup(React.createElement(SniperAutoHeader, { autoMode: 'DEVNET_LIVE' }));
    expect(html).not.toMatch(/DISARMED|ARMED &amp; ACTIVE/);
    expect(html).toContain('AUTO: DEVNET_LIVE');
    expect(html).toMatch(/Auto panel/);
    expect(html).toMatch(/pump\.fun/);
    expect(html).not.toMatch(/Raydium, and Base when/);
    expect(html).not.toMatch(/<button/); // nothing to click: it does not set the mode
  });
});

describe('P1.4 N-0 over HTTP: kill switch on, off, re-arm leaves auto out of DEVNET_LIVE (real server, stub RPC)', () => {
  let rpc: RpcStub; let app: AppHandle; let dir: string;
  beforeAll(async () => {
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    dir = scratchDir('p14-');
    app = await startApp(dir, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, ALLOW_LIVE_REAL_MONEY_TRADING: 'true', AUTO_SNIPE_ENABLED: 'true' });
  }, 120_000);
  afterAll(async () => { await app?.stop(); await rpc?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('arm, DEVNET_LIVE with the code, kill switch on then off, arm again: auto is not DEVNET_LIVE and nothing was sent', async () => {
    const ARM = { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' };
    // readiness (wallet sync, startup reconciliation) settles a little after boot; under a full-suite load that can take seconds
    await vi.waitFor(async () => expect((await app.call('GET', '/api/execution/can-arm')).json.allowed).toBe(true), { timeout: 60_000, interval: 500 });
    expect((await app.call('POST', '/api/execution/arm', ARM)).status).toBe(200);
    const set = await app.call('POST', '/api/auto/mode', { mode: 'DEVNET_LIVE', confirmationCode: DEVNET_CONFIRMATION_CODE });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.status.mode).toBe('DEVNET_LIVE');
    expect((await app.call('GET', '/api/wallet/state')).json.data.isLiveTradingActive).toBe(true); // really armed, through the real route
    const on = await app.call('POST', '/api/execution/kill-switch', { activate: true });
    expect(on.json.killSwitchActive).toBe(true);
    expect(on.json.autoMode).toBe('OFF');
    expect((await app.call('GET', '/api/wallet/state')).json.data.isLiveTradingActive).toBe(false); // the stop disarmed LIVE
    expect((await app.call('POST', '/api/execution/kill-switch', { activate: false })).json.killSwitchActive).toBe(false);
    expect((await app.call('POST', '/api/execution/arm', ARM)).status).toBe(200);
    const st = (await app.call('GET', '/api/auto/status')).json;
    expect(st.mode).not.toBe('DEVNET_LIVE');
    expect(st.killed).toBe(true);
    expect(rpc.count('sendTransaction')).toBe(0);
  }, 120_000);
});
