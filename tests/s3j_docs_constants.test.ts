import '../suppress-warnings.cjs';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WATCH_MIN_MS, WATCH_MAX_MS } from '../server/signals/watchWindow';
import { FEED_SLOT_SILENCE_MS, FEED_SLOT_JUMP_MAX } from '../server/solana/pumpFeedListener';
import { FUNDER_RETRY_DELAYS_MS, FUNDER_LOOKUP_CONCURRENCY, FUNDER_LOOKUP_MAX_PER_MINT } from '../server/signals/funderLookup';
import { RELEASE_RETRY_MS, PENDING_RELEASE_MAX_AGE_MS, DEVNET_MAX_OPEN_POSITIONS } from '../server/auto/controller';
import { riskEngine, DAILY_LOSS_WINDOW_MS, DAILY_LOSS_PRICE_MAX_AGE_MS, WORST_CASE_LOSS_FRACTION } from '../server/risk/riskEngine';
import { SOL_PRICE_MAX_AGE_MS, SOL_PRICE_ANCHOR_MAX_AGE_MS } from '../server/market/solPriceService';
import { GENESIS_CHECK_TTL_MS } from '../server/solana/clusterGuard';
import { WorkstationDatabase } from '../server/db/database';
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS, RPC_READ_TRIES, SLOW_READ_TIMEOUT_MS, DEFAULT_RPC_LIMITER_MAX_WAIT_MS } from '../server/solana/rpcConnection';
import {
  SELL_RATE_LIMIT_BACKOFF_MS, EXIT_RATE_LIMITED_WAIT_MS, EXIT_SELL_WAIT_MS, MARK_STALE_MS, MARK_RETRY_BASE_MS, MARK_RETRY_MAX_MS,
  MARK_ALERT_AFTER_MS, EXIT_RETRY_BASE_MS, EXIT_RETRY_MAX_MS, SELL_SLIPPAGE_LADDER_BPS,
} from '../server/execution/coordinator';
import { PANIC_BUY_SETTLE_WAIT_MS } from '../server/execution/emergencyStop';
import { READINESS_RED_LIMIT_MS, WALLET_AUDIT_BASE_TOLERANCE_SOL } from '../server/auto/killSwitch';
import { CONFLUENCE_DEVNET_LIVE_FLOOR } from '../server/signals/confluenceThreshold';
import { LOGIN_RATE_LIMIT } from '../server/middleware/enterprise';

/**
 * 3J: every constant that docs/LATENCY.md, docs/RUNBOOK.md and docs/ARCHITECTURE.md state a value for has that value in the code, and the
 * document still states it. A change to the constant fails the first check; a rewrite of the document that drops or changes the figure
 * fails the second. Constants that are not exported are read from the source text with a pattern that must match exactly once.
 * Also: every repository path those documents name exists, and every `file:line` in LATENCY.md points inside the file.
 */
const read = (f: string) => fs.readFileSync(f, 'utf8');
const doc = { latency: read('docs/LATENCY.md'), runbook: read('docs/RUNBOOK.md'), arch: read('docs/ARCHITECTURE.md'), env: read('docs/ENV.md') };

/** The value of a constant that is not exported: the first capture group of a pattern over the file's source. */
function fromSource(file: string, re: RegExp): string {
  const m = re.exec(read(file));
  expect(m, `${re} in ${file}`).not.toBeNull();
  return m![1];
}
const num = (s: string) => Number(s.replace(/_/g, ''));
const limits = riskEngine.getLimits();

