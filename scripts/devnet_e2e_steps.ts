/**
 * Steps (d') and (e') of the devnet harness (`scripts/devnet_e2e.ts`, P1.2 / R1-122). Both go through the app's own
 * `executionCoordinator.executeTrade`, so the app's handling of a revert and of a second buy is what is checked, not a transaction the
 * harness signed itself.
 *
 *  (d') forced revert: for one `executeTrade` call the harness wraps `PumpCurveService.calculateBuyQuote` so the quote's
 *       `maxInputLamports` (the max-SOL-in bound the pump buy enforces, its slippage limit) is 1 lamport. The app builds, signs and sends
 *       that buy; the program rejects it on chain. Expected: lifecycle REVERTED, the signature failed on chain, a REVERTED transaction row,
 *       no position, and an immediate second buy refused by the 15 s failure cooldown with nothing sent. The wrapper is restored in `finally`.
 *  (e') two sequential `executeTrade` calls on one mint: the first is CONFIRMED and opens one position, the second is refused before
 *       anything is signed (POSITION_ALREADY_OPEN). The position is then closed so step (f) starts flat.
 *  (e''), (g), (h), (i), (j) and (k) are described at their functions below.
 *
 *  (e''') P1.4: the emergency stop. One LIVE position is opened, auto is set to DEVNET_LIVE, then Telegram `/panic_sell` is driven
 *       through the app's `processTelegramCommand` (no bot): the LIVE position must be sold on chain and auto must end OFF. Then the
 *       kill switch is tripped (the function the kill-switch route runs), reset, and LIVE re-armed: auto must not be DEVNET_LIVE and a
 *       candidate must be dropped as AUTO_OFF, never BOUGHT.
 *
 * Kept apart from devnet_e2e.ts so the steps can be read on their own; they take every dependency as an argument and import nothing
 * from server/ themselves, so the harness's environment setup still runs before any server module loads.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ExecuteTradeRequest, ExecutionResponse } from '../server/execution/coordinator';

type Tx = { signature: string; orderId: string; direction: string; reconciliationState: string; mint: string };
type Pos = { id: string; mint: string; status: string };

export interface HarnessSteps {
  coordinator: {
    executeTrade(req: ExecuteTradeRequest): Promise<ExecutionResponse>;
    closePosition(id: string, pct: number, reason: string): Promise<{ success: boolean; error?: string }>;
    syncRealWalletBalance(): Promise<unknown>;
    /** (g) points the coordinator at the loopback proxy and back. */
    setRpcEndpoint?(url: string): Promise<{ success: boolean; error?: string }>;
  };
  /** (g) the RPC the coordinator uses normally (the proxy forwards to it). */
  rpcUrl?: string;
  /** The PumpCurveService class itself (its static `calculateBuyQuote` is wrapped for one call). */
  curve: { calculateBuyQuote: (...args: any[]) => any };
  db: { loadTransactions(orderId?: string): Tx[]; loadPositions(): Pos[] };
  riskLimits: () => { cooldownAfterFailedTradeMs: number; cooldownPerMintMs: number };
  /** A signature's on-chain error (readChainErr): undefined when no read gave an answer, null when it succeeded. */
  chainErr: (sig: string) => Promise<unknown | undefined>;
  mint: string;
  buildBuyRequest: () => Promise<ExecuteTradeRequest>;
  rec: (step: string, ok: boolean, detail: string) => void;
  link: (sig: string) => string;
  sleep: (ms: number) => Promise<unknown>;
  /** The coordinator's own Connection: (e'') wraps its `sendRawTransaction` for one call, (h) its `getMultipleAccountsInfo`. */
  connection?: { sendRawTransaction: (...args: any[]) => Promise<string>; getMultipleAccountsInfo?: (...args: any[]) => Promise<unknown> };
  /** (e''') P1.4: the app's own singletons for the panic and kill-switch step. */
  stop?: {
    telegram: { processTelegramCommand(text: string): Promise<{ reply: string; actionTaken?: string }> };
    /** What POST /api/execution/kill-switch {activate:true} runs. */
    emergencyStop(opts: { exitAll: boolean; reason?: string }): Promise<{ autoStopped: boolean }>;
    setKillSwitch(on: boolean): void;
    arm(arm: boolean, code?: string): { success: boolean; message: string };
    auto: {
      setMode(mode: 'OFF' | 'SHADOW' | 'PAPER' | 'DEVNET_LIVE', opts?: { confirmationCode?: string }): Promise<{ ok: boolean; mode: string; error?: string }>;
      getStatus(): { mode: string; killed: boolean };
      submitCandidate(c: { mint: string; source: 'TEST'; provenance?: 'REAL_ONCHAIN' }): Promise<{ outcome: string; reason: string }>;
    };
  };
}

const openFor = (s: HarnessSteps) => s.db.loadPositions().filter((p) => p.mint === s.mint && p.status !== 'CLOSED');
const buyRowsFor = (s: HarnessSteps) => s.db.loadTransactions().filter((t) => t.mint === s.mint && t.direction === 'BUY');

/** Waits until `sinceMs + ms + 1 s` (harness pacing between steps, not an assertion). */
export async function waitPast(s: HarnessSteps, sinceMs: number, ms: number, why: string): Promise<void> {
  const left = sinceMs + ms + 1000 - Date.now();
  if (left > 0) {
    console.log(`INFO  waiting ${Math.ceil(left / 1000)} s (${why})`);
    await s.sleep(left);
  }
}

/** (d'). Returns the time the revert was recorded (for the cooldown wait before (e')). */
export async function forcedRevertThroughApp(s: HarnessSteps): Promise<number> {
  const L = "(d') forced revert through executeTrade";
  await s.coordinator.syncRealWalletBalance();
  const req = await s.buildBuyRequest();
  const rowsBefore = new Set(buyRowsFor(s).map((t) => t.signature));
  const orig = s.curve.calculateBuyQuote;
  let wrapped = 0;
  s.curve.calculateBuyQuote = function (this: unknown, ...args: any[]) {
    const q = orig.apply(this, args);
    wrapped++;
    return { ...q, maxInputLamports: 1 };
  };
  let r: ExecutionResponse;
  try {
    r = await s.coordinator.executeTrade(req);
  } finally {
    s.curve.calculateBuyQuote = orig;
  }
  const failedAt = Date.now();
  const sig = r.txSignature || r.signature || '';
  s.rec(`${L}: quote wrapper used`, wrapped > 0, `calculateBuyQuote wrapped for ${wrapped} call(s), restored`);
  s.rec(`${L}: lifecycle REVERTED`, !r.success && r.lifecycleState === 'REVERTED' && !!sig, `${r.lifecycleState} ${r.error ?? ''}`.slice(0, 300));
  if (sig) {
    const err = await s.chainErr(sig);
    s.rec(`${L}: failed on chain`, err !== undefined && err !== null, `${s.link(sig)} ${err === undefined ? 'on-chain error not read (getTransaction and getSignatureStatuses gave no answer after retries)' : `err=${JSON.stringify(err)}`}`);
  }
  const newRows = buyRowsFor(s).filter((t) => !rowsBefore.has(t.signature));
  s.rec(
    `${L}: REVERTED transaction row`,
    newRows.length > 0 && newRows.every((t) => t.reconciliationState === 'REVERTED') && newRows.some((t) => t.signature === sig),
    JSON.stringify(newRows.map((t) => ({ sig: t.signature.slice(0, 12), state: t.reconciliationState })))
  );
  const open = openFor(s);
  s.rec(`${L}: no position`, open.length === 0, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status }))));

  // The cooldown: an immediate second buy of the same mint is refused by the risk engine and sends nothing.
  const cooldownMs = s.riskLimits().cooldownAfterFailedTradeMs;
  const probe = await s.coordinator.executeTrade(await s.buildBuyRequest());
  const m = /Cooling down after recent execution failure \((\d+)s remaining\)/.exec(probe.error ?? '');
  const remaining = m ? Number(m[1]) : NaN;
  const rowsAfterProbe = buyRowsFor(s).filter((t) => !rowsBefore.has(t.signature)).length;
  s.rec(
    `${L}: ${cooldownMs / 1000} s cooldown`,
    cooldownMs === 15_000 && !probe.success && remaining > 0 && remaining <= 15 && rowsAfterProbe === newRows.length,
    `cooldownAfterFailedTradeMs=${cooldownMs}; second buy: ${probe.lifecycleState} ${probe.error ?? ''}; BUY rows ${newRows.length} -> ${rowsAfterProbe}`.slice(0, 300)
  );
  return failedAt;
}

