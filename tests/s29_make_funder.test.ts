import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import { makeFunder, loadFunderKeypair, MAX_MAKE_FUNDER_SOL, DEVNET_GENESIS_HASH, SeedGuardError } from '../scripts/devnet_seed';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 's29-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeChain(opts: { genesis?: string; balanceLamports?: number } = {}) {
  const sent: Transaction[] = [];
  const conn: any = {
    getGenesisHash: vi.fn(async () => opts.genesis ?? DEVNET_GENESIS_HASH),
    getBalance: vi.fn(async () => opts.balanceLamports ?? 2_000_000_000),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 })),
    sendRawTransaction: vi.fn(async (raw: Buffer) => { sent.push(Transaction.from(raw)); return 'S'.repeat(64); }),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] })),
  };
  return { conn, sent };
}
const app = Keypair.generate();
const signer = { publicKey: app.publicKey, sign: async (tx: Transaction) => { tx.partialSign(app); } };
const base = (file: string, over: Record<string, unknown> = {}) => ({ signer, allowedGenesis: DEVNET_GENESIS_HASH, file, fundSol: 0.2, autoOffConfirmed: true, appDbPath: null, sleep: async () => undefined, ...over });

describe('S29: devnet_seed --make-funder', () => {
  it('writes a 0600 key in a 0700 directory, sends exactly the amount to its public key, and returns only the public key', async () => {
    const { conn, sent } = fakeChain();
    const file = path.join(root, 'keys', 'f.json');
    const r = await makeFunder({ ...base(file), connection: conn });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(loadFunderKeypair(file).publicKey.toBase58()).toBe(r.pubkey);
    const ix = sent[0].instructions[0];
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(Buffer.from(ix.data).readBigUInt64LE(4)).toBe(200_000_000n);
    expect(ix.keys[0].pubkey.equals(app.publicKey)).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(r.pubkey);
    expect(JSON.stringify(r)).not.toContain(JSON.stringify(Array.from(fs.readFileSync(file)).slice(0, 4)));
  });

  it('refuses before writing or sending: over the cap, non-positive, NaN, auto not confirmed off, file exists, wrong genesis, low balance', async () => {
    const cases: Array<[string, Record<string, unknown>, ReturnType<typeof fakeChain>?]> = [
      ['over cap', { fundSol: MAX_MAKE_FUNDER_SOL + 0.01 }],
      ['zero', { fundSol: 0 }],
      ['NaN', { fundSol: NaN }],
      ['auto not confirmed off', { autoOffConfirmed: false }],
      ['wrong genesis', {}, fakeChain({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' })],
      ['low balance', { fundSol: 0.2 }, fakeChain({ balanceLamports: 200_000_000 })],
    ];
    for (const [name, over, chain] of cases) {
      const c = chain ?? fakeChain();
      const file = path.join(root, `r-${name.replace(/\W/g, '')}.json`);
      await expect(makeFunder({ ...base(file, over), connection: c.conn }), name).rejects.toBeInstanceOf(SeedGuardError);
      expect(fs.existsSync(file), `${name}: no key written`).toBe(false);
      expect(c.sent.length, `${name}: nothing sent`).toBe(0);
    }
    const existing = path.join(root, 'exists.json');
    fs.writeFileSync(existing, 'keep me', { mode: 0o600 });
    const c = fakeChain();
    await expect(makeFunder({ ...base(existing), connection: c.conn })).rejects.toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep me');
    expect(c.sent.length).toBe(0);
  });

  it('exactly the cap is allowed', async () => {
    const { conn, sent } = fakeChain();
    await makeFunder({ ...base(path.join(root, 'cap.json'), { fundSol: MAX_MAKE_FUNDER_SOL }), connection: conn });
    expect(Buffer.from(sent[0].instructions[0].data).readBigUInt64LE(4)).toBe(500_000_000n);
  });

  it('a repository path that git does not ignore is refused; .overnight/seed-funder*.json is ignored', async () => {
    const c = fakeChain();
    const bad = path.join(process.cwd(), 'tests', `s29-leak-${process.pid}.json`);
    await expect(makeFunder({ ...base(bad), connection: c.conn })).rejects.toThrow(/not ignored/);
    expect(fs.existsSync(bad)).toBe(false);
    const ok = path.join(process.cwd(), '.overnight', `seed-funder-s29-${process.pid}.json`);
    try { await makeFunder({ ...base(ok), connection: c.conn }); expect(fs.existsSync(ok)).toBe(true); }
    finally { fs.rmSync(ok, { force: true }); }
  });
});
