import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { acquireLock, releaseLock, InstanceLockError, liveLockHolder, dbLockPath, signerLockPath } from '../server/system/instanceLock';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { WorkstationDatabase, workstationDb } from '../server/db/database';
import { localSigner } from '../server/solana/signer';
import { autoSnipeController } from '../server/auto/controller';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { PumpSwapVenueService } from '../server/solana/pumpSwapService';
import { TradeReconciler } from '../server/execution/reconciliation';
import { txBuilder } from '../server/solana/transactionBuilder';
import { executionConfig } from '../server/solana/executionConfig';
import { makeFunder, SeedGuardError } from '../scripts/devnet_seed';
import { CLUSTER_GENESIS_HASH } from '../server/solana/clusterGuard';
const DEVNET_GENESIS_HASH = CLUSTER_GENESIS_HASH.devnet;
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { VALID_PUMP_MINT_1, DUMMY_FEE_RECIPIENT, createSimulatedBondingCurveState } from './e2e/helpers/simulatedStates';
import { baseEnv, scratchDir, startApp, type AppHandle } from './helpers/liveServer';

/**
 * P1.1 (N-51, N-52, N-55, N-56, N-57, N-59, N-60): one process per database and per signing key.
 * Real ExecutionCoordinator, AutoSnipeController, WorkstationDatabase and server.ts; doubles only at the RPC boundary (MockSolanaRpc) and
 * the builder/reconciler edges the existing sell tests stub.
 */

const tsxEsm = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx/esm')).href;
const children: ChildProcess[] = [];
const apps: AppHandle[] = [];

/** A separate process that takes `lockPath` with the real lock module and keeps it until killed. Resolves once it holds it. */
function holdLockInChild(lockPath: string): Promise<ChildProcess> {
  const code = `import(${JSON.stringify(pathToFileURL(path.resolve('server/system/instanceLock.ts')).href)}).then((m) => { m.acquireLock(${JSON.stringify(lockPath)}); console.log('HELD'); setInterval(() => {}, 1000); });`;
  const child = spawn(process.execPath, ['--import', tsxEsm, '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (d) => { out += d; if (out.includes('HELD')) resolve(child); });
    child.stderr!.on('data', (d) => { out += d; });
    child.once('exit', (c) => reject(new Error(`lock holder exited ${c}: ${out}`)));
  });
}

const killed = (c: ChildProcess) => new Promise<void>((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', () => r()); c.kill('SIGKILL'); });

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of children.splice(0)) await killed(c);
  for (const a of apps.splice(0)) await a.stop();
});

