import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { DatabaseSync } from 'node:sqlite';
import type { RecordedLaunch, FunderFact } from '../../server/backtest/replay';

/**
 * S228: reads the app's OWN launch recordings for the studies in this folder (`--recorded <path>`). Nothing here reads or writes the public 39-day corpus, and the results are for the recordings only: they are never merged with the corpus results.
 * Two forms are accepted: the paper app's SQLite database (opened READ-ONLY, so a running app is never touched) or a JSONL snapshot of the
 * launch_recording table, one {ts, mint, kind, payload} object per line (kind CREATE | TRADE | FUNDER | END; a FUNDER row has mint '').
 * Grouping follows workstationDb.loadLaunchRecording: a launch is a mint with a CREATE row, its events are that mint's CREATE and TRADE rows
 * oldest first, its END row (5B: why and when its recording stopped) gives `endTs` and `endReason`, and every FUNDER row is kept (the public corpus had none).
 */
/** The compact per-launch form the late-rule study reads: trade rows are [ts, isBuy, sol, tokens, user, virtualSol, virtualTokens, signature]. */
export type TradeRow = [number, boolean, number, number, string, number, number, string];
export interface Launch { mint: string; symbol: string; creator: string; mayhem: boolean; t0: number; graduated: boolean; trades: TradeRow[] }

export interface RecordedSource {
  kind: 'sqlite' | 'jsonl';
  /** CREATE timestamps, ascending */
  createTimes(): number[];
  funders(): FunderFact[];
  /** SOL/USD the recorder stored on the create events, median; null when none was stored */
  medianSolUsd(): number | null;
  /** One launch at a time, oldest create first. The SQLite form reads each launch on demand. */
  launches(): Generator<RecordedLaunch>;
  close(): void;
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const isRow = (r: any): boolean => r && typeof r.ts === 'number' && typeof r.mint === 'string' && (r.kind === 'CREATE' || r.kind === 'TRADE' || r.kind === 'FUNDER' || r.kind === 'END') && r.payload && typeof r.payload === 'object';

function looksLikeSqlite(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return b.toString('latin1') === SQLITE_MAGIC; } finally { fs.closeSync(fd); }
}

