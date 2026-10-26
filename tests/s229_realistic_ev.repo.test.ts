import { describe, it, expect } from 'vitest';
import fs from 'fs';

/** Source scan: the two runners name their data source in every output, and the recordings wrapper never reads the corpus. */
describe('S229 realistic EV results are labelled and kept apart', () => {
  const recorded = fs.readFileSync('scripts/recorder_backtest/realistic_ev.ts', 'utf8');
  const corpus = fs.readFileSync('scripts/hfcorpus/realistic_ev.ts', 'utf8');
  const core = fs.readFileSync('scripts/hfcorpus/ev_study.ts', 'utf8');
  it('the recordings wrapper labels its results as its own and does not touch the corpus loader', () => {
    expect(recorded).toContain("RECORDED_SOURCE = 'own recordings (not the 39-day corpus)'");
    expect(recorded).toMatch(/source: RECORDED_SOURCE/);
    const imports = recorded.split('\n').filter((l) => /^import /.test(l)).join('\n');
    expect(imports).toContain("'../hfcorpus/ev_study'");
    expect(imports).not.toMatch(/hfcorpus\/(replay|realistic_ev)'/);
  });
  it('the corpus runner labels its results as the corpus and takes a launches file, never a recording', () => {
    expect(corpus).toContain("CORPUS_SOURCE = 'public 39-day corpus");
    expect(corpus).toMatch(/source: CORPUS_SOURCE/);
    expect(corpus.split('\n').filter((l) => /^import /.test(l)).join('\n')).not.toMatch(/recorder_backtest/);
    expect(corpus).not.toContain('openRecorded');
  });
  it('the core carries the source into the report and the CSV and writes only the three named files', () => {
    expect(core).toContain('source: meta.source');
    expect(core).toMatch(/out = \['source,split,/);
    const writes = [...core.matchAll(/fs\.writeFileSync\(([^,]+),/g)].map((m) => m[1]);
    expect(writes).toEqual(['`${prefix}.json`', '`${prefix}.md`', '`${prefix}_grid.csv`']);
  });
  it('contains no network calls and no real-money path', () => {
    for (const src of [recorded, corpus, core, fs.readFileSync('scripts/hfcorpus/ev_model.ts', 'utf8')]) expect(src).not.toMatch(/fetch\(|https?:\/\/|mainnet|Keypair|sendTransaction/i);
  });
});
