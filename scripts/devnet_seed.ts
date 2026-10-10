/**
 * Devnet seeding: ONE new pump.fun token (create_v2, the creator buys nothing in the create transaction) and about 30 funded buyer
 * wallets that each buy about 0.01 SOL inside about 30 seconds. No sells. Purpose: give the watch window and the auto controller
 * a launch with real buyers to look at on devnet.
 *
 *   npx tsx scripts/devnet_seed.ts                 dry run (the default): checks everything, prints the plan, sends nothing
 *   npx tsx scripts/devnet_seed.ts --execute       spends devnet SOL (needs the operator's go-ahead)
 *   npx tsx scripts/devnet_seed.ts --sweep .overnight/seed-wallets/<mint>.json     bring the SOL in a saved run's buyer wallets back to its funder
 *   --funder-keyfile <file> (or SEED_FUNDER_KEYPAIR_PATH): pay from a separate devnet wallet, not the app wallet
 *   options: --buyers 30  --buy-sol 0.01  --window-s 30  --cap-sol 0.45  --no-sweep
 *
 * The funder is the wallet the app uses (OPERATOR_PRIVATE_KEY / SOLANA_PRIVATE_KEY / SIGNER_KEYPAIR_PATH, read from `.env`).
 * Hard limits that no flag removes: devnet only (ALLOWED_CLUSTER unset or devnet; the RPC must report the devnet genesis hash; a
 * loopback / private / mainnet-looking RPC URL is refused); at most 0.45 SOL leaves the funder in total.
 * Nothing runs unless every check passes; a failed check exits 2 before the first transaction.
 *
 * Safety nets added after the first devnet run died on a 429 with 20 funded buyers whose keys lived only in memory:
 *   - every buyer secret key is written (0600) to .overnight/seed-wallets/<mint>.json BEFORE any wallet is funded;
 *   - every RPC call retries 429 / transient errors with backoff, and sends are spaced (default 400 ms apart);
 *   - any failure after funding sweeps the buyer wallets back to the funder before the script exits;
 *   - `--sweep <file>` recovers the SOL from a saved wallet file (also used if a run is killed outright);
 *   - SEED_RPC_URL (checked by the same devnet guards) overrides SOLANA_RPC_URL, so a private devnet RPC can be used.
 *
 * A separate funder: the app's own auto controller (DEVNET_LIVE) halts ALL trading when its wallet changes by an amount its decision
 * journal does not explain, which is exactly what funding 30 buyers from the app wallet looks like. So the seed can be paid from a
 * different devnet wallet: SEED_FUNDER_KEYPAIR_PATH or --funder-keyfile <file> (a Solana keypair JSON, mode 0600). The saved wallet
 * file records that funder, so the automatic sweep and `--sweep` return the SOL to it. The key is never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';

export const HARD_CAP_SOL = 0.45;
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** Token-2022 token account rent plus the one-time pump account the first buy of a wallet creates, measured on the local chain: a fresh wallet's first 0.01 SOL buy cost it at most 0.01352 SOL (buy, curve fee, tx fee, Token-2022 account rent, the one-time pump account), plus the 0.00089 SOL a wallet must keep to stay rent-exempt, which is why a buyer that ends with less fails InsufficientFundsForRent. */
export const BUYER_ACCOUNT_OVERHEAD_SOL = 0.0044;
/** What the create transaction costs the creator (mint, curve and token accounts), measured on the local chain. */
export const CREATE_COST_SOL = 0.008;
/** Left in the funder at all times. */
export const FUNDER_RESERVE_SOL = 0.05;
const BUY_HEADROOM = 1.03; // the measured outlay already contains the curve fee; this covers the curve moving between quote and landing

export class SeedGuardError extends Error {
  constructor(message: string) { super(`SEED_GUARD: ${message}`); this.name = 'SeedGuardError'; }
}

/** A run that failed after money moved. `report` says what happened; `sweptSol` is what the automatic sweep got back. */
export class SeedRunError extends Error {
  constructor(message: string, public report: SeedReport, public sweptSol: number, public walletFile: string | undefined, public cause_: unknown) {
    super(message); this.name = 'SeedRunError';
  }
}

