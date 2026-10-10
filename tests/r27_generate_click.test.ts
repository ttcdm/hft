import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

// R27: `onClick={handleGenerateKeypair}` handed the React click event in as `forceOverwrite`; JSON.stringify of that event throws
// (circular fiber), so the button always errored. There is no DOM test environment and clicking the button in a browser run would
// write a keypair file, so this is a source check of the call shape (labelled as such); the fixture harness deliberately does not click it.
describe('R27: Generate Keypair does not pass the click event as forceOverwrite', () => {
  const src = fs.readFileSync('src/components/PlugAndPlayTradingModal.tsx', 'utf8');
  it('the handler is called with an explicit boolean from the button', () => {
    expect(src).not.toMatch(/onClick=\{handleGenerateKeypair\}/);
    expect(src).toMatch(/onClick=\{\(\) => handleGenerateKeypair\(false\)\}/);
  });
  it('every other use of the handler also passes a boolean', () => {
    for (const m of src.matchAll(/handleGenerateKeypair\(([^)]*)\)/g)) expect(m[1]).toMatch(/^(true|false|forceOverwrite)?$/);
  });
});
