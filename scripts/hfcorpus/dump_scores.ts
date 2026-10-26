import '../hermeticEnv';
import fs from 'fs';
import readline from 'readline';
import { replayLaunch } from '../../server/backtest/replay';
import { toRecordedLaunch, type CorpusLaunch } from './replay';

/** S197c: one CSV line per launch with the watch window's verdict and the confluence score at the end of the window (threshold 101 so nothing is released early as HOT). */
(async () => {
  const [file, out] = process.argv.slice(2);
  const w = fs.createWriteStream(out);
  w.write('mint,verdict,release_ms,score\n');
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const c: CorpusLaunch = JSON.parse(line);
    const r = replayLaunch(toRecordedLaunch(c, 150), [], 150, { minScore: 101 });
    w.write(`${c.mint},${r.verdict},${r.releasedAfterMs ?? ''},${r.score ?? ''}\n`);
  }
  w.end();
})();