type Row = [name: string, actual: unknown, expected: unknown, document: keyof typeof doc, phrase: string];
const rows: Row[] = [
  ['WATCH_MIN_MS', WATCH_MIN_MS, 20_000, 'latency', '20 s and 120 s from the first trade'],
  ['WATCH_MAX_MS', WATCH_MAX_MS, 120_000, 'latency', '20 s and 120 s from the first trade'],
  ['FEED_SLOT_SILENCE_MS', FEED_SLOT_SILENCE_MS, 10_000, 'latency', '10 s without a slot notification'],
  ['FEED_SLOT_JUMP_MAX', FEED_SLOT_JUMP_MAX, 25, 'latency', 'more than 25 slots'],
  ['FUNDER_RETRY_DELAYS_MS', FUNDER_RETRY_DELAYS_MS, [1_500, 4_000, 10_000], 'latency', 'after 1.5 s, 4 s and 10 s'],
  ['FUNDER_LOOKUP_CONCURRENCY', FUNDER_LOOKUP_CONCURRENCY, 4, 'latency', '4 lookups at a time'],
  ['FUNDER_LOOKUP_MAX_PER_MINT', FUNDER_LOOKUP_MAX_PER_MINT, 150, 'latency', '150 per mint'],
  ['RELEASE_RETRY_MS', RELEASE_RETRY_MS, 2_000, 'latency', '2 s (`RELEASE_RETRY_MS`)'],
  ['PENDING_RELEASE_MAX_AGE_MS', PENDING_RELEASE_MAX_AGE_MS, 6_000, 'latency', 'younger than 6 s'],
  ['maxSignalAgeMs', limits.maxSignalAgeMs, 8_000, 'latency', '8 s (`maxSignalAgeMs: 8000`)'],
  ['maxDataAgeMs', limits.maxDataAgeMs, 5_000, 'latency', '5 s (`maxDataAgeMs: 5000`)'],
  ['cooldownAfterFailedTradeMs', limits.cooldownAfterFailedTradeMs, 15_000, 'latency', '15 s, global'],
  ['cooldownPerMintMs', limits.cooldownPerMintMs, 30_000, 'latency', '30 s after a buy'],
  ['eligibility report age', num(fromSource('server/execution/coordinator.ts', /evaluatedAt > (\d+)\)/)), 60_000, 'latency', '| Eligibility report age | 60 s |'],
  ['SOL_PRICE_MAX_AGE_MS', SOL_PRICE_MAX_AGE_MS, 120_000, 'latency', '120 s (`SOL_PRICE_MAX_AGE_MS`)'],
  ['SOL_PRICE_ANCHOR_MAX_AGE_MS', SOL_PRICE_ANCHOR_MAX_AGE_MS, 600_000, 'latency', 'under 10 min old'],
  ['DAILY_LOSS_WINDOW_MS', DAILY_LOSS_WINDOW_MS, 24 * 3_600_000, 'latency', '24 h rolling'],
  ['DAILY_LOSS_PRICE_MAX_AGE_MS', DAILY_LOSS_PRICE_MAX_AGE_MS, 3_600_000, 'latency', 'older than 1 h'],
  ['WORST_CASE_LOSS_FRACTION', WORST_CASE_LOSS_FRACTION, 1, 'arch', '`WORST_CASE_LOSS_FRACTION` = 1'],
  ['GENESIS_CHECK_TTL_MS', GENESIS_CHECK_TTL_MS, 60_000, 'latency', '60 s per Connection'],
  ['blockhash check retry', num(fromSource('server/solana/clusterGuard.ts', /await sleep\((\d+)\)/)), 500, 'latency', 'a second after 500 ms'],
  ['WRITABLE_CACHE_MS', WorkstationDatabase.WRITABLE_CACHE_MS, 1_000, 'latency', 'reused for 1 s'],
  ['MIN_FREE_BYTES', WorkstationDatabase.MIN_FREE_BYTES, 16 * 1024 * 1024, 'latency', 'needs 16 MiB free'],
  ['DEFAULT_RPC_REQUEST_TIMEOUT_MS', DEFAULT_RPC_REQUEST_TIMEOUT_MS, 1_500, 'latency', '1.5 s per request'],
  ['RPC_READ_TRIES', RPC_READ_TRIES, 2, 'latency', 'reads are tried twice'],
  ['SLOW_READ_TIMEOUT_MS', SLOW_READ_TIMEOUT_MS, 10_000, 'latency', 'slow reads 10 s'],
  ['DEFAULT_RPC_LIMITER_MAX_WAIT_MS', DEFAULT_RPC_LIMITER_MAX_WAIT_MS, 3_000, 'latency', '3 s for a slot'],
  ['RPC_FALLBACK_TIMEOUT_MS default', num(fromSource('server/solana/executionConfig.ts', /RPC_FALLBACK_TIMEOUT_MS \|\| '(\d+)'/)), 15_000, 'latency', '15 s (`RPC_FALLBACK_TIMEOUT_MS`)'],
  ['confirm poll', num(fromSource('server/solana/transports.ts', /confirmPacing\.sleep\((\d+)\)/)), 400, 'latency', 'status poll every 400 ms'],
  ['resend interval', num(fromSource('server/solana/transports.ts', /resendEveryMs \?\? ([\d_]+)/)), 1_500, 'latency', 'resent every 1.5 s'],
  ['blockhash watch extension', num(fromSource('server/solana/transports.ts', /maxExtendMs \?\? ([\d_]+)/)), 60_000, 'latency', 'extended by up to 60 s'],
  ['SELL_RATE_LIMIT_BACKOFF_MS', [...SELL_RATE_LIMIT_BACKOFF_MS], [500, 1_000, 2_000], 'latency', 'after 0.5 s, 1 s and 2 s'],
  ['EXIT_RATE_LIMITED_WAIT_MS', EXIT_RATE_LIMITED_WAIT_MS, 6_000, 'latency', '6 s flat'],
  ['exit pass interval', num(fromSource('server/execution/coordinator.ts', /autoTpSlInterval = setInterval\(async \(\) => \{[\s\S]*?\n {4}\}, (\d+)\);/)), 3_000, 'latency', 'every 3 s'],
  ['EXIT_SELL_WAIT_MS', EXIT_SELL_WAIT_MS, 2_500, 'latency', 'at most 2.5 s'],
  ['MARK_STALE_MS', MARK_STALE_MS, 15_000, 'latency', '15 s (`MARK_STALE_MS`)'],
  ['MARK_RETRY_BASE_MS', MARK_RETRY_BASE_MS, 60_000, 'latency', '60 s doubling to 10 min'],
  ['MARK_RETRY_MAX_MS', MARK_RETRY_MAX_MS, 600_000, 'latency', '60 s doubling to 10 min'],
  ['MARK_ALERT_AFTER_MS', MARK_ALERT_AFTER_MS, 60_000, 'latency', '60 s without a mark'],
  ['mark feed STALE', num(fromSource('server/execution/coordinator.ts', /markAge > (\d+)\) \{\s*\n\s*this\.positionMarkHealth = 'STALE'/)), 90_000, 'latency', 'STALE after 90 s'],
  ['mark feed DEGRADED', num(fromSource('server/execution/coordinator.ts', /markAge > (\d+)\) \{\s*\n\s*this\.positionMarkHealth = 'DEGRADED'/)), 45_000, 'latency', 'DEGRADED after 45 s'],
  ['EXIT_RETRY_BASE_MS', EXIT_RETRY_BASE_MS, 3_000, 'latency', '3 s doubling to 30 s'],
  ['EXIT_RETRY_MAX_MS', EXIT_RETRY_MAX_MS, 30_000, 'latency', '3 s doubling to 30 s'],
  ['SELL_SLIPPAGE_LADDER_BPS', [...SELL_SLIPPAGE_LADDER_BPS], [800, 1_500, 2_500, 4_000], 'latency', 'slippage 800, 1500, 2500, 4000 bps'],
  ['PENDING_SELL_WINDOW_MS', num(fromSource('server/execution/coordinator.ts', /const PENDING_SELL_WINDOW_MS = ([\d_]+)/)), 100_000, 'latency', '100 s after the confirm gave up'],
  ['EXIT_CLAIM_STALE_MS', num(fromSource('server/execution/coordinator.ts', /const EXIT_CLAIM_STALE_MS = (\d+) \* PENDING_SELL_WINDOW_MS/)) * 100_000, 200_000, 'latency', 'stale after 200 s'],
  ['RPC heartbeat', num(fromSource('server/execution/coordinator.ts', /setInterval\(checkFeed, (\d+)\)/)), 10_000, 'latency', 'every 10 s a `getSlot`'],
  ['RPC DEGRADED above', num(fromSource('server/execution/coordinator.ts', /this\.rpcLatencyMs > (\d+) \? 'DEGRADED'/)), 800, 'latency', 'over 800 ms is `DEGRADED`'],
  ['READINESS_RED_LIMIT_MS', READINESS_RED_LIMIT_MS, 10_000, 'latency', '10 s (`READINESS_RED_LIMIT_MS`)'],
  ['orphanRecoveryDelaysMs', JSON.parse(`[${fromSource('server/execution/coordinator.ts', /orphanRecoveryDelaysMs: number\[\] = \[([\d_, ]+)\]/).replace(/_/g, '')}]`), [5_000, 15_000, 45_000, 120_000, 300_000], 'latency', 'after 5, 15, 45, 120 and 300 s'],
  ['ORPHAN_MAX_AGE_MS', num(fromSource('server/execution/coordinator.ts', /const ORPHAN_MAX_AGE_MS = (\d+) \* 60_000/)) * 60_000, 15 * 60_000, 'latency', 'the row is 15 min old (`ORPHAN_MAX_AGE_MS`)'],
  ['reconcileTimeoutMs', num(fromSource('server/execution/coordinator.ts', /private reconcileTimeoutMs = ([\d_]+)/)), 90_000, 'latency', '90 s (`reconcileTimeoutMs`)'],
  ['reconcile retry', num(fromSource('server/execution/coordinator.ts', /scheduleReconcileRetry\(delayMs = ([\d_]+)\)/)), 15_000, 'latency', 'retried after 15 s'],
  ['PumpSwap CACHE_TTL_MS', num(fromSource('server/solana/pumpSwapService.ts', /CACHE_TTL_MS = (\d+)/)), 15_000, 'latency', '15 s (`CACHE_TTL_MS`)'],
  ['PANIC_BUY_SETTLE_WAIT_MS', PANIC_BUY_SETTLE_WAIT_MS.value, 30_000, 'latency', '30 s (`PANIC_BUY_SETTLE_WAIT_MS`)'],
  ['PANIC_BUY_SETTLE_WAIT_MS (runbook)', PANIC_BUY_SETTLE_WAIT_MS.value, 30_000, 'runbook', 'up to 30 s (`PANIC_BUY_SETTLE_WAIT_MS`)'],
  ['pending sell (runbook)', num(fromSource('server/execution/coordinator.ts', /const PENDING_SELL_WINDOW_MS = ([\d_]+)/)), 100_000, 'runbook', 'up to 100 s for a pending sell'],
  ['WALLET_AUDIT_BASE_TOLERANCE_SOL', WALLET_AUDIT_BASE_TOLERANCE_SOL, 0.0005, 'runbook', 'A difference above 0.0005 SOL'],
  ['LOGIN_RATE_LIMIT attempts', LOGIN_RATE_LIMIT.maxTokens, 5, 'env', '5 attempts, then one every 12 s'],
  ['LOGIN_RATE_LIMIT refill', Math.round(1 / LOGIN_RATE_LIMIT.refillRatePerSec), 12, 'env', 'one every 12 s'],
  ['CONFLUENCE_DEVNET_LIVE_FLOOR', CONFLUENCE_DEVNET_LIVE_FLOOR, 50, 'arch', '`CONFLUENCE_DEVNET_LIVE_FLOOR` (50)'],
  ['DEVNET_MAX_OPEN_POSITIONS', DEVNET_MAX_OPEN_POSITIONS, 1, 'arch', 'one open position (`DEVNET_MAX_OPEN_POSITIONS`)'],
];