export const DEFAULT_WALLET_DIR = path.join('.overnight', 'seed-wallets');
const RETRYABLE = /\b429\b|too many requests|rate.?limit|\b50[234]\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|timed? ?out/i;
export interface RetryOptions { attempts?: number; baseMs?: number; maxMs?: number }

/** Runs `fn`, retrying 429 and transient network errors with exponential backoff plus jitter. Anything else is thrown at once. */
export async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>, o: RetryOptions = {}, label = 'rpc', onRetry?: (m: string) => void): Promise<T> {
  const attempts = o.attempts ?? 8, base = o.baseMs ?? 600, max = o.maxMs ?? 10_000;
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (i >= attempts || !RETRYABLE.test(msg)) throw e;
      const wait = Math.min(max, base * 2 ** (i - 1)) * (0.75 + Math.random() * 0.5);
      onRetry?.(`${label}: ${msg.slice(0, 60)} (attempt ${i}/${attempts}), waiting ${Math.round(wait)} ms`);
      await sleep(wait);
    }
  }
}

/** The same Connection, but every RPC method retries rate limits. (Sending the same signed transaction twice is harmless.) */
export function retryingConnection(conn: Connection, sleep: (ms: number) => Promise<void>, o: RetryOptions = {}, onRetry?: (m: string) => void): Connection {
  return new Proxy(conn, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (typeof prop === 'string' && /^(get|send|simulate|request)/.test(prop)) return (...args: unknown[]) => withRetry(() => Reflect.apply(v as (...a: unknown[]) => Promise<unknown>, target, args) as Promise<unknown>, sleep, o, prop, onRetry);
      return v.bind(target);
    },
  }) as Connection;
}

export interface WalletFile { version: 1; cluster: 'devnet'; mint: string; funder: string; createdAt: string; wallets: Array<{ publicKey: string; secretKey: number[] }> }

/** Writes the buyer keys somewhere that survives the process: a 0700 directory and a 0600 file. */
export function saveWalletFile(dir: string, mint: PublicKey, funder: PublicKey, wallets: Keypair[]): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${mint.toBase58()}.json`);
  const body: WalletFile = { version: 1, cluster: 'devnet', mint: mint.toBase58(), funder: funder.toBase58(), createdAt: new Date().toISOString(), wallets: wallets.map((w) => ({ publicKey: w.publicKey.toBase58(), secretKey: Array.from(w.secretKey) })) };
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function loadWalletFile(file: string): { funder: PublicKey; mint: string; wallets: Keypair[] } {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as WalletFile;
  if (j?.version !== 1 || !Array.isArray(j.wallets) || !j.funder) throw new SeedGuardError(`${file} is not a seed wallet file`);
  const wallets = j.wallets.map((w) => {
    const kp = Keypair.fromSecretKey(Uint8Array.from(w.secretKey));
    if (kp.publicKey.toBase58() !== w.publicKey) throw new SeedGuardError(`${file}: a secret key does not match its public key`);
    return kp;
  });
  return { funder: new PublicKey(j.funder), mint: j.mint, wallets };
}

/** Moves every buyer wallet's SOL back to `to` (the wallet closes: balance minus the 5000 lamport fee). Returns lamports that actually left. */
export async function sweepWallets(conn: Connection, wallets: Keypair[], to: PublicKey, d: { sleep: (ms: number) => Promise<void>; pace?: () => Promise<void>; log?: (m: string) => void }): Promise<number> {
  const left = new Map<string, number>();
  for (const kp of wallets) {
    try {
      const bal = await conn.getBalance(kp.publicKey, 'confirmed');
      if (bal <= 5_000) continue;
      left.set(kp.publicKey.toBase58(), bal);
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: bal - 5_000 }));
      tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; tx.feePayer = kp.publicKey; tx.sign(kp);
      await d.pace?.();
      await conn.sendRawTransaction(tx.serialize());
    } catch (e: any) { d.log?.(`sweep ${kp.publicKey.toBase58().slice(0, 6)} failed: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
  await d.sleep(2000);
  let swept = 0;
  for (const kp of wallets) { // count only what actually left the wallets
    const was = left.get(kp.publicKey.toBase58());
    if (was === undefined) continue;
    try { const now = await conn.getBalance(kp.publicKey, 'confirmed'); if (now < was) swept += was - now - 5_000; } catch { /* unknown: not counted */ }
  }
  return swept;
}

