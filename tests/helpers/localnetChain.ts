import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';

/**
 * Long behaviour tests: a REAL chain flow on loopback.
 *
 *  - The LiteSVM local validator (scripts/localnet/validator.ts) runs the real pump.fun, fee and PumpSwap program binaries in
 *    its own process (LiteSVM's allocator does not survive sharing a process with the app's modules).
 *  - The REAL server (`tsx server.ts`) runs as a second child process against it, exactly as `npm run localnet:e2e` does:
 *    ALLOWED_CLUSTER=localnet with the validator's own genesis hash, a throwaway signer funded only by the local airdrop,
 *    APEX_ENV_FILE='' so the repo .env is never read, every state file in a scratch directory, external feeds off.
 *  - This test process seeds markets with the app's own quote and transaction-builder modules, signed by throwaway keys.
 *
 * Nothing here can reach a remote host: the validator listens on 127.0.0.1 only, the server is pointed at it, Jito is off on
 * localnet, and the vitest network guard refuses any other connection from this process.
 */

export interface ValidatorHandle {
  url: string;
  wsUrl: string;
  genesisHash: string;
  conn: Connection;
  rpc(method: string, params?: unknown[]): Promise<any>;
  /** Every JSON-RPC method the validator has answered so far, with counts (from `localnet_stats`). */
  methodCounts(): Promise<Record<string, number>>;
  stop(): Promise<void>;
}

const ROOT = process.cwd();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Set LONG_TEST_KEEP_SCRATCH=1 to keep the scratch directories (validator and server logs) after a run. */
export function cleanupScratch(dir: string): void {
  if (process.env.LONG_TEST_KEEP_SCRATCH) { console.log(`[long test] scratch kept at ${dir}`); return; }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Number of transactions the given wallet has signed on the local chain: the app's own sends, not the market's. */
export async function signedTxCount(conn: Connection, wallet: PublicKey): Promise<number> {
  return (await conn.getSignaturesForAddress(wallet, { limit: 1000 })).length;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** web3.js derives the websocket port as http port + 1, so the validator needs two adjacent free ports. */
async function freePortPair(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    try {
      await new Promise<void>((res, rej) => {
        const s = net.createServer();
        s.once('error', rej);
        s.listen(p + 1, '127.0.0.1', () => s.close(() => res()));
      });
      return p;
    } catch {
      /* try another pair */
    }
  }
  throw new Error('no adjacent free ports');
}

function pipeLogs(child: ChildProcess, file: string): () => string {
  let log = '';
  const onData = (d: Buffer) => {
    log += d;
    try { fs.appendFileSync(file, d); } catch { /* scratch gone */ }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return () => log;
}

/** `port` restarts a validator on a port a stopped one used (a new chain, with its own genesis hash, behind the same URL). */
export async function startValidator(dir: string, env: Record<string, string> = {}, port?: number): Promise<ValidatorHandle> {
  port ??= await freePortPair();
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/localnet/run_validator.ts', String(port)], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = pipeLogs(child, path.join(dir, 'validator.log'));
  const info: { url: string; genesisHash: string; wsPort: number } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('validator did not start:\n' + logs().slice(-2000))), 60_000);
    const onLine = (d: Buffer) => {
      const line = String(d).split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(t); child.stdout?.off('data', onLine); resolve(JSON.parse(line)); }
    };
    child.stdout?.on('data', onLine);
    child.once('exit', (code) => { clearTimeout(t); reject(new Error(`validator exited (${code}):\n${logs().slice(-2000)}`)); });
  });
  const rpc = async (method: string, params: unknown[] = []) => {
    const r = await fetch(info.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j: any = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  return {
    url: info.url,
    wsUrl: `ws://127.0.0.1:${info.wsPort}`,
    genesisHash: info.genesisHash,
    conn: new Connection(info.url, 'confirmed'),
    rpc,
    methodCounts: async () => (await rpc('localnet_stats')).methods ?? {},
    stop: () => new Promise<void>((r) => {
      if (child.exitCode !== null) return r();
      child.once('exit', () => r());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }),
  };
}

export interface LocalnetApp {
  base: string;
  token: string;
  dbPath: string;
  logs(): string;
  call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: any }>;
  /** Graceful stop (SIGTERM). */
  stop(): Promise<void>;
  /** Simulates a crash: SIGKILL, no shutdown hooks. */
  kill(): Promise<void>;
  exited(): boolean;
}

