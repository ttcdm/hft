import { isReadOnly } from '../solana/readOnly';

/**
 * S190: how much of each launch, and how many rows in all, the launch recorder keeps. Everything is env-configurable.
 *
 * Defaults. Normal server: the 30 minutes the auto trader's exits run for, 14 days, 3,000,000 rows. Read-only (the paper copy that watches
 * mainnet to collect data): 180 minutes per launch, so a coin that only moves 1 to 2 hours after launch can still be replayed, 14 days, and
 * 6,000,000 rows.
 *
 * Disk. The recording measured about 333 bytes a row (3,000,000 rows is about 1 GB, with its two indexes), so 6,000,000 rows is about 2 GB.
 * At the old 30-minute window the paper copy wrote about 202,000 rows a day. A 180-minute window keeps trades up to 6 times as long, so the
 * day rate is between about 400,000 and 1,200,000 rows (most launches die within minutes and stop trading; the busy ones are the cost).
 * 6,000,000 rows is therefore about 5 to 15 days. The real rate is measured: System checks shows rows per hour and the days left at that rate.
 */
export interface RecorderConfig {
  mintMs: number;
  maxTradesPerMint: number;
  retentionDays: number;
  maxRows: number;
}

export const RECORD_DEFAULT_MINT_MINUTES = 30;
export const RECORD_READ_ONLY_MINT_MINUTES = 180;
export const RECORD_DEFAULT_MAX_ROWS = 3_000_000;
export const RECORD_READ_ONLY_MAX_ROWS = 6_000_000;
export const RECORD_DEFAULT_RETENTION_DAYS = 14;
/** Trades per launch per 30 minutes of window; scaled with the window so a 3 h window does not truncate a busy coin at the 30-minute number. */
export const RECORD_TRADES_PER_30_MIN = 2_000;

function intIn(raw: string | undefined, lo: number, hi: number): number | null {
  const t = (raw ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

export function recorderConfig(env: NodeJS.ProcessEnv = process.env): RecorderConfig {
  const ro = isReadOnly(env);
  const minutes = intIn(env.APEX_RECORD_MINT_MINUTES, 1, 1_440) ?? (ro ? RECORD_READ_ONLY_MINT_MINUTES : RECORD_DEFAULT_MINT_MINUTES);
  return {
    mintMs: minutes * 60_000,
    maxTradesPerMint: intIn(env.APEX_RECORD_MAX_TRADES_PER_MINT, 100, 1_000_000) ?? Math.max(RECORD_TRADES_PER_30_MIN, Math.ceil(minutes / 30) * RECORD_TRADES_PER_30_MIN),
    retentionDays: intIn(env.APEX_RECORD_RETENTION_DAYS, 1, 365) ?? RECORD_DEFAULT_RETENTION_DAYS,
    maxRows: intIn(env.APEX_RECORD_MAX_ROWS, 10_000, 200_000_000) ?? (ro ? RECORD_READ_ONLY_MAX_ROWS : RECORD_DEFAULT_MAX_ROWS),
  };
}

/** A setting that was present but unusable, for a startup warning. */
export function recorderConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const check = (name: string, lo: number, hi: number) => {
    const raw = (env[name] ?? '').trim();
    if (raw !== '' && intIn(raw, lo, hi) === null) out.push(`${name}=${raw} is ignored (a whole number from ${lo} to ${hi}); the default is used.`);
  };
  check('APEX_RECORD_MINT_MINUTES', 1, 1_440);
  check('APEX_RECORD_MAX_TRADES_PER_MINT', 100, 1_000_000);
  check('APEX_RECORD_RETENTION_DAYS', 1, 365);
  check('APEX_RECORD_MAX_ROWS', 10_000, 200_000_000);
  return out;
}

/** What the running recorder has done about its limits; System checks reads it. */
export interface RecorderRuntime {
  config: RecorderConfig;
  prunedRows: number;
  prunings: number;
  firstPruneAt: number | null;
  lastPruneAt: number | null;
  lastPruneRows: number;
}
let runtime: RecorderRuntime | null = null;
export function setRecorderRuntime(r: RecorderRuntime | null): void { runtime = r; }
export function getRecorderRuntime(): RecorderRuntime | null { return runtime; }