describe('P1.1 instance lock module', () => {
  it('a lock held by another live process refuses; once that process is dead the stale lock is taken over', async () => {
    const dir = scratchDir('p11-lock-');
    const lock = path.join(dir, 'app.db.lock');
    const child = await holdLockInChild(lock);
    expect(liveLockHolder(lock)?.pid).toBe(child.pid);
    expect(() => acquireLock(lock)).toThrow(InstanceLockError);
    await killed(child);
    const mine = acquireLock(lock);
    expect(mine.pid).toBe(process.pid);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    releaseLock(lock);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('an in-memory database has no lock', () => {
    expect(dbLockPath(':memory:')).toBeNull();
    expect(dbLockPath('/tmp/x.db')).toBe('/tmp/x.db.lock');
  });
});

describe('P1.1 two coordinators on one database never both sell or both buy', () => {
  let a: ExecutionCoordinator;
  let b: ExecutionCoordinator;
  let rpcA: MockSolanaRpc;
  let rpcB: MockSolanaRpc;

  beforeEach(() => {
    const kp = Keypair.generate();
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(kp.publicKey);
    vi.spyOn(localSigner, 'signTransaction').mockImplementation(async (tx: any) => tx);
    // No block engine, as on devnet: sends go through the RPC transport.
    const realConfig = executionConfig.getConfig.bind(executionConfig);
    vi.spyOn(executionConfig, 'getConfig').mockImplementation(() => ({ ...realConfig(), jitoBlockEngineUrl: '' }));
    rpcA = new MockSolanaRpc();
    rpcB = new MockSolanaRpc();
    a = new ExecutionCoordinator(rpcA.createConnection());
    b = new ExecutionCoordinator(rpcB.createConnection());
  });

  afterEach(() => {
    a.cleanup();
    b.cleanup();
    PumpCurveService.cachedGlobal = null;
    PumpCurveService.cachedFeeConfig = null;
  });

  it('a take-profit partial is sold once: the second coordinator finds the sell claimed', async () => {
    const id = `p11_tp_${Math.random().toString(36).slice(2)}`;
    workstationDb.savePosition({
      id, mint: VALID_PUMP_MINT_1.toBase58(), symbol: 'P11', name: 'P11', tokenDecimals: 6, tokenQuantityRaw: '1000000000',
      entryPriceSol: 0.0001, currentPriceSol: 0.0002, currentValueSol: 0.2, costBasisLamports: 100_000_000, realizedPnLSol: 0,
      status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'LIVE', entryTxSignature: `sig_${id}`, entryTimestamp: Date.now(),
      lastMarkTimestamp: Date.now(), recordUpdatedAt: Date.now(), updatedAt: Date.now(),
    } as any);
    PumpCurveService.cachedGlobal = { feeRecipient: DUMMY_FEE_RECIPIENT.toBase58() };
    PumpCurveService.cachedFeeConfig = { feeBps: 100 };
    vi.spyOn(PumpSwapVenueService, 'resolveVenue').mockResolvedValue({ venue: 'PUMP_BONDING_CURVE' } as any);
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(createSimulatedBondingCurveState());
    vi.spyOn(PumpCurveService, 'calculateSellQuote').mockReturnValue({ expectedJitoTipLamports: 0, minOutputLamports: 1 } as any);
    vi.spyOn(txBuilder, 'buildSellTransaction').mockResolvedValue({} as any);
    vi.spyOn(TradeReconciler, 'capturePreTradeSnapshot').mockResolvedValue({ walletSolLamports: 1e9, tokenBalanceRaw: '1000000000', tokenDecimals: 6, timestamp: Date.now() });
    vi.spyOn(TradeReconciler, 'reconcileSellTransaction').mockResolvedValue({
      success: true, reconciliationState: 'RECONCILED', actualTokensSoldRaw: '330000000', tokensSoldHuman: 330, tokenDecimals: 6,
      actualGrossSolProceedsLamports: 66_000_000, actualNetSolProceedsLamports: 65_000_000, actualNetworkFeeLamports: 5000,
      actualJitoTipLamports: 0, actualRealizedPnLSol: 0.032, remainingTokensRaw: '670000000', isFullyClosed: false, slot: 6,
    } as any);
    const ok = { success: true, signature: 'sellsig', transport: 'SOLANA_RPC', slot: 5, lifecycleState: 'CONFIRMED' } as const;
    const submitA = vi.spyOn(a as any, 'submitAndConfirmWithRetry').mockResolvedValue(ok);
    const submitB = vi.spyOn(b as any, 'submitAndConfirmWithRetry').mockResolvedValue(ok);
    // Hold A's sell at the RPC boundary (its pre-send simulation), so it is mid-sell when B tries.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const connA = (a as any).getConnection();
    vi.spyOn(connA, 'simulateTransaction').mockImplementation(async () => { await gate; return { context: { slot: 1 }, value: { err: null, logs: [] } }; });

    const sellA = a.closePosition(id, 33, 'TAKE_PROFIT_1');
    await vi.waitFor(() => expect(connA.simulateTransaction).toHaveBeenCalled());
    const resB = await b.closePosition(id, 33, 'TAKE_PROFIT_1');
    expect(resB.success).toBe(false);
    expect(resB.error).toMatch(/EXIT_IN_PROGRESS/);
    release();
    const resA = await sellA;
    expect(resA.success).toBe(true);
    expect(submitA).toHaveBeenCalledTimes(1);
    expect(submitB).not.toHaveBeenCalled();
    const row = workstationDb.loadPositions().find((p) => p.id === id)!;
    expect(row.status).toBe('PARTIALLY_CLOSED');
    expect(row.tokenQuantityRaw).toBe('670000000');
    // the claim is released: a later sell is not refused as in progress
    const later = await b.closePosition(id, 33, 'TAKE_PROFIT_2');
    expect(later.error ?? '').not.toMatch(/EXIT_IN_PROGRESS/);
  });

  it('the same mint bought by both at once: only one buy reaches the RPC', async () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate();
    const mkTx = async (conn: any) => {
      const { blockhash } = await conn.getLatestBlockhash();
      const msg = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 })] }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([owner]);
      return tx;
    };
    const params = async (c: ExecutionCoordinator, orderId: string) => ({
      tx: await mkTx((c as any).getConnection()), orderId, correlationId: orderId, side: 'BUY' as const, mint: mint.toBase58(), mintPubkey: mint,
      owner: owner.publicKey, tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      preSnapshot: { walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, timestamp: Date.now() }, jitoTipLamports: 0,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const connA = (a as any).getConnection();
    const connB = (b as any).getConnection();
    // Hold A's send at the RPC, so its buy is unresolved (PENDING row written, outcome unknown) when B tries.
    const sendA = vi.spyOn(connA, 'sendRawTransaction').mockImplementation(async () => { await gate; throw new Error('socket hang up'); });
    const genesisB = vi.spyOn(connB, 'getGenesisHash');
    const sendB = vi.spyOn(connB, 'sendRawTransaction');
    const buyA = a.submitAndConfirmWithRetry(await params(a, `p11-buy-a-${mint.toBase58().slice(0, 6)}`));
    await vi.waitFor(() => expect(sendA).toHaveBeenCalled());
    expect(workstationDb.hasUnresolvedLiveBuy(mint.toBase58())).toBe(true);
    const resB = await b.submitAndConfirmWithRetry(await params(b, `p11-buy-b-${mint.toBase58().slice(0, 6)}`));
    expect(resB.success).toBe(false);
    expect(resB.error).toMatch(/UNRESOLVED_BUY/);
    expect(genesisB).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(workstationDb.loadTransactions(`p11-buy-b-${mint.toBase58().slice(0, 6)}`)).toHaveLength(0); // B wrote no row at all
    release();
    await buyA;
  });
});