describe('constants named in the docs have the value the docs state', () => {
  it('has a useful number of rows (so a broken extraction cannot pass by matching nothing)', () => {
    expect(rows.length).toBeGreaterThan(50);
  });

  it.each(rows.map((r) => [r[0], r[1], r[2]]))('%s in the code is %j', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  it.each(rows.map((r) => [r[0], r[3], r[4]]))('%s: the document still says %j', (_name, which, phrase) => {
    expect(doc[which as keyof typeof doc], `${which} should contain: ${phrase}`).toContain(phrase as string);
  });
});

describe('paths and file:line references in LATENCY.md and RUNBOOK.md', () => {
  const targets: Array<[string, string]> = [['docs/LATENCY.md', doc.latency], ['docs/RUNBOOK.md', doc.runbook]];

  for (const [name, text] of targets) {
    const prose = text.replace(/```[\s\S]*?```/g, '');
    const tokens = [...new Set([...prose.matchAll(/`([A-Za-z0-9_.\-/]+)(?::\d+)?`/g)].map((m) => m[1]))]
      .filter((t) => (t.includes('/') || /\.(ts|tsx|md|cjs|mjs|json)$/.test(t)) && !t.startsWith('/') && !t.startsWith('$') && !/^(api|GET|POST)/.test(t) && !/apex_trading_keypair/.test(t)); // the keypair file is a runtime file, not in the repository

    it(`${name} names a useful number of repo paths`, () => {
      expect(tokens.length).toBeGreaterThan(name.includes('LATENCY') ? 15 : 2);
    });

    it.each(tokens)(`${name}: path %s exists`, (p) => {
      const rel = p.replace(/\/$/, '');
      expect(fs.existsSync(rel) || fs.existsSync(path.join('docs', rel)), `${rel} is named in ${name} but does not exist`).toBe(true);
    });
  }

  const refs = [...doc.latency.matchAll(/`([A-Za-z0-9_./-]+\.tsx?):(\d+)`/g)].map((m) => [m[1], Number(m[2])] as [string, number]);
  it('LATENCY.md has file:line references to check', () => {
    expect(refs.length).toBeGreaterThan(40);
  });
  it.each(refs)('%s:%i is inside the file and not blank', (file, line) => {
    const lines = read(file).split('\n');
    expect(line).toBeGreaterThan(0);
    expect(line).toBeLessThanOrEqual(lines.length);
    expect(lines[line - 1].trim().length, `${file}:${line} is blank`).toBeGreaterThan(0);
  });
});