/** (e'). */
export async function sequentialBuysOneMint(s: HarnessSteps): Promise<number> {
  const L = "(e') two sequential executeTrade on one mint";
  await s.coordinator.syncRealWalletBalance();
  const rowsBefore = new Set(buyRowsFor(s).map((t) => t.signature));
  const first = await s.coordinator.executeTrade(await s.buildBuyRequest());
  s.rec(`${L}: first CONFIRMED`, first.success && first.lifecycleState === 'CONFIRMED', `${first.lifecycleState} ${first.error ?? ''} ${first.txSignature ? s.link(first.txSignature) : ''}`.slice(0, 300));
  const afterFirst = buyRowsFor(s).filter((t) => !rowsBefore.has(t.signature)).length;
  const second = await s.coordinator.executeTrade(await s.buildBuyRequest());
  const newRows = buyRowsFor(s).filter((t) => !rowsBefore.has(t.signature));
  s.rec(
    `${L}: second refused, nothing sent`,
    !second.success && /POSITION_ALREADY_OPEN|DUPLICATE_MINT|UNRESOLVED_BUY/.test(second.error ?? '') && newRows.length === afterFirst,
    `${second.lifecycleState} ${second.error ?? ''}; BUY rows ${afterFirst} -> ${newRows.length}`.slice(0, 300)
  );
  const open = openFor(s);
  s.rec(`${L}: exactly one open position`, open.length === 1, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status }))));
  for (const p of open) {
    const c = await s.coordinator.closePosition(p.id, 100, "e2e (e') cleanup");
    s.rec(`${L}: cleanup close 100%`, c.success, c.error || 'closed');
  }
  return Date.now();
}

/**
 * (e'') P1.5 (R1-2): an ambiguous send. For one call the harness wraps the coordinator's `connection.sendRawTransaction` so the transaction
 * is really sent (it reaches devnet) and then the call throws, as a socket reset after forwarding does. Expected: no REVERTED row for that
 * signature, and the landed buy gets a position in this same process (no restart), which is then closed so the next step starts flat.
 */
export async function ambiguousSendThroughApp(s: HarnessSteps): Promise<void> {
  const L = "(e'') ambiguous send through executeTrade";
  if (!s.connection) { s.rec(L, false, 'harness did not pass the coordinator connection'); return; }
  await s.coordinator.syncRealWalletBalance();
  const conn = s.connection;
  const orig = conn.sendRawTransaction;
  let forwarded = '';
  conn.sendRawTransaction = async function (this: unknown, ...args: any[]) {
    conn.sendRawTransaction = orig; // one call only
    forwarded = await orig.apply(this, args);
    throw new Error('fetch failed (harness: injected after the transaction was forwarded)');
  };
  let res: ExecutionResponse;
  try {
    res = await s.coordinator.executeTrade(await s.buildBuyRequest());
  } finally {
    conn.sendRawTransaction = orig;
  }
  s.rec(`${L}: the transaction was forwarded`, forwarded !== '', forwarded ? s.link(forwarded) : 'the app never reached the send');
  s.rec(`${L}: not REVERTED`, res.lifecycleState !== 'REVERTED' && res.lifecycleState !== 'SUBMIT_FAILED', `${res.lifecycleState} ${res.error ?? ''}`.slice(0, 300));
  const rows = s.db.loadTransactions().filter((t) => t.signature === forwarded);
  s.rec(`${L}: no REVERTED row for it`, rows.length > 0 && rows.every((t) => t.reconciliationState !== 'REVERTED'), JSON.stringify(rows.map((t) => ({ state: t.reconciliationState }))));
  let open = openFor(s);
  for (let i = 0; i < 40 && open.length === 0; i++) { await s.sleep(1500); open = openFor(s); } // orphan recovery runs 5 s, 15 s, 45 s after
  s.rec(`${L}: one position in the same process`, open.length === 1, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status }))));
  for (const p of open) {
    const c = await s.coordinator.closePosition(p.id, 100, "e2e (e'') cleanup");
    s.rec(`${L}: cleanup close 100%`, c.success, c.error || 'closed');
  }
}

/**
 * A loopback JSON-RPC proxy in front of `upstream` for (g). The first getLatestBlockhash it sees is held: no reply for `holdMs`, then the
 * socket is closed. Everything else is forwarded as is.
 */
export async function startHoldingProxy(upstream: string, holdMs: number) {
  const st = { blockhashCalls: 0, held: 0, holdOpen: false };
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let method = '';
      try { method = String(JSON.parse(body)?.method ?? ''); } catch { /* a batch or junk: forward it */ }
      if (method === 'getLatestBlockhash') {
        st.blockhashCalls++;
        if (st.held === 0) {
          st.held++;
          st.holdOpen = true;
          const t = setTimeout(() => { st.holdOpen = false; timers.delete(t); res.destroy(); }, holdMs);
          timers.add(t);
          return;
        }
      }
      try {
        const up = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' }).end(await up.text());
      } catch {
        res.writeHead(502).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    st,
    close: () => new Promise<void>((r) => { for (const t of timers) clearTimeout(t); st.holdOpen = false; server.closeAllConnections(); server.close(() => r()); }),
  };
}

/**
 * (g) P1.7 (R1-71): a getLatestBlockhash that hangs does not hang the stop-loss. The coordinator is pointed (setRpcEndpoint, which also
 * runs the genesis check through the proxy) at a loopback proxy in front of the normal RPC that holds the first getLatestBlockhash for
 * 20 s. One buy opens a position, then closePosition(STOP_LOSS) must send and confirm while that request is still held: the trading
 * Connection aborts it after RPC_REQUEST_TIMEOUT_MS and asks again. The two-position form (B's stop sells while A's sell is held) is
 * tests/long/exit_concurrency.longtest.ts on localnet; this harness trades one mint.
 */
export async function heldBlockhashStopLoss(s: HarnessSteps, holdMs = 20_000): Promise<void> {
  const L = '(g) held getLatestBlockhash, stop-loss still sends';
  if (!s.coordinator.setRpcEndpoint || !s.rpcUrl) { s.rec(L, false, 'harness did not pass setRpcEndpoint and rpcUrl'); return; }
  await s.coordinator.syncRealWalletBalance();
  const buy = await s.coordinator.executeTrade(await s.buildBuyRequest());
  s.rec(`${L}: buy CONFIRMED`, buy.success && buy.lifecycleState === 'CONFIRMED', `${buy.lifecycleState} ${buy.error ?? ''}`.slice(0, 300));
  const open = openFor(s);
  if (open.length !== 1) { s.rec(`${L}: one open position`, false, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status })))); return; }
  const proxy = await startHoldingProxy(s.rpcUrl, holdMs);
  try {
    const sw = await s.coordinator.setRpcEndpoint(proxy.url);
    s.rec(`${L}: coordinator on the loopback proxy`, sw.success, sw.error ?? proxy.url);
    if (!sw.success) return;
    const c = await s.coordinator.closePosition(open[0].id, 100, 'STOP_LOSS');
    const stillHeld = proxy.st.holdOpen;
    s.rec(`${L}: STOP_LOSS sold`, c.success, c.error || 'closed');
    s.rec(
      `${L}: it went out while the held request was still open`,
      c.success && proxy.st.held === 1 && stillHeld && proxy.st.blockhashCalls >= 2,
      `held=${proxy.st.held} still open at return=${stillHeld} getLatestBlockhash calls=${proxy.st.blockhashCalls}`
    );
  } finally {
    const back = await s.coordinator.setRpcEndpoint(s.rpcUrl);
    s.rec(`${L}: coordinator back on its RPC`, back.success, back.error ?? 'ok');
    await proxy.close();
    for (const p of openFor(s)) {
      const c = await s.coordinator.closePosition(p.id, 100, 'e2e (g) cleanup');
      s.rec(`${L}: cleanup close 100%`, c.success, c.error || 'closed');
    }
  }
}