export interface AppOptions {
  dir: string;
  validator: ValidatorHandle;
  signerKeyPath: string;
  /** Reuse an existing database (restart scenarios). */
  dbPath?: string;
  /** Same operator token across restarts, so a stored session keeps working. */
  token?: string;
  env?: Record<string, string>;
}

/**
 * Boots the real server against the local validator. Mirrors `scripts/localnet/e2e.ts` and `tests/helpers/liveServer.ts`:
 * nothing is inherited from this process's environment except PATH and HOME.
 */
export async function startLocalnetApp(o: AppOptions): Promise<LocalnetApp> {
  const port = await freePort();
  const token = o.token ?? crypto.randomBytes(24).toString('hex');
  const dbPath = o.dbPath ?? path.join(o.dir, 'app.db');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? o.dir,
    NODE_ENV: 'production',
    APP_PORT: String(port),
    OPERATOR_AUTH_TOKEN: token,
    APEX_ENV_FILE: '',
    ALLOWED_CLUSTER: 'localnet',
    LOCALNET_GENESIS_HASH: o.validator.genesisHash,
    SOLANA_RPC_URL: o.validator.url,
    SOLANA_WS_URL: o.validator.wsUrl,
    JITO_BLOCK_ENGINE_URL: '', // Jito is off on localnet regardless; keep it explicit
    ENABLE_RPC_FALLBACK: 'true',
    APEX_DB_PATH: dbPath,
    SIGNER_KEYPAIR_PATH: o.signerKeyPath,
    LOCALNET_SOL_PRICE_USD: '150', // labelled LOCALNET_FIXED by the price service; a local validator has no market
    ALLOW_LIVE_REAL_MONEY_TRADING: 'true',
    APEX_DISABLE_EXTERNAL_FEEDS: 'true', // no Coinbase / pump.fun / DexScreener from a child process
    STARTUP_GRACE_PERIOD_MS: '0',
    ...(o.env ?? {}),
  };
  // node --import tsx, not the tsx CLI wrapper: the wrapper runs the server in a grandchild and cannot relay SIGKILL, so a
  // "crash" would leave the real server alive (holding its in-flight request) while the wrapper died.
  // The server runs with the scratch dir as cwd (so its state files land there), so tsx is named by absolute path.
  const tsxLoader = pathToFileURL(path.resolve(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', tsxLoader, path.resolve(ROOT, 'server.ts')], { cwd: o.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = pipeLogs(child, path.join(o.dir, `server-${port}.log`));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${logs().slice(-3000)}`);
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(250); }
  }
  if (!up) { child.kill('SIGKILL'); throw new Error(`server did not come up:\n${logs().slice(-3000)}`); }
  const call = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const stopWith = (signal: NodeJS.Signals) => new Promise<void>((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', () => r());
    child.kill(signal);
    if (signal !== 'SIGKILL') setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
  return {
    base, token, dbPath, logs, call,
    stop: () => stopWith('SIGTERM'),
    kill: () => stopWith('SIGKILL'),
    exited: () => child.exitCode !== null,
  };
}

/** Polls can-arm until the startup reconciliation (which runs in the background) lets the operator arm. */
export async function waitCanArm(app: LocalnetApp, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await app.call('GET', '/api/execution/can-arm')).json;
    if (last?.allowed === true) return last;
    await sleep(500);
  }
  throw new Error(`can-arm still refused after ${timeoutMs} ms: ${JSON.stringify(last?.reasons)}`);
}

/**
 * The operator's "sync wallet" action: balance from the chain plus a SOL/USD reading. With external feeds disabled the server
 * reads no price at boot, and a LIVE buy fails closed (SOL_PRICE_UNAVAILABLE) until one exists; on localnet the reading is the
 * fixed LOCALNET_SOL_PRICE_USD. Calling it here (as scripts/localnet/e2e.ts does) makes the price deterministic instead of
 * depending on the wallet trader's background timer having fired before the first buy.
 */