describe('P1.1 a second process cannot take over auto mode or fund from the app wallet', () => {
  it('restorePersisted leaves the saved mode alone while another process holds the database', async () => {
    const dir = scratchDir('p11-restore-');
    const dbFile = path.join(dir, 'app.db');
    const getPath = vi.spyOn(workstationDb, 'getDbPath').mockReturnValue(dbFile);
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    workstationDb.setSetting('auto.mode', 'DEVNET_LIVE');
    await holdLockInChild(dbLockPath(dbFile)!);
    const r = await autoSnipeController.restorePersisted();
    expect(r.mode).toBe('OFF');
    expect(r.note).toMatch(/holds/);
    expect(workstationDb.getSetting('auto.mode')).toBe('DEVNET_LIVE');
    getPath.mockRestore();
    workstationDb.setSetting('auto.mode', null);
    vi.unstubAllEnvs();
  });

  it('makeFunder refuses when the app database has DEVNET_LIVE saved, even with --confirm-auto-off', async () => {
    const dir = scratchDir('p11-funder-');
    const dbFile = path.join(dir, 'app.db');
    const appDb = new WorkstationDatabase(dbFile);
    appDb.setSetting('auto.mode', 'DEVNET_LIVE');
    const conn = new MockSolanaRpc().createConnection();
    const signer = Keypair.generate();
    const opts = {
      connection: conn, signer: { publicKey: signer.publicKey, sign: async () => undefined }, allowedGenesis: DEVNET_GENESIS_HASH,
      file: path.join(os.tmpdir(), `p11-funder-${process.pid}-${Date.now()}.json`), fundSol: 0.1, autoOffConfirmed: true, appDbPath: dbFile,
    };
    await expect(makeFunder(opts)).rejects.toBeInstanceOf(SeedGuardError);
    await expect(makeFunder(opts)).rejects.toThrow(/DEVNET_LIVE/);
    expect(fs.existsSync(opts.file)).toBe(false);
    // OFF saved, but a live process holds the database: still refused
    appDb.setSetting('auto.mode', 'OFF');
    await holdLockInChild(dbLockPath(dbFile)!);
    await expect(makeFunder(opts)).rejects.toThrow(/holds the app database/);
    // and the wallet's signer lock held by another process is refused too
    for (const c of children.splice(0)) await killed(c);
    await holdLockInChild(signerLockPath(signer.publicKey.toBase58()));
    await expect(makeFunder(opts)).rejects.toThrow(/signing with the app wallet/);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}

/** Run server.ts with this env until it exits by itself (or kill it after `ms`). */
function runSecondServer(cwd: string, env: Record<string, string>, ms = 60_000): Promise<{ code: number | null; log: string }> {
  const child = spawn(process.execPath, ['--import', tsxEsm, path.resolve('server.ts')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill('SIGKILL'), ms);
    child.once('exit', (code) => { clearTimeout(t); resolve({ code, log }); });
  });
}

const countRows = (dbFile: string) => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { decisions: n('decisions'), transactions: n('transactions'), journal: n('system_journal') };
  } finally { db.close(); }
};