/** (e''') P1.4. Leaves LIVE disarmed, auto OFF and nothing open. */
export async function emergencyStopThroughApp(s: HarnessSteps): Promise<void> {
  const L = "(e''') P1.4 emergency stop";
  if (!s.stop) { s.rec(L, false, 'harness did not pass the stop dependencies'); return; }
  const st = s.stop;
  const ARM = 'CONFIRM_LIVE_TRADING_RISK';
  const prevAuto = process.env.AUTO_SNIPE_ENABLED;
  process.env.AUTO_SNIPE_ENABLED = 'true'; // for this step only: nothing in the harness feeds the controller candidates except the probe below
  try {
    await s.coordinator.syncRealWalletBalance();
    const buy = await s.coordinator.executeTrade(await s.buildBuyRequest());
    s.rec(`${L}: LIVE buy CONFIRMED`, buy.success && buy.lifecycleState === 'CONFIRMED', `${buy.lifecycleState} ${buy.error ?? ''} ${buy.txSignature ? s.link(buy.txSignature) : ''}`.slice(0, 300));
    const live = await st.auto.setMode('DEVNET_LIVE', { confirmationCode: 'CONFIRM_AUTO_DEVNET' });
    s.rec(`${L}: auto DEVNET_LIVE set`, live.ok, live.error || live.mode);

    const sellsBefore = new Set(s.db.loadTransactions().filter((t) => t.direction === 'SELL').map((t) => t.signature));
    const tg = await st.telegram.processTelegramCommand('/panic_sell');
    s.rec(`${L}: Telegram /panic_sell reply`, tg.actionTaken === 'PANIC_SELL_EXECUTED' && /EMERGENCY DUMP COMPLETE/.test(tg.reply), tg.reply.replace(/\n/g, ' | ').slice(0, 300));
    const sells = s.db.loadTransactions().filter((t) => t.direction === 'SELL' && t.mint === s.mint && !sellsBefore.has(t.signature));
    const sig = sells[0]?.signature;
    const err = sig ? await s.chainErr(sig) : undefined;
    s.rec(`${L}: panic SELL landed on chain`, !!sig && err === null, sig ? `${s.link(sig)} err=${JSON.stringify(err)}` : 'no SELL row for the mint');
    const open = openFor(s);
    s.rec(`${L}: LIVE position CLOSED`, open.length === 0, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status }))));
    const a1 = st.auto.getStatus();
    s.rec(`${L}: auto OFF and killed after the panic`, a1.mode === 'OFF' && a1.killed, `mode=${a1.mode} killed=${a1.killed}`);

    // kill switch on, off, re-arm: no auto buy follows
    st.setKillSwitch(false);
    const rearm1 = st.arm(true, ARM);
    const live2 = rearm1.success ? await st.auto.setMode('DEVNET_LIVE', { confirmationCode: 'CONFIRM_AUTO_DEVNET' }) : { ok: false, mode: '?', error: rearm1.message };
    s.rec(`${L}: re-armed and DEVNET_LIVE set again`, rearm1.success && live2.ok, live2.error || live2.mode);
    const buysBefore = s.db.loadTransactions().filter((t) => t.direction === 'BUY').length;
    const ks = await st.emergencyStop({ exitAll: false, reason: 'devnet e2e kill switch' });
    st.setKillSwitch(false);
    const rearm2 = st.arm(true, ARM);
    const a2 = st.auto.getStatus();
    s.rec(`${L}: kill switch on, off, re-arm: auto not DEVNET_LIVE`, ks.autoStopped && rearm2.success && a2.mode !== 'DEVNET_LIVE', `autoStopped=${ks.autoStopped} rearm=${rearm2.success} mode=${a2.mode}`);
    const d = await st.auto.submitCandidate({ mint: s.mint, source: 'TEST', provenance: 'REAL_ONCHAIN' });
    s.rec(`${L}: a candidate is not BOUGHT`, d.outcome !== 'BOUGHT' && d.reason === 'AUTO_OFF', `${d.outcome} ${d.reason}`);
    const buysAfter = s.db.loadTransactions().filter((t) => t.direction === 'BUY').length;
    s.rec(`${L}: no BUY after the re-arm`, buysAfter === buysBefore && openFor(s).length === 0, `BUY rows ${buysBefore} -> ${buysAfter}; open ${openFor(s).length}`);
  } finally {
    st.arm(false);
    await st.auto.setMode('OFF');
    if (prevAuto === undefined) delete process.env.AUTO_SNIPE_ENABLED; else process.env.AUTO_SNIPE_ENABLED = prevAuto;
  }
}

/** (h) the harness's own market moves: a second throwaway wallet that creates a coin, seeds it, and dumps it. Signs only its own wallets. */
export interface DumpMarket {
  /** The second wallet's address and the file its key is kept in (the harness's scratch directory). */
  readonly address: string;
  readonly keyPath: string;
  /**
   * Funds the second wallet with enough for the create, creates a pump coin from it, reads the coin's own curve, sizes the seed with
   * `dumpSeedPlan` for an app buy of `appBuySol`, funds it and buys that much. Throws (after any funding, which `refund` returns) when the
   * plan refuses, for example a seed above `maxSeedSol` or a curve that would come too close to complete.
   */
  createAndSeed(opts: { appBuySol: number; maxSeedSol: number }): Promise<{ mint: string; curve: string; seedSol: number; projectedRatio: number }>;
  /** Spot price in SOL per UI token, from the curve as a separate Connection sees it. */
  priceSol(mint: string): Promise<number>;
  /** The second wallet sells everything it holds of `mint`; null when it holds none. */
  sellAll(mint: string): Promise<string | null>;
  /**
   * Sells what the second wallet still holds of every coin it created (recorded next to its key), then sends what is left back to the
   * harness wallet. Safe to call more than once and at the start of a run, which recovers what an earlier run left behind.
   */
  refund(): Promise<void>;
}

/**
 * The harness's own chain moves on any cluster, for any throwaway keypair it holds: built from the app's own quote math and transaction
 * builder (passed in, so this file still imports nothing from server/). Used by (h)'s DumpMarket and by (i).
 */
export interface ChainKit {
  newWallet(): any;
  transfer(from: any, to: any, sol: number): Promise<string>;
  /** create_v2 by `creator` (who also pays), no dev buy. */
  create(creator: any, symbol: string, name: string): Promise<{ mint: string; curve: string }>;
  buy(kp: any, mint: string, sol: number): Promise<string>;
  /** Sells everything `kp` holds of `mint`; null when it holds none. */
  sellAll(kp: any, mint: string): Promise<string | null>;
  /** Spot price in SOL per UI token, from the curve. */
  priceSol(mint: string): Promise<number>;
  /** The curve's state as the app reads it (PumpMarketState). */
  curveState(mint: string): Promise<{ virtualSolReserves: bigint; virtualTokenReserves: bigint; realTokenReserves: bigint; complete?: boolean }>;
  /** Sends what is left in `kp` (less one fee) to `to`. */
  refund(kp: any, to: any): Promise<void>;
}

