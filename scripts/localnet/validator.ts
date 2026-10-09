/**
 * Local Solana "validator" for end-to-end tests: a LiteSVM bank behind a JSON-RPC HTTP server (plus a minimal
 * logsSubscribe WebSocket) so the app's real `Connection`, transaction builder, signer, reconciler and HTTP API are
 * exercised against the REAL pump.fun / fee / PumpSwap program binaries dumped from devnet (see MANIFEST.json).
 *
 * This is LiteSVM, not solana-test-validator: one in-process bank, a slot per transaction, no consensus, no
 * forks, no commitment levels (everything is final), no address lookup tables. It listens on loopback only and
 * refuses any other bind address. It never contacts a remote cluster.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { WebSocketServer, WebSocket } from 'ws';
import { LiteSVM } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { PublicKey, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import * as pumpSdk from '@pump-fun/pump-sdk';

/**
 * Adapter over LiteSVM 1.x (kit types) that speaks web3.js types. (litesvm 0.x corrupts the V8 heap on Node 22 after a
 * few pump-program transactions: std::bad_alloc inside V8's GC. 1.x does not.)
 */
class Bank {
  private readonly svm = new LiteSVM().withSigverify(false).withBlockhashCheck(true);
  private readonly decoder = getTransactionDecoder();
  addProgram(id: PublicKey, bytes: Uint8Array) {
    this.svm.addProgram(id.toBase58() as any, bytes);
  }
  setAccount(pk: PublicKey, a: { lamports: number | bigint; data: Uint8Array; owner: PublicKey; executable?: boolean }) {
    this.svm.setAccount({
      address: pk.toBase58(), lamports: BigInt(a.lamports), data: new Uint8Array(a.data), programAddress: a.owner.toBase58(),
      executable: !!a.executable, space: BigInt(a.data.length),
    } as any);
  }
  getAccount(pk: PublicKey): { lamports: bigint; data: Uint8Array; owner: PublicKey; executable: boolean } | null {
    const a: any = this.svm.getAccount(pk.toBase58() as any);
    if (!a?.exists) return null;
    return { lamports: a.lamports, data: a.data, owner: new PublicKey(a.programAddress), executable: !!a.executable };
  }
  /** Every account owned by `program` (used for token-account queries). */
  programAccounts(program: string): { address: string }[] {
    return (this.svm.getProgramAccounts(program as any) as any[]).map((a) => ({ address: String(a.address) }));
  }
  getBalance(pk: PublicKey): bigint | null {
    return this.svm.getBalance(pk.toBase58() as any) as bigint | null;
  }
  airdrop(pk: PublicKey, lamports: bigint) {
    return this.svm.airdrop(pk.toBase58() as any, lamports as any);
  }
  latestBlockhash(): string {
    return this.svm.latestBlockhash() as string;
  }
  expireBlockhash() {
    this.svm.expireBlockhash();
  }
  warpToSlot(slot: bigint) {
    this.svm.warpToSlot(slot);
  }
  minimumBalanceForRentExemption(len: bigint): bigint {
    return this.svm.minimumBalanceForRentExemption(len);
  }
  private kitTx(tx: VersionedTransaction) {
    return this.decoder.decode(tx.serialize());
  }
  sendTransaction(tx: VersionedTransaction): any {
    return this.svm.sendTransaction(this.kitTx(tx));
  }
  simulateTransaction(tx: VersionedTransaction): any {
    return this.svm.simulateTransaction(this.kitTx(tx));
  }
}

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const LAMPORTS_PER_SIGNATURE = 5000n;