describe('P1.1 a second server on the same database, port or key exits before it trades', () => {
  it('same database: exits non-zero, writes no rows, never reconciles', async () => {
    const dir = scratchDir('p11-two-');
    const first = await startApp(dir, {});
    apps.push(first);
    const before = countRows(first.dbPath);
    const port = String(await freePort()); // a free port, so only the database lock can stop it
    const second = await runSecondServer(dir, { ...baseEnv(dir, {}), APEX_DB_PATH: first.dbPath, APP_PORT: port });
    expect(second.code).not.toBe(0);
    expect(second.code).not.toBeNull();
    expect(second.log).toMatch(/INSTANCE_LOCKED/);
    expect(second.log).not.toMatch(/Startup Reconciliation result/);
    expect(countRows(first.dbPath)).toEqual(before);
    expect((await fetch(`${first.base}/api/health`)).ok).toBe(true); // the first one is unaffected
  }, 240_000);

  it('same port, other database: the listen error ends the process instead of a portless instance that keeps trading', async () => {
    const dir = scratchDir('p11-port-');
    const first = await startApp(dir, {});
    apps.push(first);
    const other = scratchDir('p11-port-b-');
    const port = new URL(first.base).port;
    const second = await runSecondServer(other, { ...baseEnv(other, {}), APP_PORT: port });
    expect(second.code).toBe(1);
    expect(second.log).toMatch(/EADDRINUSE/);
    expect(second.log).not.toMatch(/Startup Reconciliation result/);
  }, 240_000);

  it('same signing key, other database: refuses to start trading', async () => {
    const keys = scratchDir('p11-key-shared-');
    const shared = { SIGNER_KEYPAIR_PATH: path.join(keys, 'key.json'), APEX_LOCK_DIR: path.join(keys, 'locks') };
    fs.writeFileSync(shared.SIGNER_KEYPAIR_PATH, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
    const dir = scratchDir('p11-key-');
    const first = await startApp(dir, shared);
    apps.push(first);
    const other = scratchDir('p11-key-b-');
    const second = await runSecondServer(other, { ...baseEnv(other, {}), ...shared, APP_PORT: String(await freePort()) });
    expect(second.code).toBe(1);
    expect(second.log).toMatch(/INSTANCE_LOCKED/);
    expect(second.log).not.toMatch(/Startup Reconciliation result/);
  }, 240_000);
});
