import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import BN from 'bn.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_SDK, GLOBAL_PDA, PUMP_FEE_CONFIG_PDA } from '@pump-fun/pump-sdk';
import { PumpFeedListener, FEED_SLOT_SILENCE_MS, FEED_SLOT_JUMP_MAX, FEED_HEARTBEAT_CHECK_MS } from '../server/solana/pumpFeedListener';
import { WatchWindow } from '../server/signals/watchWindow';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PUMP_FUN_PROGRAM_ID } from '../server/solana/programs';
import { PumpFunService, pumpBootMode } from '../server/pumpfunService';
import { pumpFeedListener } from '../server/solana/pumpFeedListener';
import { creatorRiskScorer } from '../server/signals/creatorRiskScorer';
import { CLUSTER_GENESIS_HASH } from '../server/solana/clusterGuard';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';

/**
 * P4.2: feed gaps, endpoint drift and the quote mint (R1-52, R1-63, N-43, R1-64, R1-65). The listener, the watch window, the coordinator
 * and the curve service are the production classes; the only doubles sit at the Connection boundary (a fake Connection whose websocket
 * is an EventEmitter, spies on web3.js's Connection prototype, a fetch spy, MockSolanaRpc).
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  creatorRiskScorer.clearCache();
  PumpCurveService.resetGlobalCache();
});

/** A Connection fake: records the onLogs and onSlotChange callbacks; `_rpcWebSocket` is the socket web3.js keeps, here an EventEmitter. */
function fakeConn(endpoint = 'http://127.0.0.1:18899') {
  let logsCb: ((logs: any, ctx: any) => void) | null = null;
  let slotCb: ((info: any) => void) | null = null;
  const socket = new EventEmitter();
  const conn: any = {
    rpcEndpoint: endpoint,
    _rpcEndpoint: endpoint,
    _rpcWebSocket: socket,
    onLogs: vi.fn((_p: PublicKey, fn: any) => { logsCb = fn; return 7; }),
    removeOnLogsListener: vi.fn(async () => undefined),
    onSlotChange: vi.fn((fn: any) => { slotCb = fn; return 8; }),
    removeSlotChangeListener: vi.fn(async () => undefined),
    getSignaturesForAddress: async () => [],
  };
  return {
    conn, socket,
    replay: (logs: string[], slot: number, sig = `sig${slot}-${Math.random()}`) => logsCb!({ err: null, logs, signature: sig }, { slot }),
    slot: (slot: number) => slotCb!({ slot, parent: slot - 1, root: slot }),
  };
}

const createLog = (mint: PublicKey, creator: PublicKey, quoteMint?: PublicKey) =>
  PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name: 'Gap', symbol: 'GAP', uri: '', mint, creator, quoteMint }));
const tradeLog = (mint: PublicKey, user: PublicKey, isBuy: boolean, sol = 0.5) =>
  PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeTradeEventLog({
    mint, solAmountLamports: BigInt(Math.round(sol * 1e9)), tokenAmount: 1_000_000n, isBuy, user, timestampSec: Math.floor(Date.now() / 1000),
    virtualSolReserves: 40_000_000_000n, virtualTokenReserves: 900_000_000_000_000n, realSolReserves: 10_000_000_000n, realTokenReserves: 700_000_000_000_000n,
  }));

async function running() {
  const f = fakeConn();
  const listener = new PumpFeedListener(f.conn);
  const ww = new WatchWindow({ publicFunders: [] });
  ww.attach(listener);
  expect(await listener.start()).toBe(true);
  return { ...f, listener, ww };
}

