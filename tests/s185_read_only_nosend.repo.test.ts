import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/** S185: the hard guarantee, as a source scan. The only code in the server that may reach the network with a signed transaction is
 *  server/solana/transports.ts, and each of those calls sits in a method whose first statement is assertNotReadOnly. */
const SINKS = /\b(sendRawTransaction|sendBundle|sendTransaction|sendEncodedTransaction|requestAirdrop|sendAndConfirmTransaction|sendAndConfirmRawTransaction|signAndSendTransaction)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('S185 no code path reaches a send in read-only mode', () => {
  const files = [...walk('server'), 'server.ts'];
  it('send sinks exist only in server/solana/transports.ts', () => {
    const offenders = files.filter((f) => !f.endsWith('transports.ts')).filter((f) => {
      const code = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      return SINKS.test(code);
    });
    expect(offenders).toEqual([]);
  });
  it('every sink in transports.ts is inside a method that calls assertNotReadOnly before it', () => {
    const src = fs.readFileSync('server/solana/transports.ts', 'utf8');
    const lines = src.split('\n');
    const sinkLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l) && SINKS.test(l));
    expect(sinkLines.length).toBeGreaterThan(0);
    for (const { i } of sinkLines) {
      // walk up to the enclosing `public async submit(` and require the guard to be there, ahead of the sink
      let start = i;
      while (start > 0 && !/^\s{2}(public |private )?(async )?\w+\(.*\{\s*$/.test(lines[start])) start--;
      const body = lines.slice(start, i).join('\n');
      expect(lines[start], `sink at line ${i + 1} is in ${lines[start].trim()}`).toMatch(/public async submit\(/);
      expect(body).toMatch(/assertNotReadOnly\(/);
    }
  });
  it('the only signer entry points guard themselves, and the coordinator guards the live submit', () => {
    const signer = fs.readFileSync('server/solana/signer.ts', 'utf8');
    for (const m of ['signTransaction', 'signMessage']) {
      const at = signer.indexOf(`public async ${m}(`);
      expect(signer.slice(at, at + 400)).toMatch(/assertNotReadOnly\(/);
    }
    const coord = fs.readFileSync('server/execution/coordinator.ts', 'utf8');
    const at = coord.indexOf('submitAndConfirmInner(');
    expect(coord.slice(coord.indexOf('submitAndConfirmInner(', at + 10), coord.indexOf('submitAndConfirmInner(', at + 10) + 1500)).toMatch(/assertNotReadOnly\(/);
  });
});