export async function syncWallet(app: LocalnetApp): Promise<void> {
  const r = await app.call('POST', '/api/wallet/sync-rpc', {});
  if (r.status !== 200) throw new Error(`wallet sync failed: ${r.status} ${JSON.stringify(r.json)}`);
  const px = r.json?.state?.solPriceUsd;
  if (!(typeof px === 'number' && px > 0)) throw new Error(`no SOL price after wallet sync (LOCALNET_SOL_PRICE_USD not applied?): ${JSON.stringify(r.json?.state).slice(0, 300)}`);
}

export async function armLive(app: LocalnetApp): Promise<void> {
  await syncWallet(app);
  await waitCanArm(app);
  const arm = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
  if (arm.status !== 200 || !arm.json?.success) throw new Error(`arm failed: ${arm.status} ${JSON.stringify(arm.json)}`);
}

/** Polls until `pred` holds for the position list, or throws with the last list after `timeoutMs`. */
export async function waitForPosition(
  app: LocalnetApp,
  pred: (positions: any[]) => any | undefined,
  timeoutMs: number,
  label = 'position'
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let list: any[] = [];
  while (Date.now() < deadline) {
    const r = await app.call('GET', '/api/workstation/positions');
    list = r.json?.positions ?? [];
    const hit = pred(list);
    if (hit) return hit;
    await sleep(750);
  }
  throw new Error(`${label} not reached in ${timeoutMs} ms; last positions: ${JSON.stringify(list.map((p) => ({ id: p.id, mint: p.mint?.slice(0, 6), status: p.status, qty: p.tokenQuantityRaw, stage: p.exitStage, reason: p.exitReason, pnl: p.realizedPnLSol })))}`);
}

/**
 * Market helpers. They import the app's own modules lazily, AFTER the caller has pointed process.env at the validator, so the
 * quote math and transaction builder used to seed the market are the production ones.
 */
export class LocalMarket {
  private sdk: any;
  private curve: any;
  private builder: any;
  readonly creator = Keypair.generate();
  private constructor(readonly v: ValidatorHandle) {}

  static async connect(v: ValidatorHandle): Promise<LocalMarket> {
    process.env.ALLOWED_CLUSTER = 'localnet';
    process.env.LOCALNET_GENESIS_HASH = v.genesisHash;
    process.env.SOLANA_RPC_URL = v.url;
    const m = new LocalMarket(v);
    m.sdk = (await import('@pump-fun/pump-sdk')).PUMP_SDK;
    m.curve = (await import('../../server/solana/pumpCurve')).PumpCurveService;
    m.builder = (await import('../../server/solana/transactionBuilder')).txBuilder;
    await m.fund(m.creator.publicKey, 50);
    return m;
  }

  get conn(): Connection { return this.v.conn; }

  async fund(pk: PublicKey, sol: number): Promise<void> {
    await this.conn.requestAirdrop(pk, Math.ceil(sol * LAMPORTS_PER_SOL));
  }

  async fresh(sol: number): Promise<Keypair> {
    const kp = Keypair.generate();
    await this.fund(kp.publicKey, sol);
    return kp;
  }

