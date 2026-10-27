import { EventEmitter } from 'node:events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  PumpFeedListener, FEED_NO_DELIVERY_MS, FEED_NO_DELIVERY_MAX_WAIT_MS, FEED_NO_DELIVERY_TRIES_BEFORE_ERROR, FEED_HEARTBEAT_CHECK_MS,
} from '../server/solana/pumpFeedListener';
import { WatchWindow } from '../server/signals/watchWindow';

/**
 * Devnet run 25 (task 3K): a log subscription that delivers nothing is not ACTIVE for good. The listener and the watch window are the
 * production classes; the doubles sit at the Connection boundary: a fake Connection that can report its subscriptions' server state as
 * web3.js does (`_onSubscriptionStateChange`), and spies on web3.js's Connection prototype for the fresh Connections the watchdog makes.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A Connection fake. `confirmable`: it reports server state like web3.js (logs subscription id 7, slot id 8). */
function fakeConn(opts: { confirmable?: boolean; slots?: boolean } = {}) {
  const { confirmable = true, slots = true } = opts;
  let logsCb: ((logs: any, ctx: any) => void) | null = null;
  let slotCb: ((info: any) => void) | null = null;
  const stateCbs = new Map<number, Array<(s: string) => void>>();
  const socket: any = new EventEmitter();
  socket.setAutoReconnect = vi.fn();
  socket.close = vi.fn();
  const conn: any = {
    rpcEndpoint: 'http://127.0.0.1:18899',
    _rpcEndpoint: 'http://127.0.0.1:18899',
    _rpcWsEndpoint: 'ws://127.0.0.1:18900',
    _rpcWebSocket: socket,
    onLogs: vi.fn((_p: PublicKey, fn: any) => { logsCb = fn; return 7; }),
    removeOnLogsListener: vi.fn(async () => undefined),
    getSignaturesForAddress: async () => [],
  };
  if (slots) {
    conn.onSlotChange = vi.fn((fn: any) => { slotCb = fn; return 8; });
    conn.removeSlotChangeListener = vi.fn(async () => undefined);
  }
  if (confirmable) {
    conn._subscriptionHashByClientSubscriptionId = { 7: 'logs', 8: 'slot' };
    conn._subscriptionsByHash = {};
    conn._onSubscriptionStateChange = (id: number, cb: (s: string) => void) => {
      stateCbs.set(id, [...(stateCbs.get(id) ?? []), cb]);
      return () => stateCbs.set(id, (stateCbs.get(id) ?? []).filter((x) => x !== cb));
    };
  }
  return {
    conn, socket,
    state: (id: number, s: string) => { for (const cb of stateCbs.get(id) ?? []) cb(s); },
    log: (slot: number) => logsCb!({ err: null, logs: ['Program log: hello'], signature: `sig${slot}` }, { slot }),
    slot: (slot: number) => slotCb!({ slot, parent: slot - 1, root: slot }),
  };
}

/**
 * web3.js's Connection prototype, for the fresh Connections the watchdog makes. They record calls; with `confirmAll` the server confirms
 * both subscriptions at once (and then delivers nothing), otherwise they report no server state.
 */
function spyFresh(confirmAll = false) {
  const times: number[] = [];
  const onLogs = vi.spyOn(Connection.prototype, 'onLogs').mockImplementation(function (this: any) {
    times.push(Date.now());
    if (confirmAll) this._subscriptionHashByClientSubscriptionId[21] = 'logs';
    return 21;
  });
  if (confirmAll) {
    vi.spyOn(Connection.prototype as any, '_onSubscriptionStateChange').mockImplementation((_id: any, cb: any) => { cb('subscribed'); return () => {}; });
  }
  vi.spyOn(Connection.prototype, 'removeOnLogsListener').mockResolvedValue(undefined);
  const slotCbs: Array<{ conn: any; fn: (info: any) => void }> = [];
  vi.spyOn(Connection.prototype, 'onSlotChange').mockImplementation(function (this: any, fn: any) { slotCbs.push({ conn: this, fn }); return 22; });
  vi.spyOn(Connection.prototype, 'removeSlotChangeListener').mockResolvedValue(undefined);
  return { onLogs, slotCbs, times };
}

const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