describe('R1-52: a gap in the log stream releases every watched launch DEAD with FEED_GAP', () => {
  it('the socket closes then opens: the status leaves ACTIVE, and a launch watched across the gap is DEAD with FEED_GAP', async () => {
    const { listener, ww, socket, replay } = await running();
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    replay(createLog(mint, creator), 10);
    replay(tradeLog(mint, Keypair.generate().publicKey, true), 11);
    expect(ww.isWatching(mint.toBase58())).toBe(true);
    expect(listener.getTelemetry().status).toBe('ACTIVE');

    socket.emit('close', 1006);
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    expect(listener.isActive()).toBe(false);
    const v = ww.getVerdict(mint.toBase58());
    expect(v?.state).toBe('DEAD');
    expect(v?.reason).toMatch(/^FEED_GAP: .*SOCKET_CLOSED/);

    // (the creator's sell during the gap is never delivered; when the socket is back, the launch stays DEAD)
    socket.emit('open');
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(listener.getTelemetry().feedGaps).toBe(1);
    expect(listener.getTelemetry().lastFeedGap?.reason).toBe('SOCKET_CLOSED');
    replay(tradeLog(mint, Keypair.generate().publicKey, true, 5), 40);
    expect(ww.getVerdict(mint.toBase58())?.state).toBe('DEAD');

    // a launch that starts after the reconnect is watched normally
    const later = Keypair.generate().publicKey;
    replay(createLog(later, creator), 41);
    expect(ww.getVerdict(later.toBase58())?.state).toBe('WATCHING');
    await listener.stop();
  });

  it('a second close during the same gap does not release again, and stop() detaches from the socket', async () => {
    const { listener, ww, socket, replay } = await running();
    const release = vi.fn();
    ww.on('release', release);
    replay(createLog(Keypair.generate().publicKey, Keypair.generate().publicKey), 10);
    socket.emit('close', 1006);
    socket.emit('close', 1006);
    expect(release).toHaveBeenCalledTimes(1);
    expect(listener.getTelemetry().feedGaps).toBe(1);
    await listener.stop();
    expect(socket.listenerCount('close')).toBe(0);
    expect(socket.listenerCount('open')).toBe(0);
  });

  it('slot heartbeat: no slot for longer than FEED_SLOT_SILENCE_MS opens a gap; the next slot closes it', async () => {
    vi.useFakeTimers();
    const { listener, ww, replay, slot } = await running();
    slot(100);
    const mint = Keypair.generate().publicKey;
    replay(createLog(mint, Keypair.generate().publicKey), 100);
    await vi.advanceTimersByTimeAsync(FEED_SLOT_SILENCE_MS - FEED_HEARTBEAT_CHECK_MS);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    await vi.advanceTimersByTimeAsync(2 * FEED_HEARTBEAT_CHECK_MS + 1);
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    expect(ww.getVerdict(mint.toBase58())?.reason).toMatch(/^FEED_GAP: .*SLOT_SILENCE/);
    slot(101);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    await listener.stop();
  });

  it('slot heartbeat: a jump of more than FEED_SLOT_JUMP_MAX slots is a gap until the next in-order slot; a normal step is not', async () => {
    const { listener, ww, replay, slot } = await running();
    slot(500);
    slot(500 + FEED_SLOT_JUMP_MAX); // within the limit
    const mint = Keypair.generate().publicKey;
    replay(createLog(mint, Keypair.generate().publicKey), 530);
    expect(ww.getVerdict(mint.toBase58())?.state).toBe('WATCHING');
    slot(500 + 2 * FEED_SLOT_JUMP_MAX + 1);
    expect(ww.getVerdict(mint.toBase58())?.reason).toMatch(/^FEED_GAP: .*SLOT_JUMP/);
    // B7: the jump shows as RECONNECTING (it used to go straight back to ACTIVE in the same call)
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    expect(listener.isActive()).toBe(false);
    slot(500 + 2 * FEED_SLOT_JUMP_MAX + 2); // the next slot is in order: the stream is delivering again
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(listener.getTelemetry().feedGaps).toBe(1);
    await listener.stop();
  });

  it('an RPC that never sends a slot is judged by its socket alone: silence never opens a gap', async () => {
    vi.useFakeTimers();
    const { listener, ww, replay } = await running();
    const mint = Keypair.generate().publicKey;
    replay(createLog(mint, Keypair.generate().publicKey), 1);
    await vi.advanceTimersByTimeAsync(5 * FEED_SLOT_SILENCE_MS);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(ww.getVerdict(mint.toBase58())?.state).toBe('WATCHING');
    await listener.stop();
  });
});