export function makeChainKit(d: { conn: any; web3: any; sdk: any; curve: any; builder: any }): ChainKit {
  const { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = d.web3;
  const send = async (tx: any, signers: any[]) => {
    tx.recentBlockhash = (await d.conn.getLatestBlockhash('confirmed')).blockhash;
    if (!tx.feePayer) tx.feePayer = signers[0].publicKey;
    if ('version' in tx) tx.sign(signers); else tx.sign(...signers);
    let sig: string;
    try {
      sig = await d.conn.sendRawTransaction(tx.serialize());
    } catch (e: any) { // a simulation failure: say why (the program's last log lines), not only "Simulation failed"
      const logs: string[] = Array.isArray(e?.logs) ? e.logs : [];
      throw new Error(`${String(e?.message ?? e).replace(/Catch the `SendTransactionError`[^.]*\./, '').replace(/\s+/g, ' ').trim()}${logs.length ? ` logs: ${logs.slice(-3).join(' | ')}` : ''}`);
    }
    for (let i = 0; i < 120; i++) { // polls the status (no websocket subscription), up to 60 s
      const st = (await d.conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`tx ${sig} not confirmed in 60 s`);
  };
  const state = async (mint: any) => {
    const s = await d.curve.fetchPumpMarketState({ connection: d.conn, mint, executionMode: 'LIVE' });
    if (!s) throw new Error(`no curve state for ${mint.toBase58()}`);
    return s;
  };
  const tradeParams = (s: any, mint: any, owner: any) => ({
    mint, bondingCurve: s.bondingCurve, associatedBondingCurve: s.associatedBondingCurve,
    associatedUser: d.curve.getAssociatedTokenAddress(mint, owner, s.tokenProgram), creator: s.creator,
    feeRecipient: s.feeRecipient, buybackFeeRecipient: s.buybackFeeRecipient, quoteMint: s.quoteMint,
    tokenProgram: s.tokenProgram, quoteTokenProgram: s.quoteTokenProgram, computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
  });
  const held = async (owner: any, mint: any): Promise<bigint> => {
    const a = await d.conn.getTokenAccountsByOwner(owner, { mint });
    if (!a.value.length) return 0n;
    return BigInt((await d.conn.getTokenAccountBalance(a.value[0].pubkey)).value.amount);
  };
  return {
    newWallet: () => Keypair.generate(),
    transfer: (from, to, sol) => send(new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.ceil(sol * LAMPORTS_PER_SOL) })), [from]),
    async create(creator, symbol, name) {
      const mintKp = Keypair.generate();
      const ix = await d.sdk.createV2Instruction({
        mint: mintKp.publicKey, name, symbol, uri: 'http://127.0.0.1/none',
        creator: creator.publicKey, user: creator.publicKey, mayhemMode: false,
      });
      await send(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix), [creator, mintKp]);
      const s = await state(mintKp.publicKey);
      return { mint: mintKp.publicKey.toBase58(), curve: s.bondingCurve.toBase58() };
    },
    async buy(kp, mint, sol) {
      const m = new PublicKey(mint);
      const s = await state(m);
      const q = d.curve.calculateBuyQuote({ state: s, amountSol: sol, slippageBps: 3000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' });
      const tx = await d.builder.buildBuyTransaction(d.conn, { ...tradeParams(s, m, kp.publicKey), buyer: kp.publicKey, amountTokens: BigInt(q.tokenAmountRaw), maxSolCostLamports: BigInt(q.maxInputLamports) });
      return send(tx, [kp]);
    },
    async sellAll(kp, mint) {
      const m = new PublicKey(mint);
      const amount = await held(kp.publicKey, m);
      if (amount <= 0n) return null;
      const s = await state(m);
      const q = d.curve.calculateSellQuote({ state: s, tokenAmountRaw: amount, slippageBps: 5000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' });
      const tx = await d.builder.buildSellTransaction(d.conn, { ...tradeParams(s, m, kp.publicKey), seller: kp.publicKey, amountTokens: amount, minSolOutputLamports: BigInt(q.minOutputLamports) });
      return send(tx, [kp]);
    },
    curveState: (mint) => state(new PublicKey(mint)),
    async priceSol(mint) {
      const s = await state(new PublicKey(mint));
      return (Number(s.virtualSolReserves) / 1e9) / (Number(s.virtualTokenReserves) / 10 ** s.tokenDecimals);
    },
    async refund(kp, to) {
      const bal = await d.conn.getBalance(kp.publicKey);
      const lamports = bal - 5000;
      if (lamports > 0) await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports })), [kp]);
    },
  };
}

/**
 * (h) the seed for the dump, from the coin's own curve (constant product on the virtual reserves, fees grossed up). The app buys `appBuySol`
 * after the seed; when the second wallet then sells everything, the curve returns to about its state before the seed plus the app's buy. The
 * seed is sized so that price is at most `targetRatio` (0.72 by default, under the -20% stop with room for fees) of the price the app buys at,
 * measured conservatively against the price just before the app's buy (the app's fill is above it). Refused when the seed is above
 * `maxSeedSol` (DEVNET_DUMP_SOL), when the seed and the app's buy would take more than 95% of the tokens left on the curve (the program
 * refuses a buy near the end of the curve), or when the curve's progress at the app's buy would be within 5 points of the app's curve-progress
 * cap (the coordinator refuses the buy above it). With 30 SOL / 1,073M virtual reserves the seed is about 6.3 SOL for a 0.02 SOL app buy; with
 * 1 SOL virtual reserves, about 0.24 SOL; with the about 0.3 SOL a devnet coin showed in the Mac run, about 0.07 SOL.
 */
export function dumpSeedPlan(
  st: { virtualSolReserves: bigint; virtualTokenReserves: bigint; realTokenReserves: bigint },
  appBuySol: number,
  opts: { maxSeedSol: number; targetRatio?: number; capPct?: number; margin?: number }
): { ok: true; seedSol: number; projectedRatio: number; progressPct: number } | { ok: false; reason: string; seedSol: number } {
  const target = opts.targetRatio ?? 0.72;
  const capPct = opts.capPct ?? 60;
  const vSol = Number(st.virtualSolReserves) / 1e9;
  const vTok = Number(st.virtualTokenReserves);
  const k = vSol * vTok;
  const appNet = appBuySol * (1 - BUY_FEE_FRACTION);
  const net = Math.max(0.005, ((vSol + appNet) / Math.sqrt(target) - vSol) * (opts.margin ?? 1.15));
  const seedSol = Math.ceil((net / (1 - BUY_FEE_FRACTION)) * 1e4) / 1e4;
  const projectedRatio = ((vSol + appNet) / (vSol + net)) ** 2;
  const tokensOut = (sol: number) => vTok - k / (vSol + sol);
  const progressPct = (100 * (Number(CURVE_TOKENS_RAW - st.realTokenReserves) + tokensOut(net))) / Number(CURVE_TOKENS_RAW);
  const left = Number(st.realTokenReserves);
  if (seedSol > opts.maxSeedSol) return { ok: false, seedSol, reason: `the seed this curve needs is ${seedSol} SOL, above DEVNET_DUMP_SOL=${opts.maxSeedSol} (virtual reserves ${vSol.toFixed(3)} SOL)` };
  if (tokensOut(net + appNet) > 0.95 * left) return { ok: false, seedSol, reason: `CURVE_NEARLY_COMPLETE: a ${seedSol} SOL seed and the app's buy need ${tokensOut(net + appNet).toExponential(4)} tokens, ${left.toExponential(4)} remain` };
  if (progressPct > capPct - 5) return { ok: false, seedSol, reason: `the curve would be ${progressPct.toFixed(1)}% sold at the app's buy, too close to the ${capPct}% cap` };
  return { ok: true, seedSol, projectedRatio, progressPct };
}

/**
 * The DumpMarket on any cluster, on top of makeChainKit. `payer` is the harness's throwaway wallet. The second wallet's key is kept at
 * `keyPath` (in the harness's scratch directory, next to the throwaway key) and the coins it creates in `<keyPath without .json>-coins.json`;
 * the key is written before any SOL is sent to it, so an interrupted run leaves nothing a later run (or `solana transfer` with that key file)
 * cannot get back. An existing key file is reused.
 */
export function makeDumpMarket(d: {
  conn: any; payer: any; web3: any; sdk: any; curve: any; builder: any; keyPath: string;
}): DumpMarket {
  const kit = makeChainKit(d);
  const coinsPath = d.keyPath.replace(/\.json$/, '') + '-coins.json';
  let w2: any;
  if (fs.existsSync(d.keyPath)) {
    w2 = d.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(d.keyPath, 'utf8'))));
  } else {
    w2 = kit.newWallet();
    fs.mkdirSync(path.dirname(d.keyPath), { recursive: true });
    fs.writeFileSync(d.keyPath, JSON.stringify(Array.from(w2.secretKey)), { mode: 0o600 });
  }
  const coins = (): string[] => { try { return JSON.parse(fs.readFileSync(coinsPath, 'utf8')); } catch { return []; } };
  const remember = (mint: string) => fs.writeFileSync(coinsPath, JSON.stringify([...new Set([...coins(), mint])]), { mode: 0o600 });
  return {
    address: w2.publicKey.toBase58(),
    keyPath: d.keyPath,
    async createAndSeed({ appBuySol, maxSeedSol }) {
      await kit.transfer(d.payer, w2.publicKey, 0.1);
      const coin = await kit.create(w2, 'P16H', 'P16 harness');
      remember(coin.mint);
      const plan = dumpSeedPlan(await kit.curveState(coin.mint), appBuySol, { maxSeedSol });
      if (!plan.ok) throw new Error(plan.reason);
      await kit.transfer(d.payer, w2.publicKey, plan.seedSol + 0.01);
      await kit.buy(w2, coin.mint, plan.seedSol);
      return { ...coin, seedSol: plan.seedSol, projectedRatio: plan.projectedRatio };
    },
    priceSol: (mint: string) => kit.priceSol(mint),
    sellAll: (mint: string) => kit.sellAll(w2, mint),
    async refund() {
      for (const mint of coins()) {
        try { await kit.sellAll(w2, mint); } catch (e: any) { console.log(`INFO  (h) second wallet could not sell ${mint}: ${String(e?.message ?? e).slice(0, 120)}`); }
      }
      await kit.refund(w2, d.payer.publicKey);
    },
  };
}