describe('run 25: the listener is not ACTIVE before the server confirms its subscription', () => {
  it('CONNECTING after onLogs, ACTIVE when the log subscription is confirmed', async () => {
    const f = fakeConn();
    const listener = new PumpFeedListener(f.conn);
    expect(await listener.start()).toBe(true);
    expect(listener.getTelemetry().status).toBe('CONNECTING');
    expect(listener.isActive()).toBe(false);
    expect(listener.getTelemetry().subscriptionConfirmed).toBe(false);
    f.state(7, 'subscribed');
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(listener.getTelemetry().subscriptionConfirmed).toBe(true);
    listener.destroy();
  });

  it('a Connection that cannot report server state is ACTIVE at once, as before', async () => {
    const f = fakeConn({ confirmable: false });
    const listener = new PumpFeedListener(f.conn);
    expect(await listener.start()).toBe(true);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    listener.destroy();
  });

  it('a socket drop unconfirms it: after the reopen it is CONNECTING until the resubscribe is confirmed', async () => {
    const f = fakeConn();
    const listener = new PumpFeedListener(f.conn);
    await listener.start();
    f.state(7, 'subscribed');
    f.socket.emit('close');
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    f.socket.emit('open');
    expect(listener.getTelemetry().status).toBe('CONNECTING');
    f.state(7, 'subscribed');
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    listener.destroy();
  });
});

