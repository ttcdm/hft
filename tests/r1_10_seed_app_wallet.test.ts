import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { claimAppWallet, SeedGuardError } from '../scripts/devnet_seed';
import { readLock, isOwnLock, signerLockPath, releaseAllLocks } from '../server/system/instanceLock';
import { WorkstationDatabase } from '../server/db/database';
import { scratchDir } from './helpers/liveServer';

/**
 * Round 1 #10: the default devnet seed run signed with the app wallet with only a printed warning: no idle check, no signer lock. Now the
 * app wallet is refused unless --use-app-wallet is given, and then the app must be idle and the run holds the wallet's signer lock.
 * Real devnet_seed and instance-lock modules on scratch files; APEX_LOCK_DIR points at a scratch folder.
 */
const savedLockDir = process.env.APEX_LOCK_DIR;
let dir = '';
beforeEach(() => { dir = scratchDir('r110-'); process.env.APEX_LOCK_DIR = path.join(dir, 'locks'); });
afterEach(() => {
  releaseAllLocks();
  if (savedLockDir === undefined) delete process.env.APEX_LOCK_DIR; else process.env.APEX_LOCK_DIR = savedLockDir;
});

describe('round 1 #10: the seed signs with the app wallet only when told to, idle, and under its signer lock', () => {
  it('without --use-app-wallet the app wallet is refused and no lock is taken', () => {
    const pub = Keypair.generate().publicKey.toBase58();
    expect(() => claimAppWallet({ walletPubkey: pub, appDbPath: null, useAppWallet: false, what: 'the seed' })).toThrow(SeedGuardError);
    expect(() => claimAppWallet({ walletPubkey: pub, appDbPath: null, useAppWallet: false, what: 'the seed' })).toThrow(/--use-app-wallet/);
    expect(fs.existsSync(signerLockPath(pub))).toBe(false);
  });

  it('with the flag it holds the signer lock for the run and releases it after', () => {
    const pub = Keypair.generate().publicKey.toBase58();
    const release = claimAppWallet({ walletPubkey: pub, appDbPath: path.join(dir, 'none.db'), useAppWallet: true, what: 'the seed' });
    expect(isOwnLock(readLock(signerLockPath(pub)))).toBe(true);
    release();
    expect(fs.existsSync(signerLockPath(pub))).toBe(false);
  });

  it('with the flag it is refused while a server holds the wallet, or the app database has auto mode on', () => {
    const pub = Keypair.generate().publicKey.toBase58();
    fs.mkdirSync(path.dirname(signerLockPath(pub)), { recursive: true });
    fs.writeFileSync(signerLockPath(pub), JSON.stringify({ pid: 999_999, startedAt: Date.now(), bootId: 'c'.repeat(32), heartbeatAt: Date.now(), pidNs: 'other|pid:[1]', walletPubkey: pub }));
    expect(() => claimAppWallet({ walletPubkey: pub, appDbPath: null, useAppWallet: true, what: 'the seed' })).toThrow(/stop the server first|signer lock is held/);

    const pub2 = Keypair.generate().publicKey.toBase58();
    const dbPath = path.join(dir, 'app.db');
    const db = new WorkstationDatabase(dbPath);
    db.setSetting('auto.mode', 'DEVNET_LIVE');
    (db as any).db.close();
    expect(() => claimAppWallet({ walletPubkey: pub2, appDbPath: dbPath, useAppWallet: true, what: 'the seed' })).toThrow(/auto mode DEVNET_LIVE/);
    expect(fs.existsSync(signerLockPath(pub2))).toBe(false);
  });
});