/**
 * (h) P1.6 (R1-19, R1-112): one failed price read does not blind the stop-loss. A second throwaway wallet creates a coin and seeds it (the seed
 * is sized from the coin's own curve by `dumpSeedPlan`, at most `maxSeedSol`); the app buys `appBuySol` of it; the harness then wraps the
 * coordinator's `getMultipleAccountsInfo` so the next call naming the curve throws once (the app's own price read takes it), and the second
 * wallet dumps everything. Expected: the exit loop's STOP_LOSS sell within about 6 s of the dump being visible on the curve (two 3 s passes;
 * before P1.6 the failed read put the mint in a 60 s back-off). The pass bound is `maxMs` (10 s by default, for devnet confirmation latency).
 * Every path, a failed create or seed included, ends in `finally`: the app's position is closed, the second wallet sells what it holds and
 * refunds the harness wallet.
 */
export async function failedReadThenDumpStopLoss(
  s: HarnessSteps,
  m: DumpMarket,
  opts: { appBuySol: number; maxSeedSol: number; buildBuyRequestFor: (mint: string) => Promise<ExecuteTradeRequest>; maxMs?: number }
): Promise<void> {
  const L = '(h) failed price read, then a dump: stop-loss';
  const maxMs = opts.maxMs ?? 10_000;
  type Row = Pos & { entryPriceSol: number; exitReason?: string; exitTxSignature?: string };
  const rowFor = (mint: string) => (s.db.loadPositions() as Row[]).find((p) => p.mint === mint);
  if (!s.connection) { s.rec(L, false, 'harness did not pass the coordinator connection'); return; }
  const conn: any = s.connection;
  const orig = conn.getMultipleAccountsInfo;
  let coin: { mint: string; curve: string; seedSol: number; projectedRatio: number } | undefined;
  let injected = false;
  try {
    try {
      coin = await m.createAndSeed({ appBuySol: opts.appBuySol, maxSeedSol: opts.maxSeedSol });
    } catch (e: any) {
      s.rec(`${L}: second wallet creates and seeds a coin`, false, String(e?.message ?? e).slice(0, 300));
      return;
    }
    const c = coin;
    s.rec(`${L}: second wallet creates and seeds a coin`, true, `${c.mint} seeded with ${c.seedSol} SOL from ${m.address} (projected price/entry after the dump at most ${c.projectedRatio.toFixed(3)})`);
    await s.coordinator.syncRealWalletBalance();
    const buy = await s.coordinator.executeTrade(await opts.buildBuyRequestFor(c.mint));
    s.rec(`${L}: app buy CONFIRMED`, buy.success && buy.lifecycleState === 'CONFIRMED', `${buy.lifecycleState} ${buy.error ?? ''}`.slice(0, 300));
    const pos = rowFor(c.mint);
    if (!buy.success || !pos || pos.status === 'CLOSED') return;

    conn.getMultipleAccountsInfo = async function (this: unknown, ...args: any[]) {
      const keys: any[] = Array.isArray(args[0]) ? args[0] : [];
      if (!injected && keys.some((k) => String(k?.toBase58?.() ?? k) === c.curve)) {
        injected = true;
        conn.getMultipleAccountsInfo = orig; // one call only
        throw new Error('harness: injected getMultipleAccountsInfo failure');
      }
      return orig.apply(this, args);
    };
    for (let i = 0; i < 40 && !injected; i++) await s.sleep(250);
    s.rec(`${L}: the app's price read took the injected failure`, injected, injected ? 'one getMultipleAccountsInfo naming the curve threw' : 'no read of the curve in 10 s');
    if (!injected) return;

    const dumpSig = await m.sellAll(c.mint);
    let visibleAt = 0;
    let ratio = 1;
    for (let i = 0; i < 40 && !visibleAt; i++) {
      ratio = (await m.priceSol(c.mint)) / pos.entryPriceSol;
      if (ratio <= 0.8) visibleAt = Date.now(); else await s.sleep(250);
    }
    s.rec(`${L}: dump visible below the -20% stop`, visibleAt > 0, `price/entry ${ratio.toFixed(3)}${dumpSig ? ` ${s.link(dumpSig)}` : ''}`);
    if (!visibleAt) return;
    let closed: Row | undefined;
    for (let i = 0; i < 240 && !closed; i++) {
      const r = rowFor(c.mint);
      if (r?.status === 'CLOSED') closed = r; else await s.sleep(250);
    }
    const tookMs = closed ? Date.now() - visibleAt : NaN;
    s.rec(
      `${L}: STOP_LOSS sold within ${Math.round(maxMs / 1000)} s of the dump being visible`,
      !!closed && closed.exitReason === 'STOP_LOSS' && tookMs <= maxMs,
      closed ? `${closed.exitReason} after ${tookMs} ms ${closed.exitTxSignature ? s.link(closed.exitTxSignature) : ''}` : 'still open after 60 s'
    );
    if (closed?.exitTxSignature) {
      const err = await s.chainErr(closed.exitTxSignature);
      s.rec(`${L}: the stop-loss sell succeeded on chain`, err === null, `err=${JSON.stringify(err)}`);
    }
  } finally {
    conn.getMultipleAccountsInfo = orig;
    if (coin) {
      for (const p of openFor({ ...s, mint: coin.mint })) {
        try {
          const c = await s.coordinator.closePosition(p.id, 100, 'e2e (h) cleanup');
          s.rec(`${L}: cleanup close 100%`, c.success, c.error || 'closed');
        } catch (e: any) { s.rec(`${L}: cleanup close 100%`, false, String(e?.message ?? e).slice(0, 200)); }
      }
    }
    try { await m.refund(); } catch (e: any) { console.log(`INFO  (h) refund of the second wallet failed: ${String(e?.message ?? e).slice(0, 120)}; its key is in ${m.keyPath}, and the next run with this scratch directory retries the refund`); }
  }
}

/** (i) what the step reads: the app's own watch window fed by the app's own pump log stream (wired by the harness as server.ts does). */
export interface WatchFeed {
  /** What GET /api/watch returns. */
  snapshot(): { watching: Array<{ metrics: any }>; released: Array<{ state: string; reason: string; metrics: any }>; capacity: { active: number; max: number } };
}

/**
 * (i) P4.1 (R1-55, R1-54), opt-in: the creator cluster and funder truth, through the app's own log stream, watch window and funder lookup.
 * A fresh throwaway creator (funded from the harness wallet) launches its own coin with no dev buy and funds a throwaway W; W buys, and
 * sells 25 s later. Expected: the launch is released DEAD with CREATOR_SOLD (before P4.1 only the creator's own sell counted, so it stayed
 * WATCHING). Then the creator launches a second coin and the harness wallet funds 5 throwaway wallets that buy it together (sent at
 * once, so usually in one or two slots). Expected: rawUniqueBuyers 5, funderCoverage 1, uniqueBuyers 1 (one cluster, not 5). Every
 * throwaway wallet sells what it holds and sends what is left back to the harness wallet at the end. The harness wallet lends about
 * 0.4 SOL (0.26 to the creator, 0.02 to each of six buyers) and gets all but about 0.03 SOL back (two coins' and six token accounts'
 * rent, fees, curve fees; measured on the local validator).
 */