describe('R1-63: setRpcEndpoint moves the log subscription', () => {
  it('setRpcEndpoint(B): removeOnLogsListener on A, onLogs on B, and open candidates are released FEED_GAP', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
      const { id, method } = JSON.parse(String(init?.body ?? '{}'));
      const result = method === 'getGenesisHash' ? CLUSTER_GENESIS_HASH.devnet : method === 'getSlot' ? 42 : method === 'getBalance' ? { context: { slot: 1 }, value: 0 } : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const onLogs = vi.spyOn(Connection.prototype, 'onLogs').mockReturnValue(11);
    const removeLogs = vi.spyOn(Connection.prototype, 'removeOnLogsListener').mockResolvedValue(undefined);
    const slotCbs: Array<{ conn: unknown; fn: (info: any) => void }> = [];
    vi.spyOn(Connection.prototype, 'onSlotChange').mockImplementation(function (this: unknown, fn: any) { slotCbs.push({ conn: this, fn }); return 12; });
    vi.spyOn(Connection.prototype, 'removeSlotChangeListener').mockResolvedValue(undefined);

    const c = new ExecutionCoordinator();
    try {
      const a = c.getConnection();
      const listener = new PumpFeedListener(a);
      listener.follow(c);
      const ww = new WatchWindow({ publicFunders: [] });
      ww.attach(listener);
      expect(await listener.start()).toBe(true);
      expect(onLogs.mock.contexts[0]).toBe(a);
      const mint = Keypair.generate().publicKey.toBase58();
      ww.watch(mint, Keypair.generate().publicKey.toBase58());

      const res = await c.setRpcEndpoint('http://127.0.0.1:9');
      expect(res.success, res.error).toBe(true);
      const b = c.getConnection();
      expect(b).not.toBe(a);
      await vi.waitFor(() => expect(onLogs).toHaveBeenCalledTimes(2));
      expect(removeLogs.mock.contexts[0]).toBe(a);
      expect(removeLogs.mock.calls[0][0]).toBe(11);
      expect(onLogs.mock.contexts[1]).toBe(b);
      expect(listener.getTelemetry().activeEndpoint).toBe('http://127.0.0.1:9');
      expect(listener.getTelemetry().lastFeedGap?.reason).toBe('ENDPOINT_SWITCH');
      expect(ww.getVerdict(mint)?.reason).toMatch(/^FEED_GAP: .*ENDPOINT_SWITCH/);
      // B7: the switch shows as RECONNECTING until the new Connection delivers (here its first slot)
      expect(listener.getTelemetry().status).toBe('RECONNECTING');
      expect(listener.isActive()).toBe(false);
      const onB = slotCbs.filter((s) => s.conn === b);
      expect(onB).toHaveLength(1);
      onB[0].fn({ slot: 43, parent: 42, root: 42 });
      expect(listener.isActive()).toBe(true);
      await listener.stop();
      listener.destroy();
    } finally {
      c.cleanup();
    }
  });
});

const dump = (name: string) => {
  const j = JSON.parse(fs.readFileSync(`scripts/localnet/accounts/${name}.json`, 'utf8'));
  return { data: Buffer.from(j.account.data[0], 'base64'), owner: new PublicKey(j.account.owner), lamports: 1, executable: false } as any;
};
const mintAccount = () => { const d = Buffer.alloc(82); d[44] = 6; return { owner: TOKEN_PROGRAM_ID, lamports: 1_461_600, data: d, executable: false }; };
const curveAccount = async (quoteMint: PublicKey = NATIVE_MINT) => ({
  owner: PUMP_FUN_PROGRAM_ID, lamports: 1_000_000, executable: false,
  data: await (PUMP_SDK as any).offlinePumpProgram.coder.accounts.encode('bondingCurve', {
    virtualTokenReserves: new BN('800000000000000'), virtualQuoteReserves: new BN('38000000000'), realTokenReserves: new BN('520000000000000'),
    realQuoteReserves: new BN('8000000000'), tokenTotalSupply: new BN('1000000000000000'), complete: false, creator: Keypair.generate().publicKey,
    isMayhemMode: false, isCashbackCoin: false, quoteMint, creatorFeeBps: new BN(0), canEditCreatorFee: false,
  }),
});

async function market(quoteMint?: PublicKey) {
  const rpc = new MockSolanaRpc();
  const mint = Keypair.generate().publicKey;
  rpc.setAccount(mint, mintAccount());
  rpc.setAccount(PumpCurveService.getBondingCurveAddress(mint)[0], await curveAccount(quoteMint));
  rpc.setAccount(GLOBAL_PDA, dump('pump_global'));
  rpc.setAccount(PUMP_FEE_CONFIG_PDA, dump('pump_fee_config'));
  return { rpc, mint, conn: rpc.createConnection() };
}

