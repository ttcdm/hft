import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { Keypair, Transaction } from '@solana/web3.js';
import { DEVNET_GENESIS_HASH, SeedGuardError, withRetry, retryingConnection, saveWalletFile, loadWalletFile, loadFunderKeypair, sweepFromFile, DEFAULT_WALLET_DIR } from '../scripts/devnet_seed';

/** 143: the first devnet run died on a 429 after funding 20 wallets whose keys were only in memory. */
const noSleep = async () => undefined;

describe('143: seed run survives rate limits and can always get its money back', () => {
  it('withRetry retries 429s with backoff, gives up after the limit, and rethrows other errors at once', async () => {
    let n = 0; const waits: number[] = [];
    const v = await withRetry(async () => { if (++n < 4) throw new Error('429 Too Many Requests'); return 'ok'; }, async (ms) => { waits.push(ms); }, { baseMs: 100 });
    expect(v).toBe('ok'); expect(n).toBe(4); expect(waits.length).toBe(3);
    expect(waits[2]).toBeGreaterThan(waits[0]); // it backs off
    let m = 0;
    await expect(withRetry(async () => { m++; throw new Error('Server responded with 429'); }, noSleep, { attempts: 3 })).rejects.toThrow(/429/);
    expect(m).toBe(3);
    let k = 0;
    await expect(withRetry(async () => { k++; throw new Error('custom program error: 0x1'); }, noSleep)).rejects.toThrow(/0x1/);
    expect(k).toBe(1);
  });

  it('retryingConnection wraps RPC methods and leaves plain properties alone', async () => {
    let calls = 0;
    const raw: any = { rpcEndpoint: 'https://x', async getBalance() { if (++calls < 3) throw new Error('429'); return 7; } };
    const c: any = retryingConnection(raw, noSleep);
    expect(await c.getBalance()).toBe(7); expect(calls).toBe(3);
    expect(c.rpcEndpoint).toBe('https://x');
  });

  it('the buyer wallet file is 0600 in a 0700 directory, round-trips, and is gitignored', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-')), 'seed-wallets');
    const mint = Keypair.generate().publicKey, funder = Keypair.generate().publicKey, ws = [Keypair.generate(), Keypair.generate()];
    const file = saveWalletFile(dir, mint, funder, ws);
    expect(path.basename(file)).toBe(`${mint.toBase58()}.json`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const back = loadWalletFile(file);
    expect(back.funder.toBase58()).toBe(funder.toBase58());
    expect(back.wallets.map((w) => w.publicKey.toBase58())).toEqual(ws.map((w) => w.publicKey.toBase58()));
    expect(fs.readFileSync('.gitignore', 'utf8')).toContain(`${DEFAULT_WALLET_DIR.replace(/\\/g, '/')}/`);
  });

  it('--sweep: sends each funded wallet back to the funder named in the file, refuses another cluster, and survives a 429', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
    const funder = Keypair.generate().publicKey, ws = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const file = saveWalletFile(dir, Keypair.generate().publicKey, funder, ws);
    const bal = new Map<string, number>([[ws[0].publicKey.toBase58(), 14_000_000], [ws[1].publicKey.toBase58(), 3_000], [ws[2].publicKey.toBase58(), 9_000_000]]);
    const sent: Array<{ from: string; to: string; lamports: number }> = [];
    let first429 = true;
    const conn: any = {
      getGenesisHash: async () => DEVNET_GENESIS_HASH,
      getBalance: async (pk: any) => { if (first429) { first429 = false; throw new Error('429 Too Many Requests'); } return bal.get(pk.toBase58()) ?? 0; },
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58() }),
      sendRawTransaction: async (raw: Buffer) => {
        const tx = Transaction.from(raw);
        const ix = tx.instructions[0]; const lamports = Number(Buffer.from(ix.data).readBigUInt64LE(4));
        const from = tx.feePayer!.toBase58();
        sent.push({ from, to: ix.keys[1].pubkey.toBase58(), lamports }); bal.set(from, 0);
        return 'sig';
      },
    };
    const r = await sweepFromFile({ connection: conn, allowedGenesis: DEVNET_GENESIS_HASH, file, sleep: noSleep, minSendGapMs: 0 });
    expect(sent.length).toBe(2); // the 3000 lamport wallet is dust, left alone
    expect(sent.every((s) => s.to === funder.toBase58())).toBe(true);
    expect(sent.map((s) => s.lamports).sort((a, b) => a - b)).toEqual([8_995_000, 13_995_000]);
    expect(r.sweptSol).toBeCloseTo((14_000_000 + 9_000_000 - 10_000) / 1e9, 9);
    await expect(sweepFromFile({ connection: { ...conn, getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }, allowedGenesis: DEVNET_GENESIS_HASH, file, sleep: noSleep })).rejects.toThrow(SeedGuardError);
  });

  it('CI runs the localnet seeding proof, which includes the forced-429 sweep', () => {
    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toMatch(/npm run localnet:seed/);
    expect(fs.readFileSync('scripts/localnet/seed_proof.ts', 'utf8')).toContain('429 Too Many Requests');
  });

  it('the CLI --sweep and SEED_RPC_URL are covered by the devnet guards', () => {
    const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/devnet_seed.ts', ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, APEX_ENV_FILE: '', ...env }, encoding: 'utf8', timeout: 60_000 });
    // a good SOLANA_RPC_URL does not rescue a bad SEED_RPC_URL: SEED_RPC_URL wins and is checked
    let r = run(['--sweep', 'x.json'], { SOLANA_RPC_URL: 'https://api.devnet.solana.com', SEED_RPC_URL: 'https://api.mainnet-beta.solana.com' });
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/mainnet/);
    r = run(['--sweep', 'x.json'], { SEED_RPC_URL: 'https://127.0.0.1:8899' });
    expect(r.status).toBe(2);
    r = run(['--sweep', 'x.json'], { SEED_RPC_URL: 'https://api.devnet.solana.com', ALLOWED_CLUSTER: 'mainnet' });
    expect(r.status).toBe(2);
    r = run(['--sweep'], { SEED_RPC_URL: 'https://api.devnet.solana.com' });
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/wallet file path/);
  });
});