export async function creatorClusterOnChain(s: HarnessSteps, kit: ChainKit, feed: WatchFeed, payer: any, opts: { buySol?: number; sellAfterMs?: number; waitMs?: number } = {}): Promise<void> {
  const L = '(i) creator cluster';
  const buySol = opts.buySol ?? 0.01;
  const sellAfterMs = opts.sellAfterMs ?? 25_000;
  const waitMs = opts.waitMs ?? 30_000;
  const find = (mint: string) => {
    const snap = feed.snapshot();
    return snap.watching.find((w) => w.metrics?.mint === mint) as { state?: string; reason?: string; metrics: any } | undefined
      ?? snap.released.find((r) => r.metrics?.mint === mint);
  };
  const waitFor = async (mint: string, pred: (e: { state?: string; reason?: string; metrics: any }) => boolean) => {
    for (let i = 0; i < Math.ceil(waitMs / 500); i++) {
      const e = find(mint);
      if (e && pred(e)) return e;
      await s.sleep(500);
    }
    return find(mint);
  };
  const creator = kit.newWallet();
  const W = kit.newWallet();
  const five = Array.from({ length: 5 }, () => kit.newWallet());
  const coins: string[] = [];
  try {
    await kit.transfer(payer, creator.publicKey, 0.25 + buySol);
    const a = await kit.create(creator, 'P41A', 'P41 harness');
    coins.push(a.mint);
    const seen = await waitFor(a.mint, () => true);
    s.rec(`${L}: the app's feed watches the creator's launch`, !!seen, seen ? a.mint : `not in the watch window after ${waitMs / 1000} s (capacity ${JSON.stringify(feed.snapshot().capacity)})`);
    if (!seen) return;
    await kit.transfer(creator, W.publicKey, buySol + 0.01);
    await kit.buy(W, a.mint, buySol);
    const bought = await waitFor(a.mint, (e) => e.metrics.tradeCount >= 1);
    s.rec(`${L}: W's buy reached the window`, !!bought && bought.metrics.tradeCount >= 1, `trades ${bought?.metrics.tradeCount ?? 0}, state ${bought?.state ?? 'WATCHING'}`);
    const boughtAt = Date.now();
    while (Date.now() < boughtAt + sellAfterMs) await s.sleep(500);
    const sellSig = await kit.sellAll(W, a.mint);
    const r = await waitFor(a.mint, (e) => !!e.state && e.state !== 'WATCHING');
    s.rec(
      `${L}: W (funded by the creator) sold at ${Math.round(sellAfterMs / 1000)} s: /api/watch shows DEAD CREATOR_SOLD`,
      r?.state === 'DEAD' && /^CREATOR_SOLD/.test(r.reason ?? ''),
      `${r?.state ?? 'WATCHING'} ${r?.reason ?? ''}${sellSig ? ` ${s.link(sellSig)}` : ' (W held nothing to sell)'}`.slice(0, 300)
    );

    const b = await kit.create(creator, 'P41B', 'P41 harness');
    coins.push(b.mint);
    if (!(await waitFor(b.mint, () => true))) { s.rec(`${L}: the second launch is watched`, false, 'not in the watch window'); return; }
    for (const w of five) await kit.transfer(payer, w.publicKey, buySol + 0.01);
    const buys = await Promise.allSettled(five.map((w) => kit.buy(w, b.mint, buySol)));
    const landed = buys.filter((x) => x.status === 'fulfilled').length;
    s.rec(`${L}: 5 wallets from one funder bought together`, landed === 5, `${landed}/5 buys confirmed`);
    const e = await waitFor(b.mint, (x) => x.metrics.rawUniqueBuyers >= landed && x.metrics.funderCoverage === 1);
    const m = e?.metrics;
    s.rec(
      `${L}: 5 wallets from one funder: one cluster, not 5`,
      !!m && m.rawUniqueBuyers === 5 && m.funderCoverage === 1 && m.uniqueBuyers === 1,
      m ? `rawUniqueBuyers ${m.rawUniqueBuyers}, uniqueBuyers ${m.uniqueBuyers}, funderCoverage ${m.funderCoverage}` : 'not in the watch window'
    );
  } catch (e: any) {
    s.rec(L, false, String(e?.message ?? e).slice(0, 300));
  } finally {
    for (const w of [W, ...five]) {
      for (const c of coins) { try { await kit.sellAll(w, c); } catch { /* nothing held or curve moved; the refund below still runs */ } }
      try { await kit.refund(w, payer.publicKey); } catch (e: any) { console.log(`INFO  (i) refund failed: ${String(e?.message ?? e).slice(0, 120)}`); }
    }
    try { await kit.refund(creator, payer.publicKey); } catch (e: any) { console.log(`INFO  (i) creator refund failed: ${String(e?.message ?? e).slice(0, 120)}`); }
  }
}

/**
 * A loopback WebSocket relay in front of `upstreamWs` for (j). `block(ms)` cuts every relayed connection at once and refuses new ones
 * for `ms` (the TCP connection is destroyed before the upgrade, as a blocked port does), then relays again. Refusing before the upgrade
 * matters: accepting the socket and closing it at once drives web3.js 1.99's resubscribe into a microtask loop (see the validator's
 * `localnet_dropWebSockets`).
 */
