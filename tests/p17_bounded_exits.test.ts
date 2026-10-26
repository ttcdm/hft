import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ExecutionCoordinator, EXIT_SELL_WAIT_MS, executionCoordinator } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { workstationDb } from '../server/db/database';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { isDefiniteSendRejection } from '../server/solana/transports';
import { boundedRpcFetch, SLOW_READ_TIMEOUT_MS } from '../server/solana/rpcConnection';
import { executionConfig } from '../server/solana/executionConfig';
import { CLUSTER_GENESIS_HASH, assertClusterAllowedCached } from '../server/solana/clusterGuard';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { settleLeftoverLiveBuys } from './helpers/leftoverBuys';

/**
 * P1.7 (R1-71, R1-32): exits that do not wait on each other, and a trading Connection whose calls are bounded.
 * Real ExecutionCoordinator, ExitEngine, transaction builder, transports and SQLite. The doubles are the Connection (MockSolanaRpc, or
 * globalThis.fetch under the real web3.js Connection), the signer, and the venue/curve/reconcile edges the other LIVE exit suites stub.
 */
const ENTRY = 0.0001;

describe('P1.7: one hung sell does not hold another position\'s stop-loss', () => {
  let coordinator: ExecutionCoordinator;
  let rpc: MockSolanaRpc;
  let conn: any;

  const mkPosition = (tag: string, priceSol: number, entryTimestamp: number, mint = Keypair.generate().publicKey.toBase58()) => {
    const id = `p17_${tag}_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint, symbol: tag, name: tag, tokenDecimals: 6, tokenQuantityRaw: '1000000000', entryPriceSol: ENTRY, currentPriceSol: priceSol,
      currentValueSol: 0.1, costBasisLamports: 100_000_000, realizedPnLSol: 0, status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE',
      entryTxSignature: `sig_${id}`, entryTimestamp, lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    return id;
  };

  /** getLatestBlockhash hangs on its first call (the first sell to build) until released; later calls answer normally. */
  const hangFirstBlockhash = () => {
    let release!: () => void;
    let reached!: () => void;
    const hung = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const real = conn.getLatestBlockhash;
    let calls = 0;
    vi.spyOn(conn, 'getLatestBlockhash').mockImplementation(async (...args: any[]) => {
      if (++calls === 1) { reached(); await gate; }
      return real(...args);
    });
    return { hung, release };
  };

  beforeEach(async () => {
    settleLeftoverLiveBuys();
    for (const p of workstationDb.loadPositions(undefined, 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0', costBasisLamports: 0 } as any);
    const kp = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    const realConfig = executionConfig.getConfig.bind(executionConfig);
    vi.spyOn(executionConfig, 'getConfig').mockImplementation(() => ({ ...realConfig(), jitoBlockEngineUrl: '' })); // RPC only, as on devnet
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    rpc = new MockSolanaRpc();
    const realInit = (ExecutionCoordinator.prototype as any).initializeConnection;
    let initDone: Promise<unknown> = Promise.resolve();
    vi.spyOn(ExecutionCoordinator.prototype as any, 'initializeConnection').mockImplementation(function (this: any) {
      initDone = Promise.resolve(realInit.call(this));
      return initDone;
    });
    coordinator = new ExecutionCoordinator(rpc.createConnection());
    await initDone;
    coordinator.cleanup(); // no 3 s exit loop: each test runs its own passes
    conn = coordinator.getConnection();
    // the marks written on the rows are the marks the pass decides on
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '1000000000', tokensSoldHuman: 1000, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 50_000_000, actualNetSolProceedsLamports: 49_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: -0.05, remainingTokensRaw: '0', isFullyClosed: true, slot: 6,
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
    coordinator.cleanup();
    rpc.clear();
  });

  it("A's sell hangs in getLatestBlockhash; B at -25% gets closePosition(B, 100, 'STOP_LOSS') and its sell completes before A settles", async () => {
    const t = Date.now();
    const a = mkPosition('A', ENTRY * 1.5, t);          // +50%: TAKE_PROFIT_1, loaded first (newest entry)
    const b = mkPosition('B', ENTRY * 0.75, t - 60_000); // -25%: STOP_LOSS
    const { hung, release } = hangFirstBlockhash();
    const order: string[] = [];
    const close = vi.spyOn(coordinator, 'closePosition');
    close.mockImplementation(function (this: any, id: string, pct?: number, reason?: string) {
      order.push(`${id === a ? 'A' : id === b ? 'B' : id}:${reason}`);
      return (ExecutionCoordinator.prototype.closePosition as any).call(coordinator, id, pct, reason);
    } as any);
    let aSettled = false;

    const pass = coordinator.evaluateAndProcessExits();
    await hung; // A's sell is stuck building its transaction
    expect(order).toEqual(['A:TAKE_PROFIT_1', 'B:STOP_LOSS']);
    expect(close.mock.calls[1]).toEqual([b, 100, 'STOP_LOSS']);
    const aRes = close.mock.results[0].value as Promise<any>;
    void aRes.then(() => { aSettled = true; });
    const bRes = await (close.mock.results[1].value as Promise<any>);
    expect(bRes.success, bRes.error).toBe(true);
    expect(workstationDb.loadPositions().find((p) => p.id === b)!.status).toBe('CLOSED');
    expect(aSettled).toBe(false);
    expect(workstationDb.loadPositions().find((p) => p.id === a)!.status).toBe('OPEN');

    // the per-position exit promise: B has none left, A's is pending until its sell ends
    await coordinator.waitForPositionExit(b);
    let aWaited = false;
    const aWait = coordinator.waitForPositionExit(a).then(() => { aWaited = true; });
    await Promise.resolve();
    expect(aWaited).toBe(false);

    release();
    expect((await aRes).success).toBe(true);
    await aWait;
    expect(aWaited).toBe(true);
    await pass;
  });

  it('the pass ends at its deadline while a sell hangs; the next pass neither waits for it nor sends it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = mkPosition('A', ENTRY * 1.5, Date.now());
    const { hung, release } = hangFirstBlockhash();
    const close = vi.spyOn(coordinator, 'closePosition');
    let passDone = false;
    const pass = coordinator.evaluateAndProcessExits().then(() => { passDone = true; });
    await hung;
    expect(passDone).toBe(false);
    await vi.advanceTimersByTimeAsync(EXIT_SELL_WAIT_MS);
    await pass;
    expect(passDone).toBe(true);

    await coordinator.evaluateAndProcessExits(); // A is still being sold: skipped, nothing to wait for
    expect(close).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    release();
    await coordinator.waitForPositionExit(a);
    expect(workstationDb.loadPositions().find((p) => p.id === a)!.status).toBe('CLOSED'); // the stubbed reconcile reports the wallet empty
  });

  it('waitForPositionExit resolves at once when no exit of that position is running', async () => {
    let done = false;
    await coordinator.waitForPositionExit('no-such-position').then(() => { done = true; });
    expect(done).toBe(true);
  });

  it('while a panic is active the pass sends only protective exits (the haltAll set); clearing it lets the take-profit run', async () => {
    const t = Date.now();
    const tp = mkPosition('TP', ENTRY * 1.5, t);
    const sl = mkPosition('SL', ENTRY * 0.75, t - 60_000);
    const close = vi.spyOn(coordinator, 'closePosition');
    expect(coordinator.isPanicActive()).toBe(false);
    coordinator.setPanicActive(true);
    expect(coordinator.isPanicActive()).toBe(true);
    await coordinator.evaluateAndProcessExits();
    expect(close.mock.calls).toEqual([[sl, 100, 'STOP_LOSS']]);
    expect(workstationDb.loadPositions().find((p) => p.id === tp)!.status).toBe('OPEN');

    coordinator.setPanicActive(false);
    expect(coordinator.isPanicActive()).toBe(false);
    await coordinator.evaluateAndProcessExits();
    expect(close.mock.calls[1]).toEqual([tp, 33, 'TAKE_PROFIT_1']);
  });
});

describe('P1.7: the trading Connection bounds every call', () => {
  /** A JSON-RPC answer to the request in `init` (web3.js checks that the id matches). */
  const reply = (init: any, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  const answers = (result: unknown) => async (_input: any, init: any) => reply(init, result);
  const blockhash = { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } };
  const methodOf = (init: any) => JSON.parse(String(init?.body)).method;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('a 429 on getLatestBlockhash is retried once at once: exactly 2 attempts and no sleep', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }))
      .mockImplementationOnce(answers(blockhash));
    const r = await executionCoordinator.getConnection().getLatestBlockhash();
    expect(r.blockhash).toBe(blockhash.value.blockhash);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([, init]) => methodOf(init))).toEqual(['getLatestBlockhash', 'getLatestBlockhash']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('two 429s fail the read after 2 attempts; a 429 on a send is not retried', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }));
    const conn = executionCoordinator.getConnection();
    await expect(conn.getLatestBlockhash()).rejects.toThrow(/429/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockClear();
    await expect(conn.sendRawTransaction(Buffer.alloc(8), { skipPreflight: true })).rejects.toThrow(/429/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a request that never answers is aborted: a read gets 2 tries, a send 1, and the send error stays ambiguous', async () => {
    vi.stubEnv('RPC_REQUEST_TIMEOUT_MS', '20');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input: any, init: any) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const c = new ExecutionCoordinator(true); // a fresh coordinator builds its Connection with the stubbed timeout; nothing is started
    const conn = c.getConnection();
    await expect(conn.getLatestBlockhash()).rejects.toThrow(/RPC_TIMEOUT: getLatestBlockhash got no answer within 20 ms/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockClear();
    const err = await conn.sendRawTransaction(Buffer.alloc(8), { skipPreflight: true }).catch((e) => e);
    expect(String(err?.message)).toMatch(/RPC_TIMEOUT: sendTransaction/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(isDefiniteSendRejection(err)).toBe(false);
  });

  it('a slow scan no sell waits on gets the longer bound, not the hot-path one', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input: any, init: any) => new Promise<Response>((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const call = (method: string) => boundedRpcFetch(20)('http://rpc.invalid', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
    let scanDone = false;
    const scan = call('getSignaturesForAddress').catch((e) => { scanDone = true; return e; });
    const hot = call('getLatestBlockhash').catch((e) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(String((await hot)?.message)).toMatch(/within 20 ms/); // the hot-path read was aborted (both tries)
    expect(scanDone).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * SLOW_READ_TIMEOUT_MS);
    expect(String((await scan)?.message)).toMatch(new RegExp(`getSignaturesForAddress got no answer within ${SLOW_READ_TIMEOUT_MS} ms`));
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('setRpcEndpoint swaps in a bounded Connection, and that is the one the send-path genesis check has passed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init: any) => {
      const m = methodOf(init);
      if (m === 'getGenesisHash') return reply(init, CLUSTER_GENESIS_HASH.devnet);
      if (m === 'getSlot') return reply(init, 42);
      if (m === 'getBalance') return reply(init, { context: { slot: 1 }, value: 0 });
      return reply(init, blockhash);
    });
    const c = new ExecutionCoordinator(true);
    const old = c.getConnection();
    const res = await c.setRpcEndpoint('http://127.0.0.1:9');
    expect(res.success, res.error).toBe(true);
    const fresh = c.getConnection();
    expect(fresh).not.toBe(old);
    fetchSpy.mockClear();
    await assertClusterAllowedCached(fresh); // remembered by setRpcEndpoint: no new genesis read
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(new Response('rate limited', { status: 429 })).mockImplementationOnce(answers(blockhash));
    vi.useFakeTimers();
    await fresh.getLatestBlockhash();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
