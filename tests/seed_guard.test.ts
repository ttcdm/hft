import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { HARD_CAP_SOL, DEVNET_GENESIS_HASH, SeedGuardError, assertDevnetTarget, planSeed, runSeed } from '../scripts/devnet_seed';

/** 142: the devnet seeding script can only run against devnet, never spends past 0.45 SOL, and does nothing unless told to. */
function fakeConn(genesis: string, lamports = 2_000_000_000) {
  const calls: string[] = [];
  const c: any = new Proxy({}, { get: (_t, name: string) => {
    if (name === 'getGenesisHash') return async () => genesis;
    if (name === 'getBalance') return async () => lamports;
    return async () => { calls.push(String(name)); throw new Error(`unexpected call ${String(name)}`); };
  } });
  return { c, calls };
}
const signer = () => { const kp = Keypair.generate(); return { publicKey: kp.publicKey, sign: async (tx: any) => tx.partialSign(kp) }; };

describe('142: devnet seeding guards', () => {
  it('the default plan (30 buyers x 0.01 SOL) fits inside the hard cap; a cap above it is refused', () => {
    const p = planSeed({});
    expect(p.reasons).toEqual([]);
    expect(p.grossSol).toBeLessThanOrEqual(HARD_CAP_SOL);
    expect(planSeed({ capSol: 1 }).reasons.join()).toMatch(/above the hard limit/);
    expect(planSeed({ buyers: 40 }).reasons.join()).toMatch(/cap/);
    expect(planSeed({ buyers: 0 }).reasons.length).toBeGreaterThan(0);
    expect(planSeed({ buySol: 0.2 }).reasons.length).toBeGreaterThan(0);
  });

  it('assertDevnetTarget refuses mainnet, loopback, private, plain http and a non-devnet ALLOWED_CLUSTER', () => {
    const ok = { ALLOWED_CLUSTER: 'devnet' } as NodeJS.ProcessEnv;
    expect(() => assertDevnetTarget('https://api.devnet.solana.com', ok)).not.toThrow();
    expect(() => assertDevnetTarget('https://api.devnet.solana.com', {} as NodeJS.ProcessEnv)).not.toThrow();
    for (const u of ['https://api.mainnet-beta.solana.com', 'https://mainnet.helius-rpc.com/?api-key=x', 'http://api.devnet.solana.com', 'https://127.0.0.1:8899', 'https://localhost', 'https://10.0.0.5', 'https://192.168.1.2', 'https://172.16.0.1', 'not a url']) {
      expect(() => assertDevnetTarget(u, ok), u).toThrow(SeedGuardError);
    }
    for (const c of ['mainnet', 'mainnet-beta', 'localnet']) expect(() => assertDevnetTarget('https://api.devnet.solana.com', { ALLOWED_CLUSTER: c } as NodeJS.ProcessEnv), c).toThrow(SeedGuardError);
  });

  it('a connection that reports another genesis hash is refused before any send', async () => {
    const { c, calls } = fakeConn('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'); // mainnet
    await expect(runSeed({ connection: c, signer: signer(), allowedGenesis: DEVNET_GENESIS_HASH, dryRun: false })).rejects.toThrow(/genesis hash/);
    expect(calls).toEqual([]);
  });

  it('a dry run on devnet sends nothing and returns the plan; an underfunded wallet is refused', async () => {
    const { c, calls } = fakeConn(DEVNET_GENESIS_HASH);
    const r = await runSeed({ connection: c, signer: signer(), allowedGenesis: DEVNET_GENESIS_HASH, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.signatures).toEqual([]);
    expect(calls).toEqual([]);
    const poor = fakeConn(DEVNET_GENESIS_HASH, 100_000_000);
    await expect(runSeed({ connection: poor.c, signer: signer(), allowedGenesis: DEVNET_GENESIS_HASH, dryRun: true })).rejects.toThrow(/funder holds/);
  });

  it('the CLI exits 2 before connecting for a mainnet, loopback or missing RPC URL, or a non-devnet cluster', () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/devnet_seed.ts', '--execute'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, APEX_ENV_FILE: '', ...env }, encoding: 'utf8', timeout: 60_000,
    });
    for (const env of [{ SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }, { SOLANA_RPC_URL: 'https://127.0.0.1:8899' }, {}, { SOLANA_RPC_URL: 'https://api.devnet.solana.com', ALLOWED_CLUSTER: 'mainnet' }]) {
      const r = run(env);
      expect(r.status, JSON.stringify(env) + r.stderr).toBe(2);
      expect(r.stderr).toMatch(/SEED_GUARD/);
    }
  });

  it('the CLI cannot be told a different genesis or cluster, and spends only with --execute', () => {
    const src = fs.readFileSync('scripts/devnet_seed.ts', 'utf8');
    const cli = src.slice(src.indexOf('async function main'));
    expect(cli).toContain('allowedGenesis: DEVNET_GENESIS_HASH');
    expect(cli).toMatch(/dryRun: !flag\('execute'\)/);
    expect(cli).not.toMatch(/val\('(genesis|cluster)/);
  });
});