export async function startBlockingWsProxy(upstreamWs: string) {
  const { WebSocketServer, WebSocket } = await import('ws');
  let blockedUntil = 0;
  const pairs = new Set<{ a: any; b: any }>();
  const server = http.createServer((_req, res) => res.writeHead(426).end());
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (Date.now() < blockedUntil) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      const up = new WebSocket(upstreamWs);
      const pair = { a: client, b: up };
      pairs.add(pair);
      const queue: any[] = [];
      const end = () => { pairs.delete(pair); try { client.terminate(); } catch { /* gone */ } try { up.terminate(); } catch { /* gone */ } };
      up.on('open', () => { for (const m of queue.splice(0)) up.send(m); });
      up.on('message', (m: any, isBinary: boolean) => { if (client.readyState === WebSocket.OPEN) client.send(m, { binary: isBinary }); });
      client.on('message', (m: any, isBinary: boolean) => {
        const data = isBinary ? m : String(m);
        if (up.readyState === WebSocket.OPEN) up.send(data); else queue.push(data);
      });
      up.on('close', end); up.on('error', end); client.on('close', end); client.on('error', end);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    block(ms: number) {
      blockedUntil = Date.now() + ms;
      for (const p of [...pairs]) { try { p.a.terminate(); } catch { /* gone */ } try { p.b.terminate(); } catch { /* gone */ } }
    },
    close: () => new Promise<void>((r) => {
      for (const p of [...pairs]) { try { p.a.terminate(); } catch { /* gone */ } try { p.b.terminate(); } catch { /* gone */ } }
      wss.close();
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

/** web3.js's own rule for the websocket of an RPC URL: http(s) becomes ws(s), and an explicit port becomes port + 1. */
export function wsUrlFor(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

export interface FeedGapDeps {
  /** The app's PumpFeedListener and WatchWindow classes and web3.js's Connection (the step imports nothing from server/). */
  Listener: new (conn: any) => any;
  Window: new (opts: any) => any;
  Connection: new (url: string, cfg: any) => any;
  rpcUrl: string;
  blockMs?: number;
  /** What server.ts runs at boot for the pump feed (pumpBootMode + startBackground), and the mode it chose. */
  bootPumpFeed?: () => string;
}

/**
 * (j) P4.2 (R1-52, R1-65). The app's `PumpFeedListener` subscribes to the devnet pump program through a loopback relay in front of the
 * RPC's websocket, with the app's `WatchWindow` attached and the harness mint watched. The relay then blocks the websocket for
 * `blockMs` (10 s). Expected: the listener leaves ACTIVE (RECONNECTING), the watched mint is released DEAD with FEED_GAP, and the
 * listener is ACTIVE again after the block (web3.js reconnects and resubscribes by itself). Then the boot path: the pump feed is
 * started as server.ts starts it and every outbound fetch for 12 s is recorded; none may go to pump.fun or DexScreener.
 */
export async function feedGapThroughWsProxy(s: Pick<HarnessSteps, 'mint' | 'rec' | 'sleep'>, d: FeedGapDeps): Promise<void> {
  const L = '(j) feed gap';
  const blockMs = d.blockMs ?? 10_000;
  const until = async (cond: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !cond()) await s.sleep(200);
    return cond();
  };
  const proxy = await startBlockingWsProxy(wsUrlFor(d.rpcUrl));
  const conn = new d.Connection(d.rpcUrl, { commitment: 'processed', wsEndpoint: proxy.url });
  const listener = new d.Listener(conn);
  const ww = new d.Window({ publicFunders: [] });
  ww.attach(listener);
  const seen: string[] = [];
  listener.on('feed_gap', (g: any) => seen.push(`${g.reason}/${listener.getTelemetry().status}`));
  try {
    const started = await listener.start();
    await s.sleep(3_000); // the socket opens and the subscriptions are made
    const t0 = listener.getTelemetry();
    s.rec(`${L}: listener ACTIVE through the loopback ws proxy`, started && t0.status === 'ACTIVE' && t0.feedGaps === 0, `status ${t0.status}, gaps ${t0.feedGaps}`);
    ww.watch(s.mint, null);
    proxy.block(blockMs);
    const left = await until(() => listener.getTelemetry().status !== 'ACTIVE', 3_000);
    s.rec(`${L}: status left ACTIVE while the ws port was blocked`, left, `gaps seen: ${seen.join(', ') || 'none'}`);
    const v = ww.getVerdict(s.mint);
    s.rec(`${L}: the watched mint is DEAD with FEED_GAP`, v?.state === 'DEAD' && /^FEED_GAP/.test(v?.reason ?? ''), `${v?.state} ${v?.reason ?? ''}`);
    const back = await until(() => listener.getTelemetry().status === 'ACTIVE', blockMs + 20_000);
    s.rec(`${L}: ACTIVE again after the ${blockMs / 1000} s block`, back, `status ${listener.getTelemetry().status}, gaps ${listener.getTelemetry().feedGaps}`);
  } finally {
    await listener.stop();
    listener.destroy?.();
    await proxy.close();
  }

  if (!d.bootPumpFeed) return;
  const hosts: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    try { hosts.push(new URL(typeof input === 'string' ? input : input?.url ?? String(input)).host); } catch { /* not a URL */ }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const mode = d.bootPumpFeed();
    await s.sleep(12_000); // the HTTP fallback polls at once and then every 5 s, when it runs at all
    const bad = hosts.filter((h) => /pump\.fun|dexscreener/i.test(h));
    s.rec('(j) boot: no pump.fun or DexScreener request', mode !== 'FULL' && bad.length === 0, `boot mode ${mode}; hosts in 12 s: ${[...new Set(hosts)].join(', ') || 'none'}`);
  } finally {
    globalThis.fetch = origFetch;
  }
}

/** (k) what the release-gates step needs from the app besides HarnessSteps (passed in, so this file still imports nothing from server/). */
export interface ReleaseGatesDeps {
  /** The decision journal rows of one mint, oldest first (workstationDb.loadDecisions). */
  decisions(mint: string): Array<{ autoMode: string; stage: string; outcome: string; reason: string; inputs: any }>;
  /** The on-chain curve state of a mint (PumpCurveService.fetchPumpMarketState on the coordinator connection). */
  curveState(mint: string): Promise<{ virtualSolReserves: bigint; virtualTokenReserves: bigint; realTokenReserves: bigint } | null>;
  /** What the app's feed measured as the mint's curve progress (onChainPoolStats), or null. */
  progressPct(mint: string): number | null;
  /** The cap in force (maxCurveProgressPct). */
  capPct: number;
  /** A LIVE buy request for a mint (the harness's own builder, holder checks waived for the harness's coin). */
  buildBuyRequestFor(mint: string): Promise<ExecuteTradeRequest>;
  /** Wallet balance of a throwaway key in SOL. */
  balanceSol(kp: any): Promise<number>;
  /** Whether the coordinator is armed LIVE now. */
  isLiveArmed(): boolean;
}

/** 793.1M tokens at 6 decimals: what a fresh pump.fun curve has to sell (the progress bar's 100%). */
const CURVE_TOKENS_RAW = 793_100_000_000_000n;
/** The pump protocol and creator fee the curve takes on a buy, plus a margin (q7: 0.95% + 0.30%). */
const BUY_FEE_FRACTION = 0.0125 + 0.0025;

/**
 * SOL a buyer must put in to take a fresh curve from its state to `targetPct` of the tokens sold (constant product on the virtual reserves,
 * grossed up by the buy fee). With 30 SOL / 1,073M virtual reserves, 62% needs about 25.8 SOL; with the 1 SOL devnet value the localnet
 * accounts were dumped with, about 0.86 SOL.
 */
export function solToReachProgress(st: { virtualSolReserves: bigint; virtualTokenReserves: bigint; realTokenReserves: bigint }, targetPct: number): number {
  const vSol = Number(st.virtualSolReserves) / 1e9;
  const vTok = Number(st.virtualTokenReserves);
  const soldNow = Number(CURVE_TOKENS_RAW - st.realTokenReserves);
  const sellMore = Math.max(0, (targetPct / 100) * Number(CURVE_TOKENS_RAW) - soldNow);
  const netIn = (vSol * vTok) / (vTok - sellMore) - vSol;
  return netIn / (1 - BUY_FEE_FRACTION);
}

/**
 * (k) P4.3 (R1-56, R1-59), opt-in (DEVNET_RELEASE_GATES=1), cheap: SHADOW, then PAPER, over two launches released about 1 s apart, through the
 * app's own log stream, watch window and auto controller (attachWatchWindow, as server.ts wires it). For each mode a throwaway creator launches two
 * coins 1 s apart and 10 throwaway wallets buy each with equal small buys, so both are released READY (concentration and flow pass) 1 s apart and
 * reach the controller on their own. Expected: each mode journals a decision for both, the SHADOW and PAPER rows match (outcome WOULD_BUY / BOUGHT
 * count as one; numbers in the reason are ignored), and every row carries passingSignals. PAPER needs the coordinator in PAPER, so LIVE is
 * disarmed for the step and re-armed after it. The harness wallet lends about 2 x 2 x (10 x 0.02 + 0.06) SOL and gets most back.
 *
 * (k) P4.3 (R1-57), opt-in on top (DEVNET_CURVE_CAP=1), LARGE SOL, off by default: one more coin, which a throwaway wallet pushes past
 * capPct + 2 points inside the window. The SOL is computed from the coin's own curve (solToReachProgress): about 25.8 SOL with 30 SOL virtual
 * reserves; the step refuses to start unless the harness wallet holds that plus 1 SOL. Expected: /api/watch shows DEAD CURVE_TOO_FAR, the
 * journal row for the mint is DROPPED at stage watch with WATCH_DEAD: CURVE_TOO_FAR, and a LIVE buy through executeTrade is refused on the
 * coordinator's fresh read with CURVE_PROGRESS_TOO_HIGH and nothing sent. The wallet then sells everything and refunds (about 2.5% of the push
 * is lost to the curve's fees both ways).
 */
export async function releaseGatesOnChain(
  s: HarnessSteps, kit: ChainKit, feed: WatchFeed, payer: any, deps: ReleaseGatesDeps,
  opts: { buyers?: number; buySol?: number; curveCap?: boolean; waitMs?: number } = {}
): Promise<void> {
  const L = '(k) release gates';
  const st = s.stop;
  if (!st) { s.rec(L, false, 'harness did not pass the app singletons (stop)'); return; }
  const nBuyers = opts.buyers ?? 10;
  const buySol = opts.buySol ?? 0.01;
  const waitMs = opts.waitMs ?? 180_000;
  const ARM = 'CONFIRM_LIVE_TRADING_RISK';
  const prevAuto = process.env.AUTO_SNIPE_ENABLED;
  process.env.AUTO_SNIPE_ENABLED = 'true';
  const wallets: any[] = [];
  const coins: string[] = [];
  const find = (mint: string) => {
    const snap = feed.snapshot();
    return snap.released.find((r) => r.metrics?.mint === mint) ?? (snap.watching.some((w) => w.metrics?.mint === mint) ? { state: 'WATCHING', reason: '', metrics: null } : undefined);
  };
  const lastDecision = (mint: string) => deps.decisions(mint).filter((r) => r.outcome !== 'QUEUED').pop();
  const waitUntil = async (pred: () => boolean, ms: number) => { for (let i = 0; i < Math.ceil(ms / 500) && !pred(); i++) await s.sleep(500); return pred(); };
  const norm = (r: { outcome: string; stage: string; reason: string } | undefined) =>
    r ? `${r.outcome === 'WOULD_BUY' ? 'BOUGHT' : r.outcome}|${r.stage}|${r.reason.replace(/[\d.]+/g, '#')}` : 'none';

  const pair = async (mode: 'SHADOW' | 'PAPER'): Promise<string[] | null> => {
    const set = await st.auto.setMode(mode);
    if (!set.ok) { s.rec(`${L}: auto ${mode}`, false, set.error ?? set.mode); return null; }
    const creator = kit.newWallet(); wallets.push(creator);
    await kit.transfer(payer, creator.publicKey, 0.06);
    const made: string[] = [];
    for (let i = 0; i < 2; i++) {
      made.push((await kit.create(creator, `K${mode[0]}${i}`, 'P43 harness')).mint);
      if (i === 0) await s.sleep(1_000);
    }
    coins.push(...made);
    const seen = await waitUntil(() => made.every((m) => !!find(m)), 30_000);
    if (!seen) { s.rec(`${L}: ${mode}: the app's feed watches both launches`, false, 'not in the watch window after 30 s'); return null; }
    const buyers = Array.from({ length: nBuyers }, () => kit.newWallet()); wallets.push(...buyers);
    for (const w of buyers) await kit.transfer(payer, w.publicKey, 2 * buySol + 0.02);
    for (const m of made) {
      const r = await Promise.allSettled(buyers.map((w) => kit.buy(w, m, buySol)));
      s.rec(`${L}: ${mode}: ${nBuyers} equal buys of ${m.slice(0, 6)}`, r.every((x) => x.status === 'fulfilled'), `${r.filter((x) => x.status === 'fulfilled').length}/${nBuyers} confirmed`);
    }
    const released = await waitUntil(() => made.every((m) => { const e = find(m); return !!e && e.state !== 'WATCHING'; }), waitMs);
    const journaled = released && (await waitUntil(() => made.every((m) => !!lastDecision(m)), 30_000));
    const rows = made.map((m) => lastDecision(m));
    s.rec(
      `${L}: ${mode}: both launches released and journaled`,
      journaled,
      made.map((m, i) => `${find(m)?.state ?? '?'} -> ${rows[i] ? `${rows[i]!.outcome} ${rows[i]!.stage} ${rows[i]!.reason}` : 'no row'}`).join('; ').slice(0, 400)
    );
    return journaled ? made : null;
  };

  const wasArmed = deps.isLiveArmed();
  st.arm(false); // PAPER auto needs the coordinator in PAPER and disarmed
  try {
    const shadow = await pair('SHADOW');
    const paper = shadow ? await pair('PAPER') : null;
    if (shadow && paper) {
      const a = shadow.map((m) => norm(lastDecision(m)));
      const b = paper.map((m) => norm(lastDecision(m)));
      s.rec(`${L}: SHADOW and PAPER decision rows match`, a.every((x, i) => x === b[i]), `SHADOW ${a.join(' / ')} | PAPER ${b.join(' / ')}`.slice(0, 400));
      const all = [...shadow, ...paper].flatMap((m) => deps.decisions(m));
      s.rec(`${L}: every decision row carries passingSignals`, all.length > 0 && all.every((r) => r.inputs && 'passingSignals' in r.inputs), `${all.length} rows`);
    }

    if (opts.curveCap) {
      const C = '(k) curve cap';
      await st.auto.setMode('SHADOW');
      const pusher = kit.newWallet(); wallets.push(pusher);
      const creator = kit.newWallet(); wallets.push(creator);
      await kit.transfer(payer, creator.publicKey, 0.05);
      const coin = await kit.create(creator, 'KCAP', 'P43 harness');
      coins.push(coin.mint);
      const state = await deps.curveState(coin.mint);
      if (!state) { s.rec(`${C}: read the new coin's curve`, false, 'no curve state'); return; }
      const target = deps.capPct + 2;
      const need = solToReachProgress(state, target);
      const have = await deps.balanceSol(payer);
      if (have < need + 1) { s.rec(`${C}: funding for the push`, false, `pushing to ${target}% needs about ${need.toFixed(2)} SOL; the harness wallet has ${have.toFixed(3)}, needs ${(need + 1).toFixed(2)}`); return; }
      if (!(await waitUntil(() => !!find(coin.mint), 30_000))) { s.rec(`${C}: the app's feed watches the launch`, false, 'not in the watch window after 30 s'); return; }
      await kit.transfer(payer, pusher.publicKey, need + 0.05);
      const sig = await kit.buy(pusher, coin.mint, need);
      const dead = await waitUntil(() => find(coin.mint)?.state === 'DEAD', 30_000);
      const r = find(coin.mint);
      s.rec(
        `${C}: pushed past ${deps.capPct}% inside the window: /api/watch shows DEAD CURVE_TOO_FAR`,
        dead && /^CURVE_TOO_FAR/.test(r?.reason ?? ''),
        `${r?.state} ${r?.reason ?? ''} (measured ${deps.progressPct(coin.mint)?.toFixed(1) ?? '?'}%, ${need.toFixed(2)} SOL) ${s.link(sig)}`.slice(0, 300)
      );
      const d = await st.auto.submitCandidate({ mint: coin.mint, source: 'TEST', provenance: 'REAL_ONCHAIN' });
      const row = lastDecision(coin.mint);
      s.rec(`${C}: the journal rejects it at the watch stage (WATCH_DEAD: CURVE_TOO_FAR)`, d.outcome === 'DROPPED' && row?.stage === 'watch' && /^WATCH_DEAD: CURVE_TOO_FAR/.test(row?.reason ?? ''), `${row?.outcome} ${row?.stage} ${row?.reason ?? ''}`.slice(0, 300));
      const rearm = st.arm(true, ARM);
      const buysBefore = s.db.loadTransactions().filter((t) => t.direction === 'BUY').length;
      const live = rearm.success ? await s.coordinator.executeTrade(await deps.buildBuyRequestFor(coin.mint)) : null;
      const buysAfter = s.db.loadTransactions().filter((t) => t.direction === 'BUY').length;
      s.rec(
        `${C}: a LIVE buy is refused on the coordinator's fresh read (CURVE_PROGRESS_TOO_HIGH), nothing sent`,
        !!live && !live.success && /^CURVE_PROGRESS_TOO_HIGH/.test(live.error ?? '') && buysAfter === buysBefore,
        live ? `${live.lifecycleState} ${live.error ?? ''}; BUY rows ${buysBefore} -> ${buysAfter}`.slice(0, 300) : `could not arm: ${rearm.message}`
      );
      st.arm(false);
    }
  } catch (e: any) {
    s.rec(L, false, String(e?.message ?? e).slice(0, 300));
  } finally {
    await st.auto.setMode('OFF');
    if (prevAuto === undefined) delete process.env.AUTO_SNIPE_ENABLED; else process.env.AUTO_SNIPE_ENABLED = prevAuto;
    for (const w of wallets) {
      for (const c of coins) { try { await kit.sellAll(w, c); } catch { /* nothing held; the refund below still runs */ } }
      try { await kit.refund(w, payer.publicKey); } catch (e: any) { console.log(`INFO  (k) refund failed: ${String(e?.message ?? e).slice(0, 120)}`); }
    }
    if (wasArmed) st.arm(true, ARM);
  }
}

/**
 * (f) the crash and recover phases run in child processes on the same scratch DB and throwaway key, which the main process locked when its
 * coordinator started (P1.1): a child would exit INSTANCE_LOCKED before it reached the send. So the main process first stops trading (the
 * exit loop and the other timers; LIVE is already disarmed by (e''')) and releases its locks; it trades nothing after this, it only spawns
 * the children and prints the summary. Returns whether the hand-over is clean: no lock held, LIVE not armed.
 */
export function handOverToChildPhases(
  s: Pick<HarnessSteps, 'rec'>,
  d: { stopTrading(): void; isLiveArmed(): boolean; disarm(): void; releaseAllLocks(): void; /** the lock file on disk still names this process */ holdsLock(p: string): boolean; lockPaths: string[] }
): boolean {
  if (d.isLiveArmed()) d.disarm();
  d.stopTrading();
  d.releaseAllLocks();
  const still = d.lockPaths.filter((p) => d.holdsLock(p));
  const ok = still.length === 0 && !d.isLiveArmed();
  s.rec('(f) main process stopped trading and released its locks', ok, ok ? `released ${d.lockPaths.length} lock(s)` : `still held: ${still.join(', ') || 'none'}; LIVE armed ${d.isLiveArmed()}`);
  return ok;
}

/**
 * A signature's on-chain error, read so a rate limit or a not-yet-indexed transaction is not mistaken for an answer: getTransaction
 * (confirmed) up to `attempts` times with a doubling back-off, a 429 or other thrown error counting as "not read"; then, if it never
 * returned the transaction, getSignatureStatuses with history search, which carries the same `err` for a confirmed signature.
 * Returns the error object, null when the transaction succeeded, or undefined when neither read gave an answer (the Mac run's
 * "failed on chain: err=undefined" for a signature whose lifecycle showed InstructionError 6002).
 */
export async function readChainErr(
  conn: { getTransaction: (...a: any[]) => Promise<any>; getSignatureStatuses: (...a: any[]) => Promise<any> },
  sig: string,
  opts: { attempts?: number; firstDelayMs?: number; sleep?: (ms: number) => Promise<unknown> } = {}
): Promise<unknown | undefined> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let delay = opts.firstDelayMs ?? 500;
  for (let i = 0; i < attempts; i++) {
    try {
      const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (t) return t.meta?.err ?? null;
    } catch { /* rate-limited or unreachable: try again */ }
    if (i < attempts - 1) { await sleep(delay); delay *= 2; }
  }
  try {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }))?.value?.[0];
    if (st && st.confirmationStatus) return st.err ?? null;
  } catch { /* no answer */ }
  return undefined;
}