/** Reads a Solana keypair JSON for the seed funder. Refuses anything but mode 0600; no error message contains key material. */
export function loadFunderKeypair(file: string): Keypair {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { throw new SeedGuardError(`funder keyfile ${file} cannot be read`); }
  if (!st.isFile()) throw new SeedGuardError(`funder keyfile ${file} is not a file`);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) throw new SeedGuardError(`funder keyfile ${file} must be mode 0600 (it is 0${mode.toString(8)}); run: chmod 600 ${file}`);
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('shape');
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { throw new SeedGuardError(`funder keyfile ${file} is not a Solana keypair JSON (an array of 64 bytes)`); }
}

export interface SeedSigner {
  publicKey: PublicKey;
  /** Adds the funder's signature to a transaction that may already carry others. */
  sign(tx: Transaction): Promise<void>;
}

export interface SeedOptions {
  connection: Connection;
  signer: SeedSigner;
  /** devnet's genesis hash; the proof run on the local chain passes the local chain's. The CLI always passes devnet's. */
  allowedGenesis: string;
  buyers?: number;
  buySol?: number;
  windowMs?: number;
  capSol?: number;
  dryRun?: boolean;
  sweep?: boolean;
  name?: string;
  symbol?: string;
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Directory for the buyer wallet file. Default .overnight/seed-wallets (gitignored). */
  walletDir?: string;
  /** Minimum gap between two sends. Default 400 ms (the public devnet RPC rate-limits hard). */
  minSendGapMs?: number;
  retry?: RetryOptions;
}

export interface SeedPlan {
  buyers: number;
  buySol: number;
  perBuyerFundSol: number;
  createCostSol: number;
  fundingSol: number;
  grossSol: number;
  capSol: number;
  reasons: string[];
}

export function perBuyerFundSol(buySol: number): number {
  return Math.ceil((buySol * BUY_HEADROOM + BUYER_ACCOUNT_OVERHEAD_SOL) * 1e6) / 1e6;
}