describe('N-43: the Global and FeeConfig cache', () => {
  it('a refresh that reads a null Global after the TTL: cachedGlobal is null and the LIVE fetch returns null (a SELL keeps its fee-ceiling state)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rpc, mint, conn } = await market();
    const first = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' });
    expect(first?.feeComputationStatus).toBe('VERIFIED');
    expect(PumpCurveService.cachedGlobal).not.toBeNull();

    rpc.removeAccount(GLOBAL_PDA);
    vi.setSystemTime(Date.now() + 61_000); // past the 60 s TTL
    const read = await PumpCurveService.fetchPumpMarketStateResult({ connection: conn, mint, executionMode: 'LIVE' });
    expect(read.state).toBeNull();
    expect(PumpCurveService.cachedGlobal).toBeNull();
    expect(read.failure?.reason).toBe('FEE_RECIPIENT_UNRESOLVED');
    // S237: a stop-loss is not left without a transaction; the state is for a SELL only and never prices a buy
    expect(read.failure?.sellableState?.unverifiedFeeCeilingBps).toBeGreaterThan(0);
    const g: any = PUMP_SDK.decodeGlobal(dump('pump_global'));
    const recipients = [g.feeRecipient, ...g.feeRecipients].map((k: any) => new PublicKey(k).toBase58());
    expect(recipients).toContain(read.failure!.sellableState!.feeRecipient.toBase58()); // from the last Global this endpoint returned
    expect(() => PumpCurveService.calculateBuyQuote({ state: read.failure!.sellableState!, amountSol: 0.01, executionMode: 'LIVE' })).toThrow(/DYNAMIC_FEE_CALCULATION_FAILED/);

    // the null is asked for again on the next call, not kept for 60 s
    const spy = vi.spyOn(conn, 'getMultipleAccountsInfo');
    rpc.setAccount(GLOBAL_PDA, dump('pump_global'));
    const back = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' });
    expect(spy.mock.calls[0][0]).toHaveLength(4);
    expect(back?.feeComputationStatus).toBe('VERIFIED');
  });

  it('a read through another endpoint fetches the Global again instead of using the first endpoint\'s', async () => {
    const { mint, conn } = await market();
    await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' });
    const other = await market();
    (other.conn as any).rpcEndpoint = 'http://127.0.0.1:28899';
    other.rpc.removeAccount(GLOBAL_PDA);
    const spy = vi.spyOn(other.conn, 'getMultipleAccountsInfo');
    const res = await PumpCurveService.fetchPumpMarketState({ connection: other.conn, mint: other.mint, executionMode: 'LIVE' });
    expect(spy.mock.calls[0][0]).toHaveLength(4);
    expect(res).toBeNull(); // the other endpoint has no Global: fail closed, not the first endpoint's decode
    expect(PumpCurveService.cachedGlobal).toBeNull();
  });

  it('setRpcEndpoint clears the cache', async () => {
    const { mint, conn } = await market();
    await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' });
    expect(PumpCurveService.cachedGlobal).not.toBeNull();
    expect(PumpCurveService.cachedFeeConfig).not.toBeNull();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
      const { id, method } = JSON.parse(String(init?.body ?? '{}'));
      const result = method === 'getGenesisHash' ? CLUSTER_GENESIS_HASH.devnet : method === 'getSlot' ? 42 : method === 'getBalance' ? { context: { slot: 1 }, value: 0 } : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const c = new ExecutionCoordinator(conn);
    try {
      const res = await c.setRpcEndpoint('http://127.0.0.1:9');
      expect(res.success, res.error).toBe(true);
      expect(PumpCurveService.cachedGlobal).toBeNull();
      expect(PumpCurveService.cachedFeeConfig).toBeNull();
    } finally {
      c.cleanup();
    }
  });
});