/** 144: a separate funder, so the app's wallet audit has nothing to halt on. */
describe('144: separate seed funder keyfile', () => {
  const mk = (mode: number, content?: string) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedf-')), 'funder.json');
    const kp = Keypair.generate();
    fs.writeFileSync(f, content ?? JSON.stringify(Array.from(kp.secretKey)), { mode });
    fs.chmodSync(f, mode);
    return { f, kp };
  };
  it('loads a 0600 keypair file and returns the same key', () => {
    const { f, kp } = mk(0o600);
    expect(loadFunderKeypair(f).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
  it('refuses any other mode, a missing file, and a malformed file, without leaking the key', () => {
    for (const mode of [0o644, 0o640, 0o400, 0o666]) {
      const { f, kp } = mk(mode);
      let msg = '';
      try { loadFunderKeypair(f); } catch (e: any) { msg = e.message; expect(e).toBeInstanceOf(SeedGuardError); }
      expect(msg, mode.toString(8)).toMatch(/must be mode 0600/);
      expect(msg).not.toContain(String(kp.secretKey[0] + ',' + kp.secretKey[1]));
    }
    expect(() => loadFunderKeypair('/nonexistent/funder.json')).toThrow(SeedGuardError);
    const bad = mk(0o600, '[1,2,3]');
    expect(() => loadFunderKeypair(bad.f)).toThrow(/64 bytes/);
    const garbage = mk(0o600, 'SECRETSECRETSECRET');
    let m = ''; try { loadFunderKeypair(garbage.f); } catch (e: any) { m = e.message; }
    expect(m).not.toContain('SECRETSECRET');
  });
  it('the CLI rejects a world-readable keyfile (flag or env) with exit 2 before connecting, and prints no key bytes', () => {
    const { f, kp } = mk(0o644);
    const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/devnet_seed.ts', ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, APEX_ENV_FILE: '', SEED_RPC_URL: 'https://api.devnet.solana.com', ...env }, encoding: 'utf8', timeout: 60_000 });
    for (const r of [run(['--funder-keyfile', f, '--execute'], {}), run(['--execute'], { SEED_FUNDER_KEYPAIR_PATH: f })]) {
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/must be mode 0600/);
      expect(r.stdout + r.stderr).not.toContain(Buffer.from(kp.secretKey).toString('base64'));
    }
    const r = run(['--funder-keyfile'], {});
    expect(r.status).toBe(2); expect(r.stderr).toMatch(/needs a file path/);
    // the devnet guards still apply with a keyfile: a mainnet URL is refused first
    const ok = mk(0o600);
    expect(run(['--funder-keyfile', ok.f, '--execute'], { SEED_RPC_URL: 'https://api.mainnet-beta.solana.com' }).status).toBe(2);
  });
  it('CI runs the separate-funder audit proof (with its app-wallet control) after the seed proof', () => {
    const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci.indexOf('npm run localnet:seed-audit')).toBeGreaterThan(ci.indexOf('npm run localnet:seed\n'));
    expect(fs.readFileSync('scripts/localnet/seed_audit_proof.ts', 'utf8')).toContain('control: seeding from the APP wallet');
  });
  it('the saved wallet file records the funder, so sweeps return SOL to the separate wallet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seedw-'));
    const separate = Keypair.generate().publicKey;
    const file = saveWalletFile(dir, Keypair.generate().publicKey, separate, [Keypair.generate()]);
    expect(loadWalletFile(file).funder.toBase58()).toBe(separate.toBase58());
  });
});