describe('run 25: the delivery watchdog (NO_DELIVERY)', () => {
  it('subscribed, slot subscription confirmed, nothing delivered for 15 s: NO_DELIVERY gap, watched launches DEAD, moved to a fresh Connection', async () => {
    vi.useFakeTimers();
    const fresh = spyFresh();
    const f = fakeConn();
    const listener = new PumpFeedListener(f.conn);
    const ww = new WatchWindow({ publicFunders: [] });
    ww.attach(listener);
    await listener.start();
    f.state(7, 'subscribed');
    f.state(8, 'subscribed');
    expect(listener.getTelemetry().status).toBe('ACTIVE'); // the run-25 state: ACTIVE, and nothing will ever arrive
    const mint = Keypair.generate().publicKey.toBase58();
    ww.watch(mint, null);

    await tick(FEED_NO_DELIVERY_MS - FEED_HEARTBEAT_CHECK_MS);
    expect(listener.getTelemetry().feedGaps).toBe(0);
    await tick(2 * FEED_HEARTBEAT_CHECK_MS);
    const tel = listener.getTelemetry();
    expect(tel.lastFeedGap?.reason).toBe('NO_DELIVERY');
    expect(tel.status).not.toBe('ACTIVE');
    expect(tel.noDeliveryTries).toBe(1);
    expect(ww.getVerdict(mint)?.reason).toMatch(/^FEED_GAP: .*NO_DELIVERY/);
    expect(f.conn.removeOnLogsListener).toHaveBeenCalledWith(7);
    expect(fresh.onLogs).toHaveBeenCalledTimes(1);
    const newConn = fresh.onLogs.mock.contexts[0] as any;
    expect(newConn).toBeInstanceOf(Connection);
    expect(newConn).not.toBe(f.conn);
    expect(newConn.rpcEndpoint).toBe('http://127.0.0.1:18899');
    expect(newConn._rpcWsEndpoint).toBe('ws://127.0.0.1:18900'); // the same endpoints, a new socket
    expect(tel.activeEndpoint).toBe('http://127.0.0.1:18899');

    // the socket opening is not a delivery; the first slot is
    newConn._rpcWebSocket.emit('open');
    expect(listener.getTelemetry().status).toBe('RECONNECTING');
    fresh.slotCbs.find((s) => s.conn === newConn)!.fn({ slot: 100, parent: 99, root: 99 });
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(listener.getTelemetry().noDeliveryTries).toBe(0);
    listener.destroy();
  });

  it('the log subscription never confirmed: NO_DELIVERY after 15 s even without a slot heartbeat', async () => {
    vi.useFakeTimers();
    const fresh = spyFresh();
    const f = fakeConn({ slots: false });
    const listener = new PumpFeedListener(f.conn);
    await listener.start();
    expect(listener.getTelemetry().status).toBe('CONNECTING');
    await tick(FEED_NO_DELIVERY_MS + 2 * FEED_HEARTBEAT_CHECK_MS);
    expect(listener.getTelemetry().lastFeedGap?.reason).toBe('NO_DELIVERY');
    expect(listener.getTelemetry().lastFeedGap?.detail).toMatch(/never confirmed/);
    expect(fresh.onLogs).toHaveBeenCalledTimes(1);
    listener.destroy();
  });

  it('confirmed, no slot heartbeat, no pump log for an hour: a quiet feed is left alone (it cannot be told from a deaf one)', async () => {
    vi.useFakeTimers();
    const fresh = spyFresh();
    const f = fakeConn({ slots: false });
    const listener = new PumpFeedListener(f.conn);
    await listener.start();
    f.state(7, 'subscribed');
    await tick(3_600_000);
    expect(listener.getTelemetry().feedGaps).toBe(0);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    expect(fresh.onLogs).not.toHaveBeenCalled();
    listener.destroy();
  });

  it('logs keep it alive: a log every 10 s with a confirmed slot subscription that never ticks opens no NO_DELIVERY', async () => {
    vi.useFakeTimers();
    const fresh = spyFresh();
    const f = fakeConn();
    const listener = new PumpFeedListener(f.conn);
    await listener.start();
    f.state(7, 'subscribed');
    f.state(8, 'subscribed');
    for (let i = 0; i < 12; i++) { await tick(10_000); f.log(10 + i); }
    expect(listener.getTelemetry().lastFeedGap?.reason).not.toBe('NO_DELIVERY');
    expect(fresh.onLogs).not.toHaveBeenCalled();
    listener.destroy();
  });

  it('each try that delivers nothing doubles the wait (capped); from the third the status is ERROR; a delivery clears it', async () => {
    vi.useFakeTimers();
    const fresh = spyFresh(true); // every fresh Connection confirms both subscriptions, then delivers nothing
    const f = fakeConn();
    const listener = new PumpFeedListener(f.conn);
    await listener.start();
    f.state(7, 'subscribed');
    f.state(8, 'subscribed');
    await tick(FEED_NO_DELIVERY_MS + 2 * FEED_HEARTBEAT_CHECK_MS);
    expect(fresh.onLogs).toHaveBeenCalledTimes(1);
    expect(listener.getTelemetry().noDeliveryTries).toBe(1);
    // try 2 waits twice as long
    await tick(FEED_NO_DELIVERY_MS + 2 * FEED_HEARTBEAT_CHECK_MS);
    expect(fresh.onLogs).toHaveBeenCalledTimes(1);
    await tick(FEED_NO_DELIVERY_MS);
    expect(fresh.onLogs).toHaveBeenCalledTimes(2);
    expect(listener.getTelemetry().noDeliveryTries).toBe(2);
    expect(listener.getTelemetry().status).not.toBe('ERROR');
    // try 3 waits four times as long
    await tick(4 * FEED_NO_DELIVERY_MS + 2 * FEED_HEARTBEAT_CHECK_MS);
    expect(fresh.onLogs).toHaveBeenCalledTimes(3);
    expect(listener.getTelemetry().noDeliveryTries).toBe(FEED_NO_DELIVERY_TRIES_BEFORE_ERROR);
    expect(listener.getTelemetry().status).toBe('ERROR');
    // later waits: 120 s, 240 s, then the 300 s cap (480 s and up are capped); each measured from the move, judged every 2 s
    await tick(120_000 + 240_000 + 2 * FEED_NO_DELIVERY_MAX_WAIT_MS + 10 * FEED_HEARTBEAT_CHECK_MS);
    const waits = fresh.times.slice(2).map((t, i) => fresh.times[i + 3] - t).filter((x) => !Number.isNaN(x));
    const want = [120_000, 240_000, FEED_NO_DELIVERY_MAX_WAIT_MS, FEED_NO_DELIVERY_MAX_WAIT_MS];
    expect(waits.slice(0, 4)).toHaveLength(4);
    waits.slice(0, 4).forEach((w, i) => { expect(w).toBeGreaterThan(want[i]); expect(w).toBeLessThanOrEqual(want[i] + 2 * FEED_HEARTBEAT_CHECK_MS); });
    expect(listener.getTelemetry().status).toBe('ERROR');
    const last = fresh.onLogs.mock.contexts.at(-1) as any;
    fresh.slotCbs.filter((s) => s.conn === last).at(-1)!.fn({ slot: 900, parent: 899, root: 899 });
    expect(listener.getTelemetry().noDeliveryTries).toBe(0);
    expect(listener.getTelemetry().status).toBe('ACTIVE');
    listener.destroy();
  });

  it('a Connection the watchdog made has its socket closed for good when the listener leaves it; the coordinator\'s is left alone', async () => {
    vi.useFakeTimers();
    const fresh = spyFresh();
    const f = fakeConn();
    const listener = new PumpFeedListener(f.conn);
    await listener.start();
    f.state(7, 'subscribed');
    f.state(8, 'subscribed');
    await tick(FEED_NO_DELIVERY_MS + 2 * FEED_HEARTBEAT_CHECK_MS);
    expect(f.socket.close).not.toHaveBeenCalled(); // the coordinator's Connection: not the watchdog's to close
    const first = fresh.onLogs.mock.contexts[0] as any;
    const close = vi.spyOn(first._rpcWebSocket, 'close');
    const noReconnect = vi.spyOn(first._rpcWebSocket, 'setAutoReconnect');
    // an RPC switch moves it to the coordinator's new Connection: the watchdog's Connection is closed, the tries start over
    const g = fakeConn();
    await listener.switchConnection(g.conn);
    expect(noReconnect).toHaveBeenCalledWith(false);
    expect(close).toHaveBeenCalled();
    expect(listener.getTelemetry().noDeliveryTries).toBe(0);
    expect(listener.getTelemetry().lastFeedGap?.reason).toBe('ENDPOINT_SWITCH');
    listener.destroy();
  });
});