describe('R1-64: a launch quoted in another mint', () => {
  it('a CreateEvent with a non-SOL quote_mint is not watched, and its trades are dropped', async () => {
    const { listener, ww, replay } = await running();
    const usdcLike = Keypair.generate().publicKey;
    const exotic = Keypair.generate().publicKey;
    const trades = vi.fn();
    listener.on('trade_event', trades);
    replay(createLog(exotic, Keypair.generate().publicKey, usdcLike), 5);
    replay(tradeLog(exotic, Keypair.generate().publicKey, true), 6);
    expect(ww.getVerdict(exotic.toBase58())).toBeNull();
    expect(listener.getTelemetry().nonSolQuoteSkipped).toBe(1);
    expect(trades).not.toHaveBeenCalled();

    // wSOL and the default key are SOL quotes and are watched
    const wsol = Keypair.generate().publicKey;
    replay(createLog(wsol, Keypair.generate().publicKey, NATIVE_MINT), 7);
    const legacy = Keypair.generate().publicKey;
    replay(createLog(legacy, Keypair.generate().publicKey, PublicKey.default), 8);
    expect(ww.isWatching(wsol.toBase58())).toBe(true);
    expect(ww.isWatching(legacy.toBase58())).toBe(true);
    expect(listener.parseLogs({ err: null, signature: 'x', logs: createLog(exotic, Keypair.generate().publicKey, usdcLike) } as any)?.quoteMint).toBe(usdcLike.toBase58());
    await listener.stop();
  });

  it('PAPER refuses a curve whose quote mint is not SOL too', async () => {
    const { mint, conn } = await market(Keypair.generate().publicKey);
    const read = await PumpCurveService.fetchPumpMarketStateResult({ connection: conn, mint, executionMode: 'PAPER' });
    expect(read.state).toBeNull();
    expect(read.failure?.reason).toBe('UNSUPPORTED_QUOTE_MINT');
  });
});

describe('R1-65: no pump.fun / DexScreener HTTP polling off mainnet', () => {
  it('ALLOWED_CLUSTER=devnet: the boot mode is WS_ONLY and startBackground schedules no HTTP poll', async () => {
    expect(pumpBootMode({ ALLOWED_CLUSTER: 'devnet' })).toBe('WS_ONLY');
    expect(pumpBootMode({ ALLOWED_CLUSTER: 'localnet' })).toBe('WS_ONLY');
    expect(pumpBootMode({ ALLOWED_CLUSTER: 'mainnet-beta' })).toBe('FULL');
    vi.spyOn(pumpFeedListener, 'start').mockResolvedValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.useFakeTimers();
    try {
      const svc = new PumpFunService();
      const sync = vi.spyOn(svc, 'syncRealWorldData');
      svc.startBackground({ env: { ALLOWED_CLUSTER: 'devnet' } }); // even with the pollers not turned off by the caller
      await vi.advanceTimersByTimeAsync(70_000);
      expect(sync).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); }
  });

  it('ALLOWED_CLUSTER=mainnet-beta still starts them', () => {
    vi.spyOn(pumpFeedListener, 'start').mockResolvedValue(true);
    vi.useFakeTimers();
    try {
      const svc = new PumpFunService();
      const sync = vi.spyOn(svc, 'syncRealWorldData').mockResolvedValue(undefined);
      svc.startBackground({ env: { ALLOWED_CLUSTER: 'mainnet-beta' } });
      expect(sync).toHaveBeenCalledTimes(1);
    } finally { vi.clearAllTimers(); }
  });
});