  /** A top-level system transfer from `from` (its first incoming transfer makes `from` the recipient's funder for the funder lookup). */
  async transfer(from: Keypair, to: PublicKey, sol: number): Promise<string> {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.ceil(sol * LAMPORTS_PER_SOL) }));
    tx.recentBlockhash = (await this.conn.getLatestBlockhash()).blockhash;
    tx.feePayer = from.publicKey;
    return this.send(tx, [from]);
  }

  /** Throwaway signer key file for the app, funded only by the local validator. */
  async signerKeyFile(dir: string, sol = 5): Promise<{ keypair: Keypair; path: string }> {
    const kp = await this.fresh(sol);
    const p = path.join(dir, 'throwaway-signer.json');
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    return { keypair: kp, path: p };
  }

  private async send(tx: any, signers: Keypair[]): Promise<string> {
    if ('version' in tx) tx.sign(signers); else tx.sign(...signers);
    const sig = await this.conn.sendRawTransaction(tx.serialize());
    const st = (await this.conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error('tx failed ' + JSON.stringify(st.err));
    return sig;
  }

  async createCoin(symbol = 'LNG'): Promise<PublicKey> {
    const mint = Keypair.generate();
    const ix = await this.sdk.createV2Instruction({
      mint: mint.publicKey, name: 'LongTest', symbol, uri: 'http://127.0.0.1/none',
      creator: this.creator.publicKey, user: this.creator.publicKey, mayhemMode: false,
    });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
    tx.recentBlockhash = (await this.conn.getLatestBlockhash()).blockhash;
    tx.feePayer = this.creator.publicKey;
    await this.send(tx, [this.creator, mint]);
    return mint.publicKey;
  }

  async state(mint: PublicKey) {
    const s = await this.curve.fetchPumpMarketState({ connection: this.conn, mint, executionMode: 'LIVE' });
    if (!s) throw new Error('no curve state for ' + mint.toBase58());
    return s;
  }

  /** Spot price in SOL per UI token, from the live curve reserves (what the app's own quote math reads). */
  async priceSol(mint: PublicKey): Promise<number> {
    const s = await this.state(mint);
    return (Number(s.virtualSolReserves) / 1e9) / (Number(s.virtualTokenReserves) / 1e6);
  }

  async buy(kp: Keypair, mint: PublicKey, sol: number): Promise<string> {
    const state = await this.state(mint);
    const q = this.curve.calculateBuyQuote({ state, amountSol: sol, slippageBps: 3000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' });
    const tx = await this.builder.buildBuyTransaction(this.conn, {
      buyer: kp.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: this.curve.getAssociatedTokenAddress(mint, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: BigInt(q.tokenAmountRaw),
      maxSolCostLamports: BigInt(q.maxInputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    });
    return this.send(tx, [kp]);
  }

  async tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint | null> {
    const a = await this.conn.getTokenAccountsByOwner(owner, { mint });
    if (!a.value.length) return null;
    return BigInt((await this.conn.getTokenAccountBalance(a.value[0].pubkey)).value.amount);
  }

  async sell(kp: Keypair, mint: PublicKey, fraction = 1): Promise<string | null> {
    const bal = await this.tokenBalance(kp.publicKey, mint);
    if (!bal) return null;
    const amount = BigInt(Math.floor(Number(bal) * fraction));
    if (amount <= 0n) return null;
    const state = await this.state(mint);
    const q = this.curve.calculateSellQuote({ state, tokenAmountRaw: amount, slippageBps: 5000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' });
    const tx = await this.builder.buildSellTransaction(this.conn, {
      seller: kp.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: this.curve.getAssociatedTokenAddress(mint, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: amount,
      minSolOutputLamports: BigInt(q.minOutputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    });
    return this.send(tx, [kp]);
  }

  /**
   * create_v2 + a small creator buy + `buyers` distinct wallets, so the app's own safety filters (creator share, top-10
   * concentration, liquidity) pass honestly. Returns the buyer keypairs so a test can move the market later.
   */
  async seedCoin(buyers = 14, buySol = 0.6): Promise<{ mint: PublicKey; wallets: Keypair[] }> {
    const mint = await this.createCoin();
    await this.buy(this.creator, mint, 0.2);
    const wallets: Keypair[] = [];
    for (let i = 0; i < buyers; i++) {
      const w = await this.fresh(buySol + 1);
      await this.buy(w, mint, buySol);
      wallets.push(w);
    }
    return { mint, wallets };
  }

  /** Buys with fresh wallets until the spot price is at least `targetRatio` × the price at call time. */
  async pumpTo(mint: PublicKey, targetRatio: number, stepSol = 1.0, maxSteps = 60): Promise<number> {
    const start = await this.priceSol(mint);
    for (let i = 0; i < maxSteps; i++) {
      const now = await this.priceSol(mint);
      if (now / start >= targetRatio) return now / start;
      const w = await this.fresh(stepSol + 1);
      await this.buy(w, mint, stepSol);
    }
    return (await this.priceSol(mint)) / start;
  }

  /** Sells from the given holders until the spot price is at most `targetRatio` × the price at call time. */
  async dumpTo(mint: PublicKey, holders: Keypair[], targetRatio: number): Promise<number> {
    const start = await this.priceSol(mint);
    for (const h of holders) {
      const now = await this.priceSol(mint);
      if (now / start <= targetRatio) return now / start;
      await this.sell(h, mint, 1).catch(() => null);
    }
    return (await this.priceSol(mint)) / start;
  }
}

/** The app's own key file must never be the repo keypair: assert the path is under the scratch dir. */
export function assertScratchPath(p: string, dir: string): void {
  if (!path.resolve(p).startsWith(path.resolve(dir))) throw new Error(`refusing to use ${p}: not under ${dir}`);
}
