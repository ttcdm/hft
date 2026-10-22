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
 *  (e''), (g), (h), (i) and (j) are described at their functions below.
 *
 *  (e''') P1.4: the emergency stop. One LIVE position is opened, auto is set to DEVNET_LIVE, then Telegram `/panic_sell` is driven
 *       through the app's `processTelegramCommand` (no bot): the LIVE position must be sold on chain and auto must end OFF. Then the
 *       kill switch is tripped (the function the kill-switch route runs), reset, and LIVE re-armed: auto must not be DEVNET_LIVE and a
 *       candidate must be dropped as AUTO_OFF, never BOUGHT.
 *
 * Kept apart from devnet_e2e.ts so the steps can be read on their own; they take every dependency as an argument and import nothing
 * from server/ themselves, so the harness's environment setup still runs before any server module loads.
 */
import http from 'node:http';
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
  /** getTransaction meta.err for a signature: undefined when the chain does not know it, null when it succeeded. */
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
    s.rec(`${L}: failed on chain`, err !== undefined && err !== null, `${s.link(sig)} err=${JSON.stringify(err)}`);
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
  /** Funds a fresh second throwaway wallet from the harness wallet, creates a pump coin from it and buys `seedSol` of it. */
  createAndSeed(seedSol: number): Promise<{ mint: string; curve: string }>;
  /** Spot price in SOL per UI token, from the curve as a separate Connection sees it. */
  priceSol(mint: string): Promise<number>;
  /** The second wallet sells everything it holds of `mint`. */
  sellAll(mint: string): Promise<string | null>;
  /** Sends what is left in the second wallet back to the harness wallet. */
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
  /** Sends what is left in `kp` (less one fee) to `to`. */
  refund(kp: any, to: any): Promise<void>;
}

export function makeChainKit(d: { conn: any; web3: any; sdk: any; curve: any; builder: any }): ChainKit {
  const { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = d.web3;
  const send = async (tx: any, signers: any[]) => {
    tx.recentBlockhash = (await d.conn.getLatestBlockhash('confirmed')).blockhash;
    if (!tx.feePayer) tx.feePayer = signers[0].publicKey;
    if ('version' in tx) tx.sign(signers); else tx.sign(...signers);
    const sig = await d.conn.sendRawTransaction(tx.serialize());
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
 * The DumpMarket on any cluster, on top of makeChainKit. `payer` is the harness's throwaway wallet; the second wallet is generated here
 * and never written to disk.
 */
export function makeDumpMarket(d: {
  conn: any; payer: any; web3: any; sdk: any; curve: any; builder: any;
}): DumpMarket {
  const kit = makeChainKit(d);
  const w2 = kit.newWallet();
  return {
    async createAndSeed(seedSol: number) {
      await kit.transfer(d.payer, w2.publicKey, seedSol + 0.1);
      const coin = await kit.create(w2, 'P16H', 'P16 harness');
      await kit.buy(w2, coin.mint, seedSol);
      return coin;
    },
    priceSol: (mint: string) => kit.priceSol(mint),
    sellAll: (mint: string) => kit.sellAll(w2, mint),
    refund: () => kit.refund(w2, d.payer.publicKey),
  };
}

/**
 * (h) P1.6 (R1-19, R1-112): one failed price read does not blind the stop-loss. A second throwaway wallet creates a coin and seeds it with
 * `seedSol`; the app buys it; the harness then wraps the coordinator's `getMultipleAccountsInfo` so the next call naming the curve throws
 * once (the app's own price read takes it), and the second wallet dumps everything. Expected: the exit loop's STOP_LOSS sell within about
 * 6 s of the dump being visible on the curve (two 3 s passes; before P1.6 the failed read put the mint in a 60 s back-off). The pass bound
 * is `maxMs` (10 s by default, for devnet confirmation latency). A -20% move on a fresh curve (30 SOL virtual reserves) needs about
 * 3.6 SOL sold into it, so the seed defaults to 5 SOL and the step needs that much in the harness wallet (see DEVNET_E2E_README.md).
 */
export async function failedReadThenDumpStopLoss(
  s: HarnessSteps,
  m: DumpMarket,
  opts: { seedSol: number; buildBuyRequestFor: (mint: string) => Promise<ExecuteTradeRequest>; maxMs?: number }
): Promise<void> {
  const L = '(h) failed price read, then a dump: stop-loss';
  const maxMs = opts.maxMs ?? 10_000;
  type Row = Pos & { entryPriceSol: number; exitReason?: string; exitTxSignature?: string };
  const rowFor = (mint: string) => (s.db.loadPositions() as Row[]).find((p) => p.mint === mint);
  if (!s.connection) { s.rec(L, false, 'harness did not pass the coordinator connection'); return; }
  const conn: any = s.connection;
  let coin: { mint: string; curve: string };
  try {
    coin = await m.createAndSeed(opts.seedSol);
  } catch (e: any) {
    s.rec(`${L}: second wallet creates and seeds a coin`, false, String(e?.message ?? e).slice(0, 300));
    return;
  }
  const orig = conn.getMultipleAccountsInfo;
  let injected = false;
  try {
    s.rec(`${L}: second wallet creates and seeds a coin`, true, `${coin.mint} seeded with ${opts.seedSol} SOL`);
    await s.coordinator.syncRealWalletBalance();
    const buy = await s.coordinator.executeTrade(await opts.buildBuyRequestFor(coin.mint));
    s.rec(`${L}: app buy CONFIRMED`, buy.success && buy.lifecycleState === 'CONFIRMED', `${buy.lifecycleState} ${buy.error ?? ''}`.slice(0, 300));
    const pos = rowFor(coin.mint);
    if (!buy.success || !pos || pos.status === 'CLOSED') return;

    conn.getMultipleAccountsInfo = async function (this: unknown, ...args: any[]) {
      const keys: any[] = Array.isArray(args[0]) ? args[0] : [];
      if (!injected && keys.some((k) => String(k?.toBase58?.() ?? k) === coin.curve)) {
        injected = true;
        conn.getMultipleAccountsInfo = orig; // one call only
        throw new Error('harness: injected getMultipleAccountsInfo failure');
      }
      return orig.apply(this, args);
    };
    for (let i = 0; i < 40 && !injected; i++) await s.sleep(250);
    s.rec(`${L}: the app's price read took the injected failure`, injected, injected ? 'one getMultipleAccountsInfo naming the curve threw' : 'no read of the curve in 10 s');
    if (!injected) return;

    const dumpSig = await m.sellAll(coin.mint);
    let visibleAt = 0;
    let ratio = 1;
    for (let i = 0; i < 40 && !visibleAt; i++) {
      ratio = (await m.priceSol(coin.mint)) / pos.entryPriceSol;
      if (ratio <= 0.8) visibleAt = Date.now(); else await s.sleep(250);
    }
    s.rec(`${L}: dump visible below the -20% stop`, visibleAt > 0, `price/entry ${ratio.toFixed(3)}${dumpSig ? ` ${s.link(dumpSig)}` : ''}`);
    if (!visibleAt) return;
    let closed: Row | undefined;
    for (let i = 0; i < 240 && !closed; i++) {
      const r = rowFor(coin.mint);
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
    for (const p of openFor({ ...s, mint: coin.mint })) {
      const c = await s.coordinator.closePosition(p.id, 100, 'e2e (h) cleanup');
      s.rec(`${L}: cleanup close 100%`, c.success, c.error || 'closed');
    }
    try { await m.refund(); } catch (e: any) { console.log(`INFO  (h) refund of the second wallet failed: ${String(e?.message ?? e).slice(0, 120)}`); }
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