describe('B7 (review 2026-10-24, finding 7): slot-jump and RPC-switch gaps show RECONNECTING', () => {
  it('switchConnection: RECONNECTING with one feed_gap until the new Connection delivers; its first log also closes the gap', async () => {
    const { listener, ww, replay } = await running();
    const gaps = vi.fn();
    listener.on('feed_gap', gaps);
    const mint = Keypair.generate().publicKey;
    replay(createLog(mint, Keypair.generate().publicKey), 10);
    const next = fakeConn('http://127.0.0.1:28899');
    expect(await listener.switchConnection(next.conn)).toBe(true);
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    expect(listener.isActive()).toBe(false);
    expect(gaps).toHaveBeenCalledTimes(1);
    expect(gaps.mock.calls[0][0].reason).toBe('ENDPOINT_SWITCH');
    expect(ww.getVerdict(mint.toBase58())?.reason).toMatch(/^FEED_GAP: .*ENDPOINT_SWITCH/);
    // an RPC without slot notifications: the first log on the new subscription shows it is delivering
    const later = Keypair.generate().publicKey;
    next.replay(createLog(later, Keypair.generate().publicKey), 20);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(ww.getVerdict(later.toBase58())?.state).toBe('WATCHING'); // watched after the switch, not released by it
    expect(listener.getTelemetry().feedGaps).toBe(1);
    await listener.stop();
  });

  it('switchConnection: the new socket opening closes the gap', async () => {
    const { listener } = await running();
    const next = fakeConn('http://127.0.0.1:28899');
    await listener.switchConnection(next.conn);
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    next.socket.emit('open');
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    await listener.stop();
  });

  it('a log does not close a slot-jump gap: only the next in-order slot does', async () => {
    const { listener, replay, slot } = await running();
    slot(100);
    slot(100 + FEED_SLOT_JUMP_MAX + 1);
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    replay(createLog(Keypair.generate().publicKey, Keypair.generate().publicKey), 127);
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    slot(100 + FEED_SLOT_JUMP_MAX + 2);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    await listener.stop();
  });
});

describe('B10 (review 2026-10-24, finding 10): two quick RPC switches leave one log subscription', () => {
  /** A fake Connection that counts its live log subscriptions; unsubscribing takes a few ticks, as it does over a websocket. */
  function countingConn(endpoint: string) {
    const f = fakeConn(endpoint);
    let live = 0;
    let nextId = 100;
    f.conn.onLogs = vi.fn(() => { live++; return nextId++; });
    f.conn.removeOnLogsListener = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); live--; });
    f.conn.removeSlotChangeListener = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); });
    return { ...f, live: () => live };
  }

  it('switch to B then C without awaiting: one subscription, on C; B is never left subscribed', async () => {
    const a = countingConn('http://127.0.0.1:18001');
    const b = countingConn('http://127.0.0.1:18002');
    const c = countingConn('http://127.0.0.1:18003');
    const listener = new PumpFeedListener(a.conn);
    expect(await listener.start()).toBe(true);
    const first = listener.switchConnection(b.conn);
    const second = listener.switchConnection(c.conn);
    await Promise.all([first, second]);
    // each Connection on its own: before B10, A was unsubscribed twice (-1) and B kept an orphaned subscription
    expect([a.live(), b.live(), c.live()]).toEqual([0, 0, 1]);
    expect(listener.getTelemetry().activeEndpoint).toBe('http://127.0.0.1:18003');
    expect(listener.getTelemetry().subscriptionId).not.toBeNull();
    await listener.stop();
    expect([a.live(), b.live(), c.live()]).toEqual([0, 0, 0]);
  });

  it('follow(): two setRpcEndpoint announcements in a row end on the second Connection with one subscription', async () => {
    const a = countingConn('http://127.0.0.1:18011');
    const b = countingConn('http://127.0.0.1:18012');
    const c = countingConn('http://127.0.0.1:18013');
    const fns: Array<(conn: any) => void> = [];
    const listener = new PumpFeedListener(a.conn);
    listener.follow({ onConnectionChange: (fn) => { fns.push(fn); return () => undefined; } });
    expect(await listener.start()).toBe(true);
    fns[0](b.conn);
    fns[0](c.conn);
    await vi.waitFor(() => expect(c.live()).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect([a.live(), b.live(), c.live()]).toEqual([0, 0, 1]);
    expect(listener.getTelemetry().activeEndpoint).toBe('http://127.0.0.1:18013');
    listener.destroy();
  });

  it('a switch back to the Connection in use while a switch is still running ends on that Connection', async () => {
    const a = countingConn('http://127.0.0.1:18021');
    const b = countingConn('http://127.0.0.1:18022');
    const listener = new PumpFeedListener(a.conn);
    expect(await listener.start()).toBe(true);
    const toB = listener.switchConnection(b.conn);
    const backToA = listener.switchConnection(a.conn);
    await Promise.all([toB, backToA]);
    expect([a.live(), b.live()]).toEqual([1, 0]);
    expect(listener.getTelemetry().activeEndpoint).toBe('http://127.0.0.1:18021');
    await listener.stop();
  });
});