export function openSqlite(file: string): RecordedSource {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`recorded database not found: ${abs}`);
  const db = new DatabaseSync(abs, { readOnly: true });
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'launch_recording'`).get();
  if (!table) { db.close(); throw new Error(`${abs} has no launch_recording table`); }
  const funders = (): FunderFact[] => (db.prepare(`SELECT ts, payload_json FROM launch_recording WHERE kind = 'FUNDER' ORDER BY ts ASC, id ASC`).all() as any[]).map((r) => ({ ts: r.ts as number, ...JSON.parse(r.payload_json) }));
  return {
    kind: 'sqlite',
    createTimes: () => (db.prepare(`SELECT ts FROM launch_recording WHERE kind = 'CREATE' ORDER BY ts ASC`).all() as any[]).map((r) => r.ts as number),
    funders,
    medianSolUsd: () => {
      const vals: number[] = [];
      for (const r of db.prepare(`SELECT payload_json FROM launch_recording WHERE kind = 'CREATE'`).iterate() as any) { const v = JSON.parse(r.payload_json).solUsd; if (typeof v === 'number' && v > 0) vals.push(v); }
      return median(vals);
    },
    *launches() {
      const mints = (db.prepare(`SELECT mint FROM launch_recording WHERE kind = 'CREATE' GROUP BY mint ORDER BY MIN(ts) ASC, MIN(id) ASC`).all() as any[]).map((r) => r.mint as string);
      const q = db.prepare(`SELECT ts, kind, payload_json FROM launch_recording WHERE mint = ? AND kind IN ('CREATE','TRADE','END') ORDER BY ts ASC, id ASC`);
      for (const mint of mints) {
        const rows = q.all(mint) as any[];
        const end = rows.find((r) => r.kind === 'END');
        yield {
          mint,
          events: rows.filter((r) => r.kind !== 'END').map((r) => ({ ts: r.ts as number, kind: r.kind as 'CREATE' | 'TRADE', payload: JSON.parse(r.payload_json) })),
          ...(end ? { endTs: end.ts as number, endReason: String(JSON.parse(end.payload_json).reason) } : {}),
        };
      }
    },
    close: () => db.close(),
  };
}

export async function openJsonl(file: string): Promise<RecordedSource> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`recorded snapshot not found: ${abs}`);
  const byMint = new Map<string, RecordedLaunch>();
  const funderRows: FunderFact[] = [];
  let bad = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(abs), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let r: any; try { r = JSON.parse(line); } catch { bad++; continue; }
    if (!isRow(r)) { bad++; continue; }
    if (r.kind === 'FUNDER') { funderRows.push({ ts: r.ts, wallet: r.payload.wallet, funder: r.payload.funder ?? null }); continue; }
    let l = byMint.get(r.mint); if (!l) byMint.set(r.mint, (l = { mint: r.mint, events: [] }));
    // 5C: one END row per launch (5B); the earliest wins, as the first by id does in SQLite
    if (r.kind === 'END') { if (l.endTs === undefined || r.ts < l.endTs) { l.endTs = r.ts; l.endReason = String(r.payload.reason); } continue; }
    l.events.push({ ts: r.ts, kind: r.kind, payload: r.payload });
  }
  if (bad > 0) console.error(`recorded snapshot: ${bad} line(s) skipped (not JSON or not {ts, mint, kind, payload})`);
  const launches = [...byMint.values()].filter((l) => l.events.some((e) => e.kind === 'CREATE'));
  for (const l of launches) l.events.sort((a, b) => a.ts - b.ts); // stable: file order breaks ties, as the id does in SQLite
  const createTs = (l: RecordedLaunch) => Math.min(...l.events.filter((e) => e.kind === 'CREATE').map((e) => e.ts));
  launches.sort((a, b) => createTs(a) - createTs(b));
  return {
    kind: 'jsonl',
    createTimes: () => launches.map(createTs),
    funders: () => [...funderRows].sort((a, b) => a.ts - b.ts),
    medianSolUsd: () => median(launches.flatMap((l) => l.events.filter((e) => e.kind === 'CREATE').map((e) => e.payload.solUsd)).filter((v): v is number => typeof v === 'number' && v > 0)),
    *launches() { yield* launches; },
    close: () => {},
  };
}

export async function openRecorded(file: string): Promise<RecordedSource> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`recorded input not found: ${abs}`);
  return looksLikeSqlite(abs) ? openSqlite(abs) : openJsonl(abs);
}

/** The row form late_rule.ts reads: [ts, isBuy, sol, tokens, user, virtualSol, virtualTokens, signature]. A launch with no CREATE has no start time and is skipped. */
export function recordedToLaunch(rec: RecordedLaunch): Launch | null {
  const create = rec.events.find((e) => e.kind === 'CREATE');
  if (!create) return null;
  const trades: TradeRow[] = [];
  for (const e of rec.events) {
    if (e.kind !== 'TRADE') continue;
    const p = e.payload;
    const vSol = Number(p.virtualSolReserves), vTok = Number(p.virtualTokenReserves);
    if (!(vSol > 0) || !(vTok > 0)) continue;
    trades.push([e.ts, !!p.isBuy, Number(p.solAmountLamports) / 1e9, Number(p.tokenAmount) / 1e6, String(p.user ?? ''), vSol, vTok, String(p.signature ?? '')]);
  }
  return { mint: rec.mint, symbol: String(create.payload.symbol ?? ''), creator: String(create.payload.creator ?? ''), mayhem: String(create.payload.tokenTotalSupply) === '2000000000000000', t0: create.ts, graduated: false, trades };
}

/** The train/test boundary: --split-ts (unix ms) if given, otherwise the 70th percentile of create times (5A: train = the older 70%, a 30% holdout). */
export function resolveSplit(arg: string | undefined, recorded: RecordedSource): { cut: number; note: string } {
  if (arg !== undefined && arg !== '') { const n = Number(arg); if (!Number.isFinite(n) || n <= 0) throw new Error(`--split-ts must be a unix time in milliseconds, got "${arg}"`); return { cut: n, note: 'from --split-ts' }; }
  const t = recorded.createTimes();
  if (!t.length) return { cut: 0, note: 'no launches recorded' };
  return { cut: t[Math.min(t.length - 1, Math.floor((t.length * 7) / 10))], note: '70th percentile of create times: a 30% holdout (pass --split-ts to choose)' };
}
