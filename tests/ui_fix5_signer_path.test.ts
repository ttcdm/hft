import { describe, it, expect } from 'vitest';
import { LocalKeypairSigner } from '../server/solana/signer';
import { signerStorageText } from '../src/components/PlugAndPlayTradingModal';

/** UI status report 2026-10-26, fix 5: the Signer tab printed a fixed `.apex_trading_keypair.json` whatever SIGNER_KEYPAIR_PATH said. */
describe('UI fix 5: the Signer tab shows the configured key location', () => {
  it('the signer reports the file it reads (SIGNER_KEYPAIR_PATH), and NONE when no key loaded', () => {
    const s = new LocalKeypairSigner();
    expect(s.getKeyLocation()).toEqual({ source: 'NONE', path: process.env.SIGNER_KEYPAIR_PATH });
  });
  it('the tab text comes from the server answer', () => {
    expect(signerStorageText({ signerKeySource: 'FILE', signerKeyPath: '/srv/keys/devnet.json' })).toBe('/srv/keys/devnet.json (mode 0600)');
    expect(signerStorageText({ signerKeySource: 'ENVIRONMENT', signerKeyPath: '/x.json' })).toBe('environment variable (not a file)');
    expect(signerStorageText(null)).toMatch(/unknown/);
  });
});
