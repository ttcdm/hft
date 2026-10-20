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
 *
 * Kept apart from devnet_e2e.ts so the steps can be read on their own; they take every dependency as an argument and import nothing
 * from server/ themselves, so the harness's environment setup still runs before any server module loads.
 */
import type { ExecuteTradeRequest, ExecutionResponse } from '../server/execution/coordinator';

type Tx = { signature: string; orderId: string; direction: string; reconciliationState: string; mint: string };
type Pos = { id: string; mint: string; status: string };

export interface HarnessSteps {
  coordinator: {
    executeTrade(req: ExecuteTradeRequest): Promise<ExecutionResponse>;
    closePosition(id: string, pct: number, reason: string): Promise<{ success: boolean; error?: string }>;
    syncRealWalletBalance(): Promise<unknown>;
  };
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
  /** The coordinator's own Connection: (e'') wraps its `sendRawTransaction` for one call. */
  connection?: { sendRawTransaction: (...args: any[]) => Promise<string> };
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
