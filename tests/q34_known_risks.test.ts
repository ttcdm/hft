import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('Q34: the do-nothing settings are documented and still do nothing (so the doc is true)', () => {
  const doc = fs.readFileSync('KNOWN_RISKS.md', 'utf8');
  it.each(['snipeThresholdScore', 'autoForwardAlerts', 'webhookActive', 'isAutoSnipeEnvEnabled', 'isAutoSnipeSubscribed', 'requireMintRevoked', 'ENABLE_SYNTHETIC_SOCIAL'])('%s is listed', (k) => {
    expect(doc).toContain(k);
  });
  it('isAutoSnipeEnvEnabled has no caller', () => {
    const hits = ['server.ts', ...fs.readdirSync('server').filter((f) => f.endsWith('.ts')).map((f) => `server/${f}`)].flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('isAutoSnipeEnvEnabled')));
    expect(hits.length).toBe(1); // only its definition
  });
  it('enableSyntheticSocial is never read outside its definition', () => {
    const src = fs.readFileSync('server/solana/executionConfig.ts', 'utf8');
    expect(src.split('enableSyntheticSocial').length - 1).toBe(2); // type + assignment
  });
});
