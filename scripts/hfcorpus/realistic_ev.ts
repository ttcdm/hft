import '../hermeticEnv';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { toRecordedLaunch, type CorpusLaunch } from './replay';
import { runStudy, parseOptions, writeStudyFiles, utcDay, fmtPct, type StudyLaunch } from './ev_study';

/**
 * S229: realistic EV replay over the public 39-day Slinky21/Pumpfun_Memecoin_Corpus (launches + trades only, rebuilt with export_launches.py).
 * The cost model, latency model and out-of-sample method are in ev_model.ts / ev_study.ts; the same core runs on the app's own recordings from
 * scripts/recorder_backtest/realistic_ev.ts. The two are different data sources and their results are never merged: every output file names its source.
 *   python3 scripts/hfcorpus/export_launches.py --data-dir DIR --out launches.jsonl
 *   npx tsx scripts/hfcorpus/realistic_ev.ts launches.jsonl [--out-dir DIR] [--thresholds 50,52,...] [--sizes ...] [--sample-pct 100] [--limit N] [--sol-usd 150] [--split-ts ms]
 * Default train/test boundary: launches before 2026-07-05 UTC are train (the cut the earlier corpus studies used). The corpus has breaks on Jun 25 and Jul 4 (see backtests/hf39d/SUMMARY.md).
 */
export const CORPUS_SOURCE = 'public 39-day corpus (Slinky21/Pumpfun_Memecoin_Corpus)';
export const CORPUS_SPLIT_TS = Date.UTC(2026, 6, 5);

async function* lines(file: string, samplePct: number, solUsd: number | null): AsyncGenerator<StudyLaunch> {
  let i = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    if (!line) continue;
    if (samplePct < 100 && (i++ * 37) % 100 >= samplePct) continue; // 37 is coprime with 100: a spread-out, repeatable sample
    const c: CorpusLaunch = JSON.parse(line);
    yield { rec: toRecordedLaunch(c, solUsd), t0: c.t0, trades: c.trades };
  }
}

async function dayRange(file: string): Promise<[number, number]> {
  let lo = Infinity, hi = -Infinity;
  for await (const line of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    const m = /"t0":\s*(\d+)/.exec(line);
    if (!m) continue;
    const d = utcDay(Number(m[1]));
    if (d < lo) lo = d; if (d > hi) hi = d;
  }
  if (!Number.isFinite(lo)) throw new Error('no launches with a t0 in the input');
  return [lo, hi];
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
  if (!file) throw new Error('usage: realistic_ev.ts <launches.jsonl> [--out-dir DIR] [--thresholds ...] [--sizes ...] [--sample-pct n] [--limit n] [--sol-usd n] [--split-ts ms]');
  if (!fs.existsSync(file)) throw new Error(`launches file not found: ${file}`);
  const { opt, options } = parseOptions(args, { splitTs: CORPUS_SPLIT_TS });
  const samplePct = Number(opt('sample-pct', '100'));
  const outDir = opt('out-dir', '/tmp/hf_realistic_ev');
  fs.mkdirSync(outDir, { recursive: true });
  const [firstDay, lastDay] = await dayRange(file);
  const started = Date.now();
  const { report, totals } = await runStudy({
    launches: lines(file, samplePct, options.solUsd), firstDay, lastDay, options, limit: Number(opt('limit', '0')) || undefined,
    source: CORPUS_SOURCE,
    note: `Results for the public 39-day corpus only${samplePct < 100 ? ` (${samplePct}% sample of launches)` : ''}. They are not comparable with, and are never merged into, the own-recordings results.`,
    splitNote: options.splitTs === CORPUS_SPLIT_TS ? 'launches before 2026-07-05 UTC' : 'from --split-ts',
    onProgress: (n) => console.error(`${n} launches, ${((Date.now() - started) / 1000).toFixed(0)}s`),
  });
  const written = writeStudyFiles(path.join(outDir, 'realistic_ev'), report, totals, fs);
  const head = report.scenarios.find((s) => s.latency === '1.5s/1.5s' && s.cost === 'rpc_1.25')?.chosen;
  console.log(`${report.source}: ${report.launches} launches; headline (1.5s/1.5s, rpc_1.25): ` + (head ? `thr ${head.threshold}, ${head.sizeSol} SOL, ${head.variant}: train ${fmtPct(head.train.evPct)} (${head.train.entries}), test ${fmtPct(head.test.evPct)} (${head.test.entries})` : 'no setting reached the minimum train entries'));
  console.log(written.join('\n'));
}
if (process.argv[1] && /hfcorpus[\\/]realistic_ev\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