export const PROGRAMS: { name: string; id: string }[] = [
  { name: 'pump', id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' },
  { name: 'fee', id: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ' },
  { name: 'pumpswap', id: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
];
const DATA_ACCOUNTS = [
  'pump_global',
  'pump_event_authority',
  'pump_fee_config',
  'pump_global_volume_accumulator',
  'pumpswap_global_config',
  'pumpswap_fee_config',
];

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  programId: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
}
interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number;
  raw: Uint8Array;
  keys: string[];
  err: unknown;
  fee: number;
  pre: number[];
  post: number[];
  preTokens: TokenBalance[];
  postTokens: TokenBalance[];
  logs: string[];
  cu: number;
  json: any;
}

const b64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(msg: Uint8Array, sig: Uint8Array, pk: Uint8Array): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pk)]), format: 'der', type: 'spki' });
    return crypto.verify(null, msg, key, sig);
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export class LocalnetValidator {
  readonly svm: Bank;
  readonly genesisHash: string;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private txs = new Map<string, TxRecord>();
  private byAddress = new Map<string, string[]>();
  private known = new Set<string>();
  private validBlockhashes: string[] = [];
  private logSubs = new Map<number, { ws: WebSocket; filter: any }>();
  private nextSub = 1;
  private slot = 1000n;
  private sendFailures: { remaining: number; error: string } | null = null;
  /** Raw transactions (competing trades) that land immediately BEFORE the next sendTransaction from the app. */
  private frontrun: Uint8Array[] = [];
  /** When true the next sendTransaction lands on-chain but its HTTP response is never sent (process-kill tests). */
  private holdNextResponse = false;
  heldSignatures: string[] = [];
  /** RPC methods that were called but are not implemented; tests assert this stays empty. */
  readonly unsupported = new Set<string>();
  /** Every RPC method call, for the endpoint-coverage report. */
  readonly methodCounts = new Map<string, number>();
  port = 0;

  constructor(opts: { accountsDir?: string } = {}) {
    this.svm = new Bank();
    this.genesisHash = bs58.encode(crypto.randomBytes(32));
    this.svm.warpToSlot(this.slot);
    const dir = opts.accountsDir || process.env.LOCALNET_ACCOUNTS_DIR || path.resolve('scripts/localnet/accounts');
    this.loadDumps(dir);
    this.ensureNativeMint();
    this.prefundFeeRecipients();
    this.noteBlockhash();
  }

  /**
   * On a real cluster the wallets that receive pump fees already hold SOL. In a fresh bank they do not, and a lamport
   * credit that leaves a new system account below the rent minimum is rejected (InsufficientFundsForRent). Fund every
   * fee recipient named in the dumped Global account.
   */
  private prefundFeeRecipients() {
    const global = this.svm.getAccount(new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'));
    if (!global) return;
    const sdk: any = (pumpSdk as any).PUMP_SDK ?? (pumpSdk as any).default?.PUMP_SDK;
    const g = sdk.decodeGlobal({ data: Buffer.from(global.data), owner: global.owner, lamports: 1, executable: false });
    const keys = new Set<string>();
    for (const [k, v] of Object.entries(g)) {
      if (!/ecipient/i.test(k)) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (x?.toBase58) keys.add(x.toBase58());
    }
    for (const k of keys) this.svm.airdrop(new PublicKey(k), 100_000_000n);
  }

  /** A real cluster has the wrapped-SOL mint from genesis; pump v2 reads it as the quote mint. */
  private ensureNativeMint() {
    const wsol = new PublicKey('So11111111111111111111111111111111111111112');
    if (this.svm.getAccount(wsol)) return;
    const data = Buffer.alloc(82);
    data.writeBigUInt64LE(0n, 36); // supply (native mint supply is not tracked)
    data[44] = 9; // decimals
    data[45] = 1; // is_initialized
    this.svm.setAccount(wsol, { lamports: 1_461_600, data, owner: new PublicKey(TOKEN_PROGRAM), executable: false });
    this.known.add(wsol.toBase58());
  }

  private loadDumps(dir: string) {
    for (const p of PROGRAMS) {
      const f = path.join(dir, `${p.name === 'pump' ? 'pump' : p.name}_programdata.json`);
      if (!fs.existsSync(f)) continue;
      const pd = Buffer.from(JSON.parse(fs.readFileSync(f, 'utf8')).account.data[0], 'base64');
      // upgradeable loader ProgramData header is 45 bytes (4 state + 8 slot + 1 option + 32 authority)
      this.svm.addProgram(new PublicKey(p.id), pd.subarray(45));
      this.known.add(p.id);
    }
    for (const n of DATA_ACCOUNTS) {
      const f = path.join(dir, `${n}.json`);
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const a = j.account;
      const data = Buffer.from(a.data[0], 'base64');
      if (n === 'pump_global') {
        // The devnet Global account starts every curve at 1 SOL of virtual reserves, so a curve completes after ~3.4 SOL.
        // Production curves start at 30 SOL (completing near 85 SOL). Patch initial_virtual_sol_reserves (offset 81) so
        // local trades are production-sized; LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS=1000000000 keeps the devnet value.
        data.writeBigUInt64LE(BigInt(process.env.LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS || '30000000000'), 81);
      }
      this.svm.setAccount(new PublicKey(j.pubkey), {
        lamports: a.lamports,
        data,
        owner: new PublicKey(a.owner),
        executable: false,
      });
      this.known.add(j.pubkey);
    }
    // fee program's config account is owned by the fee program; the manifest names it pump_fee_config
  }

  // ---- state helpers -------------------------------------------------------------------------------------------
  private noteBlockhash() {
    this.validBlockhashes.push(this.svm.latestBlockhash());
    if (this.validBlockhashes.length > 150) this.validBlockhashes.shift();
  }
  airdrop(pubkey: PublicKey, lamports: bigint) {
    this.svm.airdrop(pubkey, lamports);
    this.known.add(pubkey.toBase58());
  }
  /** Expire the current blockhash (tests for BLOCKHASH_EXPIRED). */
  expireBlockhash() {
    this.svm.expireBlockhash();
    this.validBlockhashes = [];
    this.noteBlockhash();
  }
  /** Make the next `count` sendRawTransaction calls fail before reaching the bank. */
  failNextSends(count: number, error = 'localnet: injected send failure') {
    this.sendFailures = { remaining: count, error };
  }
  getSlot() {
    return Number(this.slot);
  }
  getBalance(pk: PublicKey): bigint {
    return this.svm.getBalance(pk) ?? 0n;
  }

  // ---- token parsing -------------------------------------------------------------------------------------------
  private parseTokenAccount(addr: string): { mint: string; owner: string; amount: bigint; programId: string } | null {
    const a = this.svm.getAccount(new PublicKey(addr));
    if (!a) return null;
    const owner = new PublicKey(a.owner).toBase58();
    if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) return null;
    const d = Buffer.from(a.data);
    if (d.length < 165) return null;
    if (owner === TOKEN_2022_PROGRAM && d.length > 165 && d[165] !== 2) return null;
    return { mint: new PublicKey(d.subarray(0, 32)).toBase58(), owner: new PublicKey(d.subarray(32, 64)).toBase58(), amount: d.readBigUInt64LE(64), programId: owner };
  }
  private allTokenAccounts(): string[] {
    return [...this.svm.programAccounts(TOKEN_PROGRAM), ...this.svm.programAccounts(TOKEN_2022_PROGRAM)].map((a) => a.address);
  }
  private mintDecimals(mint: string): number {
    const a = this.svm.getAccount(new PublicKey(mint));
    if (!a) return 0;
    return Buffer.from(a.data)[44] ?? 0;
  }
  private ui(amount: bigint, decimals: number) {
    const s = decimals === 0 ? amount.toString() : (Number(amount) / 10 ** decimals).toString();
    return { amount: amount.toString(), decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: s };
  }
  private snapshot(keys: string[]) {
    const lamports: number[] = [];
    const tokens: TokenBalance[] = [];
    keys.forEach((k, i) => {
      lamports.push(Number(this.svm.getBalance(new PublicKey(k)) ?? 0n));
      const t = this.parseTokenAccount(k);
      if (t) tokens.push({ accountIndex: i, mint: t.mint, owner: t.owner, programId: t.programId, uiTokenAmount: this.ui(t.amount, this.mintDecimals(t.mint)) });
    });
    return { lamports, tokens };
  }

  // ---- fee model -----------------------------------------------------------------------------------------------
  private computeFee(tx: VersionedTransaction): bigint {
    let units = 200_000n;
    let price = 0n;
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex] !== COMPUTE_BUDGET) continue;
      const d = Buffer.from(ix.data);
      if (d[0] === 2) units = BigInt(d.readUInt32LE(1));
      if (d[0] === 3) price = d.readBigUInt64LE(1);
    }
    return LAMPORTS_PER_SIGNATURE * BigInt(tx.signatures.length) + (units * price + 999_999n) / 1_000_000n;
  }

  // ---- transactions --------------------------------------------------------------------------------------------
  private verifySignatures(tx: VersionedTransaction) {
    const msg = tx.message.serialize();
    const n = tx.message.header.numRequiredSignatures;
    for (let i = 0; i < n; i++) {
      const sig = tx.signatures[i];
      const pk = tx.message.staticAccountKeys[i].toBytes();
      if (!sig || !verifyEd25519(msg, sig, pk)) throw new RpcError(-32003, 'Transaction signature verification failure');
    }
  }

  sendRaw(raw: Uint8Array, internal = false): string {
    if (!internal) {
      while (this.frontrun.length) this.sendRaw(this.frontrun.shift()!, true);
    }
    if (!internal && this.sendFailures && this.sendFailures.remaining > 0) {
      this.sendFailures.remaining--;
      throw new RpcError(-32002, this.sendFailures.error);
    }
    const tx = VersionedTransaction.deserialize(raw);
    this.verifySignatures(tx);
    if (tx.message.addressTableLookups.length) throw new RpcError(-32602, 'localnet: address lookup tables are not supported');
    const signature = bs58.encode(tx.signatures[0]);
    if (this.txs.has(signature)) throw new RpcError(-32002, 'Transaction simulation failed: This transaction has already been processed');
    const bh = tx.message.recentBlockhash;
    if (!this.validBlockhashes.includes(bh)) throw new RpcError(-32002, 'Transaction simulation failed: Blockhash not found');

    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    keys.forEach((k) => this.known.add(k));
    const pre = this.snapshot(keys);
    const fee = this.computeFee(tx);
    const res: any = this.svm.sendTransaction(tx);
    const failed = typeof res.err === 'function';
    const err = failed ? this.errToJson(res.err()) : null;
    const meta = failed ? res.meta() : res;
    this.slot += 1n;
    this.svm.warpToSlot(this.slot);
    const post = this.snapshot(keys);
    const logs: string[] = meta.logs();
    const cu = Number(meta.computeUnitsConsumed());
    const rec: TxRecord = {
      signature, slot: Number(this.slot), blockTime: Math.floor(Date.now() / 1000), raw, keys, err, fee: Number(fee),
      pre: pre.lamports, post: post.lamports, preTokens: pre.tokens, postTokens: post.tokens, logs, cu, json: null,
    };
    // Failed transactions still pay the fee; LiteSVM already charged it in the bank.
    this.txs.set(signature, rec);
    for (const k of new Set(keys)) {
      const l = this.byAddress.get(k) ?? [];
      l.unshift(signature);
      this.byAddress.set(k, l);
    }
    this.notifyLogs(rec);
    return signature;
  }

  private errToJson(e: any): unknown {
    if (e && typeof e === 'object' && typeof e.index === 'number' && typeof e.err === 'function') {
      const inner = e.err();
      if (inner && typeof inner === 'object' && typeof inner.code === 'number') return { InstructionError: [e.index, { Custom: inner.code }] };
      if (inner && typeof inner === 'object' && typeof inner.msg === 'string') return { InstructionError: [e.index, { BorshIoError: inner.msg }] };
      return { InstructionError: [e.index, INSTRUCTION_ERRORS[inner as number] ?? `InstructionError#${inner}`] };
    }
    if (typeof e === 'number') return TRANSACTION_ERRORS[e] ?? `TransactionError#${e}`;
    if (e && typeof e === 'object' && typeof e.accountIndex === 'number') return { InsufficientFundsForRent: { account_index: e.accountIndex } };
    return String(e?.toString?.() ?? e);
  }

  private txJson(rec: TxRecord) {
    const tx = VersionedTransaction.deserialize(rec.raw);
    const m = tx.message;
    return {
      slot: rec.slot,
      blockTime: rec.blockTime,
      version: m.version === 'legacy' ? 'legacy' : 0,
      transaction: {
        signatures: tx.signatures.map((s) => bs58.encode(s)),
        message: {
          header: m.header,
          accountKeys: rec.keys,
          recentBlockhash: m.recentBlockhash,
          instructions: m.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: Array.from(ix.accountKeyIndexes), data: bs58.encode(ix.data), stackHeight: null })),
          ...(m.version === 'legacy' ? {} : { addressTableLookups: [] }),
        },
      },
      meta: {
        err: rec.err, status: rec.err ? { Err: rec.err } : { Ok: null }, fee: rec.fee,
        preBalances: rec.pre, postBalances: rec.post, innerInstructions: [], logMessages: rec.logs,
        preTokenBalances: rec.preTokens, postTokenBalances: rec.postTokens, rewards: [], loadedAddresses: { writable: [], readonly: [] },
        computeUnitsConsumed: rec.cu,
      },
    };
  }

  // ---- log subscriptions ---------------------------------------------------------------------------------------
  private notifyLogs(rec: TxRecord) {
    for (const [id, sub] of this.logSubs) {
      if (sub.ws.readyState !== WebSocket.OPEN) continue;
      const f = sub.filter;
      let match = f === 'all' || f === 'allWithVotes';
      if (!match && f?.mentions) match = f.mentions.some((m: string) => rec.keys.includes(m) || rec.logs.some((l) => l.includes(m)));
      if (!match) continue;
      sub.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: id, result: { context: { slot: rec.slot }, value: { signature: rec.signature, err: rec.err, logs: rec.logs } } } }));
    }
  }

  // ---- RPC -----------------------------------------------------------------------------------------------------
  private ctx(value: unknown) {
    return { context: { slot: Number(this.slot), apiVersion: 'localnet-litesvm' }, value };
  }
  private acct(pk: PublicKey, enc: string | undefined, slice?: { offset: number; length: number }) {
    const a = this.svm.getAccount(pk);
    if (!a) return null;
    let data = Buffer.from(a.data);
    if (slice) data = data.subarray(slice.offset, slice.offset + slice.length);
    void enc;
    return { lamports: Number(a.lamports), owner: new PublicKey(a.owner).toBase58(), data: [b64(data), 'base64'], executable: !!a.executable, rentEpoch: 0, space: a.data.length };
  }
  private parsedTokenEntry(addr: string) {
    const t = this.parseTokenAccount(addr)!;
    const a = this.svm.getAccount(new PublicKey(addr))!;
    return {
      pubkey: addr,
      account: {
        lamports: Number(a.lamports), owner: t.programId, executable: false, rentEpoch: 0, space: a.data.length,
        data: { program: t.programId === TOKEN_PROGRAM ? 'spl-token' : 'spl-token-2022', space: a.data.length, parsed: { type: 'account', info: { isNative: false, mint: t.mint, owner: t.owner, state: 'initialized', tokenAmount: this.ui(t.amount, this.mintDecimals(t.mint)) } } },
      },
    };
  }

  handle(method: string, params: any[] = []): unknown {
    if (process.env.LOCALNET_TRACE) console.error('rpc', method, JSON.stringify(params).slice(0, 200));
    this.methodCounts.set(method, (this.methodCounts.get(method) ?? 0) + 1);
    switch (method) {
      case 'getHealth': return 'ok';
      case 'getVersion': return { 'solana-core': '2.0.0-localnet-litesvm', 'feature-set': 0 };
      case 'getGenesisHash': return this.genesisHash;
      case 'getSlot': return Number(this.slot);
      case 'getBlockHeight': return Number(this.slot);
      case 'getEpochInfo': return { epoch: 0, slotIndex: Number(this.slot), slotsInEpoch: 432000, absoluteSlot: Number(this.slot), blockHeight: Number(this.slot), transactionCount: this.txs.size };
      case 'getLatestBlockhash': return this.ctx({ blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: Number(this.slot) + 150 });
      case 'isBlockhashValid': return this.ctx(this.validBlockhashes.includes(params[0]));
      case 'getMinimumBalanceForRentExemption': return Number(this.svm.minimumBalanceForRentExemption(BigInt(params[0] ?? 0)));
      case 'getBalance': return this.ctx(Number(this.svm.getBalance(new PublicKey(params[0])) ?? 0n));
      case 'getAccountInfo': return this.ctx(this.acct(new PublicKey(params[0]), params[1]?.encoding, params[1]?.dataSlice));
      case 'getMultipleAccounts': return this.ctx((params[0] as string[]).map((k) => this.acct(new PublicKey(k), params[1]?.encoding, params[1]?.dataSlice)));
      case 'getTokenAccountBalance': {
        const t = this.parseTokenAccount(params[0]);
        if (!t) throw new RpcError(-32602, 'Invalid param: could not find account');
        return this.ctx(this.ui(t.amount, this.mintDecimals(t.mint)));
      }
      case 'getTokenSupply': {
        const a = this.svm.getAccount(new PublicKey(params[0]));
        if (!a) throw new RpcError(-32602, 'Invalid param: could not find mint');
        return this.ctx(this.ui(Buffer.from(a.data).readBigUInt64LE(36), Buffer.from(a.data)[44]));
      }
      case 'getTokenLargestAccounts': {
        const rows = this.allTokenAccounts().map((k) => ({ k, t: this.parseTokenAccount(k) })).filter((x) => x.t && x.t.mint === params[0]);
        const dec = this.mintDecimals(params[0]);
        rows.sort((a, b) => (b.t!.amount > a.t!.amount ? 1 : -1));
        return this.ctx(rows.slice(0, 20).map((r) => ({ address: r.k, ...this.ui(r.t!.amount, dec) })));
      }
      case 'getParsedTokenAccountsByOwner':
      case 'getTokenAccountsByOwner': {
        const owner = params[0];
        const filter = params[1] || {};
        const rows = this.allTokenAccounts().filter((k) => {
          const t = this.parseTokenAccount(k);
          if (!t || t.owner !== owner) return false;
          if (filter.mint && t.mint !== filter.mint) return false;
          if (filter.programId && t.programId !== filter.programId) return false;
          return true;
        });
        if (method === 'getTokenAccountsByOwner') {
          return this.ctx(rows.map((k) => ({ pubkey: k, account: this.acct(new PublicKey(k), 'base64') })));
        }
        return this.ctx(rows.map((k) => this.parsedTokenEntry(k)));
      }
      case 'getSignatureStatuses': {
        return this.ctx((params[0] as string[]).map((s) => {
          const r = this.txs.get(s);
          if (!r) return null;
          return { slot: r.slot, confirmations: null, err: r.err, status: r.err ? { Err: r.err } : { Ok: null }, confirmationStatus: 'finalized' };
        }));
      }
      case 'getSignaturesForAddress': {
        const lim = params[1]?.limit ?? 1000;
        return (this.byAddress.get(params[0]) ?? []).slice(0, lim).map((s) => {
          const r = this.txs.get(s)!;
          return { signature: s, slot: r.slot, err: r.err, memo: null, blockTime: r.blockTime, confirmationStatus: 'finalized' };
        });
      }
      case 'getTransaction': {
        const r = this.txs.get(params[0]);
        return r ? this.txJson(r) : null;
      }
      case 'sendTransaction': return this.sendRaw(Buffer.from(params[0], params[1]?.encoding === 'base58' ? 'binary' : 'base64'));
      case 'simulateTransaction': return this.simulate(params);
      case 'requestAirdrop': {
        const pk = new PublicKey(params[0]);
        this.airdrop(pk, BigInt(params[1]));
        const sig = bs58.encode(crypto.randomBytes(64));
        return sig;
      }
      // test controls (not part of the Solana RPC surface)
      case 'localnet_expireBlockhash': this.expireBlockhash(); return true;
      case 'localnet_failNextSends': this.failNextSends(Number(params[0] ?? 1), params[1]); return true;
      case 'localnet_frontrunNext': this.frontrun.push(Buffer.from(params[0], 'base64')); return true;
      case 'localnet_holdNextResponse': this.holdNextResponse = true; return true;
      case 'localnet_stats': return { held: this.heldSignatures, methods: Object.fromEntries(this.methodCounts), unsupported: [...this.unsupported], txs: this.txs.size, slot: Number(this.slot) };
      default:
        this.unsupported.add(method);
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  private simulate(params: any[]) {
    const raw = Buffer.from(params[0], params[1]?.encoding === 'base58' ? 'binary' : 'base64');
    const tx = VersionedTransaction.deserialize(raw);
    const opts = params[1] || {};
    if (opts.replaceRecentBlockhash) tx.message.recentBlockhash = this.svm.latestBlockhash();
    else if (!this.validBlockhashes.includes(tx.message.recentBlockhash)) return this.ctx({ err: 'BlockhashNotFound', logs: [], accounts: null, unitsConsumed: 0, returnData: null });
    const res: any = this.svm.simulateTransaction(tx);
    if (typeof res.err === 'function') {
      const meta = res.meta();
      return this.ctx({ err: this.errToJson(res.err()), logs: meta.logs(), accounts: null, unitsConsumed: Number(meta.computeUnitsConsumed()), returnData: null });
    }
    const meta = res.meta();
    return this.ctx({ err: null, logs: meta.logs(), accounts: null, unitsConsumed: Number(meta.computeUnitsConsumed()), returnData: null });
  }

  // ---- server --------------------------------------------------------------------------------------------------
  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    if (!isLoopbackHost(host)) throw new Error(`LocalnetValidator refuses to bind ${host}: loopback only`);
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const run = (r: any) => {
          try {
            const result = this.handle(r.method, r.params);
            if (r.method === 'sendTransaction' && this.holdNextResponse) {
              this.holdNextResponse = false;
              this.heldSignatures.push(String(result));
              return null;
            }
            return { jsonrpc: '2.0', id: r.id, result };
          } catch (e: any) {
            if (e instanceof RpcError) return { jsonrpc: '2.0', id: r.id, error: { code: e.code, message: e.message } };
            return { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: String(e?.message ?? e) } };
          }
        };
        try {
          const j = JSON.parse(body);
          const out = Array.isArray(j) ? j.map(run) : run(j);
          if (out === null) return; // response deliberately withheld (localnet_holdNextResponse)
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
        } catch {
          res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    this.port = (this.server.address() as any).port;
    // web3.js derives the websocket URL as http port + 1
    this.wss = new WebSocketServer({ port: this.port + 1, host });
    this.wss.on('error', () => {});
    this.wss.on('connection', (ws) => {
      ws.on('message', (m) => {
        try {
          const j = JSON.parse(String(m));
          if (j.method === 'logsSubscribe') {
            const id = this.nextSub++;
            this.logSubs.set(id, { ws, filter: j.params?.[0] });
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: id }));
          } else if (j.method === 'logsUnsubscribe') {
            this.logSubs.delete(j.params?.[0]);
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: true }));
          } else {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'Method not found' } }));
          }
        } catch { /* ignore */ }
      });
      ws.on('close', () => { for (const [id, s] of this.logSubs) if (s.ws === ws) this.logSubs.delete(id); });
    });
    return `http://127.0.0.1:${this.port}`;
  }

  async close() {
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

const INSTRUCTION_ERRORS: Record<number, string> = {
  0: 'GenericError', 1: 'InvalidArgument', 2: 'InvalidInstructionData', 3: 'InvalidAccountData', 4: 'AccountDataTooSmall',
  5: 'InsufficientFunds', 6: 'IncorrectProgramId', 7: 'MissingRequiredSignature', 8: 'AccountAlreadyInitialized',
  9: 'UninitializedAccount', 10: 'UnbalancedInstruction', 11: 'ModifiedProgramId', 12: 'ExternalAccountLamportSpend',
  13: 'ExternalAccountDataModified', 14: 'ReadonlyLamportChange', 15: 'ReadonlyDataModified', 16: 'DuplicateAccountIndex',
};
const TRANSACTION_ERRORS: Record<number, string> = {
  0: 'AccountInUse', 1: 'AccountLoadedTwice', 2: 'AccountNotFound', 3: 'ProgramAccountNotFound', 4: 'InsufficientFundsForFee',
  5: 'InvalidAccountForFee', 6: 'AlreadyProcessed', 7: 'BlockhashNotFound',
};

class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export { SystemProgram };