/** Pure arithmetic: what the run would cost and whether it fits. Never returns a plan above the hard cap. */
export function planSeed(o: { buyers?: number; buySol?: number; capSol?: number }): SeedPlan {
  const reasons: string[] = [];
  const buyers = o.buyers ?? 30;
  const buySol = o.buySol ?? 0.01;
  const capSol = o.capSol ?? HARD_CAP_SOL;
  if (!Number.isInteger(buyers) || buyers < 1 || buyers > 60) reasons.push(`buyers must be a whole number from 1 to 60 (got ${buyers})`);
  if (!(buySol > 0) || buySol > 0.05) reasons.push(`buy-sol must be above 0 and at most 0.05 (got ${buySol})`);
  if (!(capSol > 0)) reasons.push(`cap-sol must be positive (got ${capSol})`);
  if (capSol > HARD_CAP_SOL) reasons.push(`cap-sol ${capSol} is above the hard limit of ${HARD_CAP_SOL} SOL`);
  const per = perBuyerFundSol(Number.isFinite(buySol) ? buySol : 0);
  const fundingSol = per * (Number.isFinite(buyers) ? buyers : 0);
  const grossSol = fundingSol + CREATE_COST_SOL;
  if (grossSol > Math.min(capSol, HARD_CAP_SOL) + 1e-9) {
    const fit = Math.max(0, Math.floor((Math.min(capSol, HARD_CAP_SOL) - CREATE_COST_SOL) / per));
    reasons.push(`the plan needs ${grossSol.toFixed(4)} SOL (create ${CREATE_COST_SOL} + ${buyers} x ${per.toFixed(6)}), above the ${Math.min(capSol, HARD_CAP_SOL)} SOL cap; ${fit} buyers would fit`);
  }
  return { buyers, buySol, perBuyerFundSol: per, createCostSol: CREATE_COST_SOL, fundingSol, grossSol, capSol: Math.min(capSol, HARD_CAP_SOL), reasons };
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;
const MAINNET_URL = /mainnet|jito\.wtf/i;

/** Checks that need no network. The genesis-hash check (the authoritative one) is in runSeed. */
export function assertDevnetTarget(rpcUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const cluster = (env.ALLOWED_CLUSTER || 'devnet').trim();
  if (cluster !== 'devnet') throw new SeedGuardError(`ALLOWED_CLUSTER is "${cluster}"; the seeding script runs on devnet only`);
  let u: URL;
  try { u = new URL(rpcUrl); } catch { throw new SeedGuardError(`SOLANA_RPC_URL is not a URL`); }
  if (u.protocol !== 'https:') throw new SeedGuardError(`the RPC URL must be https (got ${u.protocol})`);
  if (PRIVATE_HOST.test(u.hostname)) throw new SeedGuardError(`the RPC host ${u.hostname} is loopback or private; a relay can claim any genesis hash, so it is refused`);
  if (MAINNET_URL.test(rpcUrl)) throw new SeedGuardError('the RPC URL looks like mainnet');
}

export interface SeedReport {
  dryRun: boolean;
  plan: SeedPlan;
  genesisHash: string;
  funder: string;
  funderBalanceSol: number;
  mint?: string;
  createSignature?: string;
  walletFile?: string;
  buyers: Array<{ wallet: string; signature?: string; error?: string; landedAtMs?: number }>;
  buysLanded: number;
  buyWindowMs?: number;
  funderSpentSol?: number;
  sweptSol?: number;
  signatures: string[];
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSeed(o: SeedOptions): Promise<SeedReport> {
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? sleepReal;
  const plan = planSeed({ buyers: o.buyers, buySol: o.buySol, capSol: o.capSol });
  if (plan.reasons.length) throw new SeedGuardError(plan.reasons.join('; '));
  const { signer } = o;
  const conn = retryingConnection(o.connection, sleep, o.retry, (m) => log(`retry ${m}`));

  const genesisHash = await conn.getGenesisHash();
  if (genesisHash !== o.allowedGenesis) throw new SeedGuardError(`genesis hash ${genesisHash} is not the allowed cluster's (${o.allowedGenesis}); nothing was sent`);
  const balance = (await conn.getBalance(signer.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
  const report: SeedReport = { dryRun: !!o.dryRun, plan, genesisHash, funder: signer.publicKey.toBase58(), funderBalanceSol: balance, buyers: [], buysLanded: 0, signatures: [] };
  if (balance < plan.grossSol + FUNDER_RESERVE_SOL) throw new SeedGuardError(`funder holds ${balance.toFixed(4)} SOL; the plan needs ${plan.grossSol.toFixed(4)} plus a ${FUNDER_RESERVE_SOL} reserve`);
  log(`plan: ${plan.buyers} buyers x ${plan.buySol} SOL, fund ${plan.perBuyerFundSol} each, create ${plan.createCostSol}, gross ${plan.grossSol.toFixed(4)} SOL (cap ${plan.capSol})`);
  if (o.dryRun) { log('dry run: nothing was sent'); return report; }

  // From here on every send is counted against the cap before it happens.
  const startBalance = await conn.getBalance(signer.publicKey, 'confirmed');
  const spentSoFar = async () => (startBalance - (await conn.getBalance(signer.publicKey, 'confirmed'))) / LAMPORTS_PER_SOL;
  const minGap = o.minSendGapMs ?? 400;
  let lastSendAt = 0;
  const pace = async () => { const wait = minGap - (Date.now() - lastSendAt); if (wait > 0) await sleep(wait); lastSendAt = Date.now(); };
  const confirm = async (sig: string, what: string): Promise<void> => {
    for (let i = 0; i < 60; i++) {
      const st = (await conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`${what} ${sig.slice(0, 8)} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
      await sleep(700);
    }
    throw new Error(`${what} ${sig.slice(0, 8)} not confirmed in 40 s`);
  };
  const sendAndConfirm = async (tx: Transaction, signers: Keypair[], what: string): Promise<string> => {
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.feePayer = signer.publicKey;
    if (signers.length) tx.partialSign(...signers);
    await signer.sign(tx);
    await pace();
    const sig = await conn.sendRawTransaction(tx.serialize());
    report.signatures.push(sig);
    await confirm(sig, what);
    return sig;
  };

  // pump modules load the cluster guard from the environment, so they are imported only after the checks above
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { PumpCurveService } = await import('../server/solana/pumpCurve');
  const { txBuilder } = await import('../server/solana/transactionBuilder');

  // Keys first: the mint and the buyer wallets are generated and written to disk before a single lamport moves.
  const mintKp = Keypair.generate();
  const wallets = Array.from({ length: plan.buyers }, () => Keypair.generate());
  report.mint = mintKp.publicKey.toBase58();
  report.walletFile = saveWalletFile(o.walletDir ?? DEFAULT_WALLET_DIR, mintKp.publicKey, signer.publicKey, wallets);
  log(`buyer keys saved to ${report.walletFile} (0600) before funding`);

  let funded = false;
  try {
    // 1. the token: create_v2 alone, no buy in the same transaction
    const createIx = await (PUMP_SDK as any).createV2Instruction({
      mint: mintKp.publicKey, name: o.name ?? 'Apex Seed', symbol: o.symbol ?? 'SEED', uri: 'https://example.invalid/apex-seed.json',
      creator: signer.publicKey, user: signer.publicKey, mayhemMode: false,
    });
    const createTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), createIx);
    report.createSignature = await sendAndConfirm(createTx, [mintKp], 'create');
    log(`created ${report.mint} (${report.createSignature.slice(0, 8)}…)`);

    // 2. the buyers, funded from the funder in a few transfers
    const fundLamports = Math.round(plan.perBuyerFundSol * LAMPORTS_PER_SOL);
    for (let i = 0; i < wallets.length; i += 10) {
      if ((await spentSoFar()) + (Math.min(10, wallets.length - i) * fundLamports) / LAMPORTS_PER_SOL > plan.capSol) throw new SeedGuardError('the next funding transfer would take the spend past the cap; stopped');
      const tx = new Transaction();
      for (const w of wallets.slice(i, i + 10)) tx.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: w.publicKey, lamports: fundLamports }));
      funded = true; // from the send on, the wallets may hold money
      await sendAndConfirm(tx, [], 'fund');
    }
    log(`funded ${wallets.length} wallets with ${plan.perBuyerFundSol} SOL each`);

    // 3. the buys, spread evenly over the window, no sells
    const windowMs = o.windowMs ?? 30_000;
    const gap = windowMs / wallets.length;
    const t0 = Date.now();
    const mint = mintKp.publicKey;
    const doBuy = async (kp: Keypair, idx: number) => {
      const entry: SeedReport['buyers'][number] = { wallet: kp.publicKey.toBase58() };
      report.buyers[idx] = entry;
      try {
        const state = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' });
        if (!state) throw new Error('curve state not readable');
        const q = PumpCurveService.calculateBuyQuote({ state, amountSol: plan.buySol, slippageBps: 1500, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' } as any);
        const tx = await txBuilder.buildBuyTransaction(conn, {
          buyer: kp.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
          associatedUser: PumpCurveService.getAssociatedTokenAddress(mint, kp.publicKey, state.tokenProgram), creator: state.creator,
          feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
          tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: BigInt(q.tokenAmountRaw),
          maxSolCostLamports: BigInt(q.maxInputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
        } as any);
        tx.sign([kp]);
        await pace();
        const sig = await conn.sendRawTransaction(tx.serialize());
        report.signatures.push(sig);
        await confirm(sig, 'buy');
        entry.signature = sig; entry.landedAtMs = Date.now() - t0;
      } catch (e: any) { entry.error = String(e?.message ?? e).slice(0, 160); }
    };
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < wallets.length; i++) {
      inflight.push(doBuy(wallets[i], i));
      await sleep(gap);
    }
    await Promise.all(inflight);
    report.buyWindowMs = Date.now() - t0;
    report.buysLanded = report.buyers.filter((b) => b?.signature).length;
    log(`${report.buysLanded}/${wallets.length} buys landed in ${(report.buyWindowMs / 1000).toFixed(1)} s`);
  } catch (e: any) {
    // Any failure after money moved: bring it back before exiting. The wallet file stays for `--sweep` if even this fails.
    let swept = 0;
    if (funded) {
      log(`FAILED (${String(e?.message ?? e).slice(0, 100)}); sweeping the buyer wallets back to the funder`);
      try { swept = await sweepWallets(conn, wallets, signer.publicKey, { sleep, pace, log }); } catch (e2: any) { log(`sweep failed: ${String(e2?.message ?? e2).slice(0, 100)}`); }
    }
    report.sweptSol = swept / LAMPORTS_PER_SOL;
    try { report.funderSpentSol = await spentSoFar(); } catch { /* unknown */ }
    if (e instanceof SeedGuardError && !funded) throw e;
    throw new SeedRunError(`${String(e?.message ?? e)}${funded ? ` (swept ${report.sweptSol.toFixed(4)} SOL back; keys in ${report.walletFile}, recover any rest with --sweep)` : ''}`, report, report.sweptSol, report.walletFile, e);
  }

  // 4. what is left in the buyer wallets goes back to the funder (the tokens stay; a token account's rent stays with it)
  let swept = 0;
  if (o.sweep !== false) swept = await sweepWallets(conn, wallets, signer.publicKey, { sleep, pace, log });
  report.sweptSol = swept / LAMPORTS_PER_SOL;
  report.funderSpentSol = await spentSoFar();
  log(`swept ${report.sweptSol.toFixed(4)} SOL back; funder spent ${report.funderSpentSol.toFixed(4)} SOL in total`);
  if (report.funderSpentSol > plan.capSol) log(`WARNING: spend ${report.funderSpentSol} is above the cap ${plan.capSol}`);
  return report;
}

/** Recovers SOL from the buyer wallets in a saved wallet file. Sends only to the funder named in the file. */
export async function sweepFromFile(o: { connection: Connection; allowedGenesis: string; file: string; log?: (m: string) => void; sleep?: (ms: number) => Promise<void>; minSendGapMs?: number; retry?: RetryOptions }): Promise<{ wallets: number; sweptSol: number; funder: string; mint: string }> {
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? sleepReal;
  const conn = retryingConnection(o.connection, sleep, o.retry, (m) => log(`retry ${m}`));
  const genesis = await conn.getGenesisHash();
  if (genesis !== o.allowedGenesis) throw new SeedGuardError(`genesis hash ${genesis} is not the allowed cluster's (${o.allowedGenesis}); nothing was sent`);
  const { funder, mint, wallets } = loadWalletFile(o.file);
  const minGap = o.minSendGapMs ?? 400;
  let lastSendAt = 0;
  const pace = async () => { const wait = minGap - (Date.now() - lastSendAt); if (wait > 0) await sleep(wait); lastSendAt = Date.now(); };
  log(`sweeping ${wallets.length} wallets of mint ${mint} back to ${funder.toBase58()}`);
  const swept = await sweepWallets(conn, wallets, funder, { sleep, pace, log });
  return { wallets: wallets.length, sweptSol: swept / LAMPORTS_PER_SOL, funder: funder.toBase58(), mint };
}

// ---- CLI -------------------------------------------------------------------------------------------------------------
async function main() {
  await import('../server/loadEnv');
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(`--${n}`);
  const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  // SEED_RPC_URL (a private devnet RPC) wins over SOLANA_RPC_URL; both go through the same devnet guards. The URL is never printed (it may carry a key).
  const rpcUrl = (process.env.SEED_RPC_URL || process.env.SOLANA_RPC_URL || '').trim();
  try {
    if (!rpcUrl) throw new SeedGuardError('SEED_RPC_URL / SOLANA_RPC_URL is not set (the script never falls back to a default)');
    assertDevnetTarget(rpcUrl);
    const keyfile = val('funder-keyfile') || (process.env.SEED_FUNDER_KEYPAIR_PATH || '').trim() || undefined;
    if (flag('funder-keyfile') && (!keyfile || keyfile.startsWith('--'))) throw new SeedGuardError('--funder-keyfile needs a file path');
    if (keyfile && !flag('sweep')) loadFunderKeypair(keyfile); // a bad keyfile fails here, before any connection
    const conn = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false });
    if (flag('sweep')) {
      const file = val('sweep');
      if (!file || file.startsWith('--')) throw new SeedGuardError('--sweep needs the wallet file path');
      const r = await sweepFromFile({ connection: conn, allowedGenesis: DEVNET_GENESIS_HASH, file, log: (m) => console.log(m) });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    // A separate funder keeps the app's wallet audit quiet; without one the app wallet pays (and the audit will see a drain).
    let signer: SeedSigner;
    if (keyfile) {
      const kp = loadFunderKeypair(keyfile);
      signer = { publicKey: kp.publicKey, sign: async (tx) => { tx.partialSign(kp); } };
      console.log(`funder: ${kp.publicKey.toBase58()} (separate seed wallet from ${keyfile})`);
      try {
        const { localSigner } = await import('../server/solana/signer');
        if (localSigner.getPublicKey?.().equals(kp.publicKey)) console.log('WARNING: that keyfile IS the app wallet; the app\'s wallet audit will halt auto trading while the seed funds buyers');
      } catch { /* no app wallet configured: nothing to compare */ }
    } else {
      const { localSigner } = await import('../server/solana/signer');
      const pub = localSigner.getPublicKey?.();
      if (!pub) throw new SeedGuardError('no funder wallet: set OPERATOR_PRIVATE_KEY or SIGNER_KEYPAIR_PATH in .env, or give --funder-keyfile / SEED_FUNDER_KEYPAIR_PATH');
      const kp = localSigner.exportKeypair();
      if (!kp) throw new Error('funder keypair is not readable');
      signer = { publicKey: pub, sign: async (tx) => { tx.partialSign(kp); } };
      console.log(`funder: ${pub.toBase58()} (the APP wallet: its auto controller will see this as an unexplained balance change and halt trading)`);
    }
    const report = await runSeed({
      connection: conn, signer, allowedGenesis: DEVNET_GENESIS_HASH,
      buyers: val('buyers') ? Number(val('buyers')) : undefined, buySol: val('buy-sol') ? Number(val('buy-sol')) : undefined,
      windowMs: val('window-s') ? Number(val('window-s')) * 1000 : undefined, capSol: val('cap-sol') ? Number(val('cap-sol')) : undefined,
      dryRun: !flag('execute'), sweep: !flag('no-sweep'), log: (m) => console.log(m),
    });
    console.log(JSON.stringify({ ...report, buyers: report.buyers.map((b) => ({ ...b, wallet: b.wallet.slice(0, 6) })) }, null, 2));
    if (report.dryRun) console.log('\nDRY RUN: nothing was sent. Add --execute to spend devnet SOL.');
  } catch (e: any) {
    console.error(String(e?.message ?? e));
    if (e instanceof SeedRunError) console.error(JSON.stringify({ mint: e.report.mint, walletFile: e.walletFile, sweptSol: e.sweptSol, funderSpentSol: e.report.funderSpentSol, signatures: e.report.signatures.length }));
    process.exit(e instanceof SeedGuardError ? 2 : 1);
  }
}

if (process.argv[1] && /devnet_seed\.(ts|js)$/.test(process.argv[1])) void main();
