import '../hermeticEnv';
import fs from 'fs';
import path from 'path';
import { openRecorded, recordedToLaunch, resolveSplit } from './recorded';
import { runStudy, parseOptions, writeStudyFiles, fmtPct, DAY_MS, type StudyLaunch } from '../hfcorpus/ev_study';

/**
 * S229: the realistic EV replay (cost model, 3 s exit polling, own-order impact, out-of-sample selection; see scripts/hfcorpus/ev_model.ts) on the app's OWN
 * launch recordings. The core is shared with scripts/hfcorpus/realistic_ev.ts; this wrapper only supplies the data. Output files are labelled
 * "own recordings (not the 39-day corpus)" and are never merged with the corpus results.
 *   npx tsx scripts/recorder_backtest/realistic_ev.ts --recorded <paper.db | snapshot.jsonl> [--out-dir DIR] [--thresholds ...] [--sizes ...] [--limit n] [--sol-usd n] [--split-ts ms] [--block-hours 1]
 * Train/test: --split-ts, else the 75th percentile of create times. Recordings made with the old 30-minute window show short or truncated launches; launches whose
 * recording ended before the watch window gave a verdict simply never enter.
 */
export const RECORDED_SOURCE = 'own recordings (not the 39-day corpus)';

async function main() {
  const args = process.argv.slice(2);
  const rIdx = args.indexOf('--recorded');
  const recordedPath = rIdx >= 0 ? args[rIdx + 1] : '';
  if (!recordedPath) throw new Error('usage: realistic_ev.ts --recorded <paper.db|snapshot.jsonl> [--out-dir DIR] [--thresholds ...] [--sizes ...] [--limit n] [--sol-usd n] [--split-ts ms]');
  const source = await openRecorded(recordedPath);
  const splitArg = args.indexOf('--split-ts') >= 0 ? args[args.indexOf('--split-ts') + 1] : undefined;
  const split = resolveSplit(splitArg, source);
  const { opt, options } = parseOptions(args, { splitTs: split.cut, blockHours: 1 });
  const fallbackUsd = options.solUsd === null ? source.medianSolUsd() : options.solUsd;
  const times = source.createTimes();
  if (!times.length) throw new Error('the recording has no launches');
  const outDir = opt('out-dir', '/tmp/recorded_realistic_ev');
  fs.mkdirSync(outDir, { recursive: true });
  function* launches(): Generator<StudyLaunch> {
    for (const rec of source.launches()) {
      const l = recordedToLaunch(rec);
      if (l) yield { rec, t0: l.t0, trades: l.trades };
    }
  }
  const started = Date.now();
  const { report, totals } = await runStudy({
    launches: launches(), firstDay: Math.floor(times[0] / (options.blockMs as number)), lastDay: Math.floor(times[times.length - 1] / (options.blockMs as number)), options: { ...options, solUsd: fallbackUsd }, limit: Number(opt('limit', '0')) || undefined,
    source: RECORDED_SOURCE,
    note: 'Results for the app\'s own launch recordings only, a different data source from the public 39-day corpus. They are never merged with, or compared as if equal to, the corpus results.',
    splitNote: split.note, onProgress: (n) => console.error(`${n} launches, ${((Date.now() - started) / 1000).toFixed(0)}s`),
  });
  source.close();
  const written = writeStudyFiles(path.join(outDir, 'realistic_ev'), report, totals, fs);
  const head = report.scenarios.find((s) => s.latency === '1.5s/1.5s' && s.cost === 'rpc_1.25')?.chosen;
  console.log(`${report.source}: ${report.launches} launches over ${((times[times.length - 1] - times[0]) / DAY_MS).toFixed(1)} days; headline (1.5s/1.5s, rpc_1.25): ` + (head ? `thr ${head.threshold}, ${head.sizeSol} SOL, ${head.variant}: train ${fmtPct(head.train.evPct)} (${head.train.entries}), test ${fmtPct(head.test.evPct)} (${head.test.entries})` : 'no setting reached the minimum train entries'));
  console.log(written.join('\n'));
}
if (process.argv[1] && /recorder_backtest[\\/]realistic_ev\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
