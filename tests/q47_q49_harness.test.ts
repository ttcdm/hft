import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('Q47-Q49: the harness is hermetic and does not pass by default', () => {
  it('smoke.ts points every network setting at a closed loopback port', () => {
    const src = fs.readFileSync('scripts/smoke.ts', 'utf8');
    for (const k of ['SOLANA_RPC_URL', 'SOLANA_WS_URL', 'JITO_BLOCK_ENGINE_URL']) expect(src).toMatch(new RegExp(`${k}: '(http|ws)://127\\.0\\.0\\.1:9'`));
    expect(src).toMatch(/ALLOWED_CLUSTER: 'localnet'/);
  });
  it('no e2e script records a literal pass', () => {
    for (const f of ['scripts/localnet/e2e.ts', 'scripts/devnet_e2e.ts']) {
      expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/\brec\('[^']*', true,/);
    }
  });
  it('CI runs the localnet end-to-end', () => {
    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toMatch(/npm run localnet:e2e/);
  });
});
