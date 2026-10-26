import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as web3 from '@solana/web3.js';
import { makeChainKit, writeKeyFile } from '../scripts/devnet_e2e_steps';

// Mike (2026-10-24): every temporary wallet the harness makes has its key on disk before it can receive SOL, and keeps it there.
describe('S249: the devnet harness writes every throwaway wallet key before returning it', () => {
  const kitIn = (keyDir: string) => makeChainKit({ conn: {}, web3, sdk: {}, curve: {}, builder: {}, keyDir });

  it('newWallet writes <keyDir>/<pubkey>.json (0600) holding that keypair', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's249-')), 'temp-wallets');
    const kit = kitIn(dir);
    const a = kit.newWallet();
    const b = kit.newWallet();
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
    for (const w of [a, b]) {
      const file = path.join(dir, `${w.publicKey.toBase58()}.json`);
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
      const back = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
      expect(back.publicKey.equals(w.publicKey)).toBe(true);
    }
    expect(fs.readdirSync(dir).sort()).toEqual([a, b].map((w) => `${w.publicKey.toBase58()}.json`).sort());
  });

  it('a key that cannot be written is never handed out', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 's249-'));
    const blocker = path.join(base, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    expect(() => kitIn(blocker).newWallet()).toThrow();
  });

  it('S268: writeKeyFile syncs, reads back, and with wx never overwrites an existing key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's268-'));
    const f = path.join(dir, 'k.json');
    const a = web3.Keypair.generate();
    writeKeyFile(f, a, 'wx');
    expect(web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8')))).publicKey.equals(a.publicKey)).toBe(true);
    expect((fs.statSync(f).mode & 0o777).toString(8)).toBe('600');
    expect(() => writeKeyFile(f, web3.Keypair.generate(), 'wx')).toThrow(); // the first key stays
    expect(web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8')))).publicKey.equals(a.publicKey)).toBe(true);
  });
});
