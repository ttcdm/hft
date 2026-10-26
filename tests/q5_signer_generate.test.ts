import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import { LocalKeypairSigner } from '../server/solana/signer';
import { scratchDir, startApp, type AppHandle } from './helpers/liveServer';

/**
 * Q5: POST /api/signer/generate used to replace the active key when it came from OPERATOR_PRIVATE_KEY (the env branch returned before
 * the key file path was set, so the default file did not exist and was written). Exits then signed with a different wallet.
 * Only freshly generated throwaway keys; the fs writes in the unit test are stubbed.
 */
const handles: AppHandle[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (handles.length) await handles.pop()!.stop(); });

describe('Q5: a loaded signing key is not swapped at runtime', () => {
  it('a signer loaded from the environment refuses to generate a new key, and writes nothing', () => {
    const key = Keypair.generate();
    vi.stubEnv('OPERATOR_PRIVATE_KEY', JSON.stringify(Array.from(key.secretKey)));
    vi.stubEnv('SIGNER_KEYPAIR_PATH', '');
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // no key file exists, which is the normal state when the key is in the environment
    const signer = new LocalKeypairSigner();
    expect(signer.getPublicKey().toBase58()).toBe(key.publicKey.toBase58());
    expect(() => signer.generateNewKeypair(false)).toThrow(/already exists/);
    expect(write).not.toHaveBeenCalled();
    expect(signer.getPublicKey().toBase58()).toBe(key.publicKey.toBase58());
  });

  it('a signer with no key at all can still generate one (first-run set-up)', () => {
    vi.stubEnv('OPERATOR_PRIVATE_KEY', '');
    vi.stubEnv('SOLANA_PRIVATE_KEY', '');
    vi.stubEnv('SIGNER_KEYPAIR_PATH', path.join(scratchDir('q5-'), 'new.json'));
    const signer = new LocalKeypairSigner();
    expect(signer.getStatus()).toBe('NOT_CONFIGURED');
    const pub = signer.generateNewKeypair(false);
    expect(signer.getPublicKey().toBase58()).toBe(pub);
  });

  it('over HTTP: with an environment key the route answers 409 and the active wallet does not change', async () => {
    const dir = scratchDir('q5http-');
    const key = Keypair.generate();
    const keyFile = path.join(dir, 'never-created.json');
    const app = await startApp(dir, { OPERATOR_PRIVATE_KEY: JSON.stringify(Array.from(key.secretKey)), SIGNER_KEYPAIR_PATH: keyFile });
    handles.push(app);
    const before = (await app.call('GET', '/api/diagnostics/system')).json.systemAudit?.walletPubkey;
    expect(before).toBe(key.publicKey.toBase58());
    const res = await app.call('POST', '/api/signer/generate', {});
    expect(res.status).toBe(409);
    expect(fs.existsSync(keyFile)).toBe(false);
    expect((await app.call('GET', '/api/diagnostics/system')).json.systemAudit?.walletPubkey).toBe(before);
  }, 90_000);
});
