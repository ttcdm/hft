/**
 * Localnet end-to-end: the app's real HTTP API, auth, RPC client, transaction builder, signer, reconciler and database,
 * against the real pump.fun program binaries running in the LiteSVM-backed local validator (scripts/localnet/validator.ts).
 *
 *   npm run localnet:e2e
 *
 * Processes: (1) local validator on loopback, (2) the app server (`server.ts`) pointed at it, (3) this driver.
 * Safety: ALLOWED_CLUSTER=localnet with the validator's own genesis hash; the server's env is built from scratch (no
 * inheritance, APEX_ENV_FILE='' so the real .env is never read); the key is a throwaway generated here and funded by
 * the LOCAL validator's airdrop; nothing in this script talks to a remote host.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const ROOT = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-localnet-'));
const results: { step: string; ok: boolean; detail: string }[] = [];
const rec = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Startup reconciliation (including the wallet token scan) finishes in the background; arming before it is refused by design. */
async function waitCanArm(call: (m: string, p: string, b?: unknown) => Promise<any>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await call('GET', '/api/execution/can-arm');
    if (last.body?.allowed === true) return last;
    await sleep(500);
  }
  console.log(`can-arm still refused after ${timeoutMs} ms: ${JSON.stringify(last?.body?.reasons)}`);
  return last;
}
const children: ChildProcess[] = [];
const logs: Record<string, string[]> = {};

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
/** web3.js derives ws port = http port + 1, so we need two adjacent free ports. */
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
    } catch { /* try again */ }
  }
  throw new Error('no adjacent free ports');
}

function startProc(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const c = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = [];
  const logFile = path.join(scratch, `${name}.log`);
  c.stdout!.on('data', (d) => { logs[name].push(String(d)); fs.appendFileSync(logFile, d); });
  c.stderr!.on('data', (d) => { logs[name].push(String(d)); fs.appendFileSync(logFile, d); });
  children.push(c);
  return c;
}

const rpcCall = async (url: string, method: string, params: unknown[] = []) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

async function main() {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const validatorPort = await freePortPair();
  const validator = startProc('validator', ['--import', 'tsx', 'scripts/localnet/run_validator.ts', String(validatorPort)], { ...baseEnv, LOCALNET_TRACE: process.env.LOCALNET_TRACE });
  const info: { url: string; genesisHash: string } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('validator did not start: ' + logs.validator.join(''))), 30_000);
    validator.stdout!.on('data', (d) => {
      const line = String(d).split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(t); resolve(JSON.parse(line)); }
    });
  });
  rec('validator', true, `${info.url} genesis ${info.genesisHash} (LiteSVM + real pump program binaries, not solana-test-validator)`);
  const conn = new Connection(info.url, 'confirmed');

  // ---- throwaway keys, funded only by the local validator ----
  const trader = Keypair.generate();
  const creator = Keypair.generate();
  const keyPath = path.join(scratch, 'throwaway-keypair.json');
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(trader.secretKey)), { mode: 0o600 });
  await conn.requestAirdrop(trader.publicKey, 5 * LAMPORTS_PER_SOL);
  await conn.requestAirdrop(creator.publicKey, 20 * LAMPORTS_PER_SOL);
  rec('local faucet', (await conn.getBalance(trader.publicKey)) === 5 * LAMPORTS_PER_SOL, `trader ${trader.publicKey.toBase58()} funded with 5 SOL by the local validator`);

  // The driver process uses the app's own modules to seed a market; it must see the localnet environment.
  process.env.ALLOWED_CLUSTER = 'localnet';
  process.env.LOCALNET_GENESIS_HASH = info.genesisHash;
  process.env.APEX_ENV_FILE = '';
  process.env.SOLANA_RPC_URL = info.url;
  process.env.APEX_DB_PATH = path.join(scratch, 'driver.db');
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { PumpCurveService } = await import('../../server/solana/pumpCurve');
  const { txBuilder } = await import('../../server/solana/transactionBuilder');
  const { assertClusterAllowed } = await import('../../server/solana/clusterGuard');
  const { Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');

  const g = await assertClusterAllowed(conn);
  rec('cluster guard', g.cluster === 'localnet', `assertClusterAllowed -> ${g.cluster}`);

  const send = async (tx: any, signers: Keypair[]) => {
    if (Array.isArray((tx as any).signatures) && "version" in tx) tx.sign(signers); else tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize());
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error('tx failed ' + JSON.stringify(st.err));
    return sig;
  };

  // ---- seed a market: create_v2 + a creator dev buy so the curve has real reserves ----
  async function createCoin(): Promise<PublicKey> {
    const mint = Keypair.generate();
    const ix = await (PUMP_SDK as any).createV2Instruction({ mint: mint.publicKey, name: 'Localnet', symbol: 'LCL', uri: 'http://127.0.0.1/none', creator: creator.publicKey, user: creator.publicKey, mayhemMode: false });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = creator.publicKey;
    const sig = await send(tx, [creator, mint]);
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    lastCreate = { signature: sig, logs: t?.meta?.logMessages ?? [], mint: mint.publicKey };
    return mint.publicKey;
  }
  let lastCreate: { signature: string; logs: string[]; mint: PublicKey } | undefined;
  async function marketBuy(kp: Keypair, mint: PublicKey, sol: number) {
    const state = (await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' }))!;
    const q = PumpCurveService.calculateBuyQuote({ state, amountSol: sol, slippageBps: 2000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' } as any);
    const tx = await txBuilder.buildBuyTransaction(conn, {
      buyer: kp.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: PumpCurveService.getAssociatedTokenAddress(mint, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: BigInt(q.tokenAmountRaw),
      maxSolCostLamports: BigInt(q.maxInputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    } as any);
    tx.sign([kp]);
    const sig = await conn.sendRawTransaction(tx.serialize());
    const status = (await conn.getSignatureStatuses([sig])).value[0];
    if (status?.err) {
      const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      throw new Error(`seed buy failed ${JSON.stringify(status.err)}: keys=${JSON.stringify((t as any)?.transaction.message.staticAccountKeys?.map((k: any) => k.toBase58()) ?? (t as any)?.transaction.message.accountKeys?.map((k: any) => k.toBase58?.() ?? k))} ${(t?.meta?.logMessages || []).filter((l) => !l.startsWith('Program data')).slice(-8).join(' | ')}`);
    }
    return { tx, sig };
  }

  async function marketBuyTx(kp: Keypair, m: PublicKey, sol: number) {
    const state = (await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: m, executionMode: 'LIVE' }))!;
    const q = PumpCurveService.calculateBuyQuote({ state, amountSol: sol, slippageBps: 2000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' } as any);
    const tx = await txBuilder.buildBuyTransaction(conn, {
      buyer: kp.publicKey, mint: m, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: PumpCurveService.getAssociatedTokenAddress(m, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: BigInt(q.tokenAmountRaw),
      maxSolCostLamports: BigInt(q.maxInputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    } as any);
    tx.sign([kp]);
    return tx;
  }

  /** create_v2 + a small creator buy + 14 other buyers, so the app's own safety filters (creator share, top-10, liquidity) pass honestly. */
  async function seedCoin(): Promise<PublicKey> {
    const m = await createCoin();
    await marketBuy(creator, m, 0.2);
    for (let i = 0; i < 14; i++) {
      const w = Keypair.generate();
      await conn.requestAirdrop(w.publicKey, 2 * LAMPORTS_PER_SOL);
      await marketBuy(w, m, 0.6);
    }
    return m;
  }

  let mint: PublicKey;
  let mintD: PublicKey;
  let mintE: PublicKey;
  let mintF: PublicKey;
  try {
    mint = await createCoin();
    rec('seed: create_v2', true, `mint ${mint.toBase58()} created by the real pump program`);
    {
      // L5: the pump feed decoder must agree with the program's own account for a REAL create_v2 event log.
      const { PumpFeedListener } = await import('../../server/solana/pumpFeedListener');
      const l = new PumpFeedListener();
      const ev = l.parseLogs({ err: null, signature: lastCreate!.signature, logs: lastCreate!.logs } as any, { slot: 1 });
      l.destroy();
      const st = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' });
      const same = !!ev && !!st && ev.mint === mint.toBase58() && ev.creator === creator.publicKey.toBase58() &&
        ev.virtualTokenReserves === st.virtualTokenReserves && ev.virtualSolReserves === st.virtualSolReserves &&
        ev.realTokenReserves === st.realTokenReserves && ev.tokenTotalSupply === st.tokenTotalSupply;
      rec('pump feed decodes the real create_v2 log like the on-chain curve', same, ev ? `vTok ${ev.virtualTokenReserves} vSol ${ev.virtualSolReserves} real ${ev.realTokenReserves} vs chain ${st?.virtualTokenReserves}/${st?.virtualSolReserves}/${st?.realTokenReserves}` : 'parseLogs returned null');
      if (process.env.LOCALNET_DUMP_CREATE_LOG) {
        fs.writeFileSync(process.env.LOCALNET_DUMP_CREATE_LOG, JSON.stringify({ signature: lastCreate!.signature, mint: mint.toBase58(), creator: creator.publicKey.toBase58(), logs: lastCreate!.logs, chain: { virtualTokenReserves: String(st?.virtualTokenReserves), virtualSolReserves: String(st?.virtualSolReserves), realTokenReserves: String(st?.realTokenReserves), tokenTotalSupply: String(st?.tokenTotalSupply) } }, null, 1));
      }
    }
    await marketBuy(creator, mint, 0.2);
    for (let i = 0; i < 14; i++) {
      const w = Keypair.generate();
      await conn.requestAirdrop(w.publicKey, 2 * LAMPORTS_PER_SOL);
      await marketBuy(w, mint, 0.6);
    }
    const st = (await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' }))!;
    rec('seed: 15 buyers', st.realSolReserves > 0n && !st.complete, `real SOL reserves ${Number(st.realSolReserves) / 1e9}, virtual ${Number(st.virtualSolReserves) / 1e9}`);
    // The app has a per-mint cooldown, so each failure scenario gets its own coin.
    mintD = await seedCoin();
    mintE = await seedCoin();
    mintF = await seedCoin();
    rec('seed: 3 more coins (revert, failed-send, restart scenarios)', true, [mintD, mintE, mintF].map((m) => m.toBase58()).join(' '));
  } catch (e: any) {
    rec('seed market', false, String(e?.stack || e).slice(0, 600));
    return finish();
  }

  // ---- start the real app server against the validator ----
  const token = crypto.randomBytes(24).toString('hex');
  async function startServer(): Promise<{ base: string; proc: ChildProcess }> {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      NODE_ENV: 'production',
      APP_PORT: String(port),
      OPERATOR_AUTH_TOKEN: token,
      APEX_ENV_FILE: '',
      ALLOWED_CLUSTER: 'localnet',
      LOCALNET_GENESIS_HASH: info.genesisHash,
      SOLANA_RPC_URL: info.url,
      ENABLE_RPC_FALLBACK: 'true',
      APEX_DB_PATH: path.join(scratch, 'app.db'),
      SIGNER_KEYPAIR_PATH: keyPath,
      // Set only after the driver asserted (above) that the RPC reports the local validator's genesis hash.
      LOCALNET_SOL_PRICE_USD: '150', // labelled LOCALNET_FIXED in the price service; a local validator has no market
      ALLOW_LIVE_REAL_MONEY_TRADING: 'true',
    };
    const proc = startProc('server', ['--import', 'tsx', 'server.ts'], env);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 160; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return { base, proc }; } catch { /* booting */ }
      await sleep(250);
    }
    throw new Error('server did not boot: ' + logs.server.join('').slice(-1500));
  }
  const api = (base: string) => async (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null;
    try { j = await r.json(); } catch { /* none */ }
    return { status: r.status, body: j };
  };

  let { base, proc } = await startServer();
  let call = api(base);
  rec('server boot', true, `${base} (ALLOWED_CLUSTER=localnet, RPC ${info.url}, real .env not read)`);

  const health = await call('GET', '/api/health');
  rec('GET /api/health', health.status === 200, `status ${health.status}`);
  const unauth = await fetch(`${base}/api/execution/arm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  rec('auth required', unauth.status === 401, `POST /api/execution/arm without a token -> ${unauth.status}`);
  const signer = await call('GET', '/api/signer/status');
  rec('signer', signer.body?.pubkey === trader.publicKey.toBase58() || signer.body?.publicKey === trader.publicKey.toBase58(), JSON.stringify(signer.body).slice(0, 200));

  const ata = async (m: PublicKey = mint) => {
    const accts = await conn.getTokenAccountsByOwner(trader.publicKey, { mint: m });
    if (!accts.value.length) return null;
    return BigInt((await conn.getTokenAccountBalance(accts.value[0].pubkey)).value.amount);
  };
  const positions = async () => (await call('GET', '/api/workstation/positions')).body;

  // ---- arm LIVE ----
  const mode0 = await call('GET', '/api/execution/mode');
  rec('GET /api/execution/mode', mode0.status === 200, JSON.stringify(mode0.body));
  const syncRpc = await call('POST', '/api/wallet/sync-rpc', {});
  rec('POST /api/wallet/sync-rpc', syncRpc.status === 200, JSON.stringify(syncRpc.body).slice(0, 200));
  const can = await waitCanArm(call);
  rec('GET /api/execution/can-arm', can.status === 200 && can.body?.allowed === true, JSON.stringify({ allowed: can.body?.allowed, reasons: can.body?.reasons }).slice(0, 400));
  const arm = await call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
  rec('POST /api/execution/arm', arm.status === 200 && arm.body?.success, JSON.stringify(arm.body).slice(0, 300));
  if (!arm.body?.success) return finish();

  // ---- (a) BUY through the HTTP API ----
  const buy = await call('POST', '/api/execution/trade', { mint: mint.toBase58(), symbol: 'LCL', name: 'Localnet', amountSol: 0.02 });
  rec('(a) POST /api/execution/trade BUY', buy.status === 200 && buy.body?.success, JSON.stringify(buy.body).slice(0, 500));
  const chainBal = await ata();
  const pos1 = (await positions());
  const posList: any[] = Array.isArray(pos1) ? pos1 : pos1?.positions || [];
  const p = posList.find((x) => x.mint === mint.toBase58());
  rec('(a) db tokenQuantityRaw == ATA balance', !!p && chainBal !== null && BigInt(p.tokenQuantityRaw) === chainBal, `db=${p?.tokenQuantityRaw} chain=${chainBal}`);
  if (!p) return finish();

  const c50 = await call('POST', '/api/execution/close', { positionId: p.id, sellPct: 50, reason: 'localnet 50%' });
  rec('(b) POST /api/execution/close 50%', c50.status === 200 && c50.body?.success, JSON.stringify(c50.body).slice(0, 400));
  rec('(b) ATA after 50% sell', chainBal !== null && (await ata())! > 0n && (await ata())! < chainBal, `chain=${await ata()} (was ${chainBal})`);
  const balBefore100 = await conn.getBalance(trader.publicKey);
  const c100 = await call('POST', '/api/execution/close', { positionId: p.id, sellPct: 100, reason: 'localnet 100%' });
  rec('(c) POST /api/execution/close 100%', c100.status === 200 && c100.body?.success, JSON.stringify(c100.body).slice(0, 400));
  const after = await ata();
  const rentBack = (await conn.getBalance(trader.publicKey)) - balBefore100;
  rec('(c) ATA closed and rent reclaimed', after === null, `ATA ${after === null ? 'closed' : 'still open ' + after}; wallet delta ${rentBack / LAMPORTS_PER_SOL} SOL (includes sale proceeds)`);

  // ---- read endpoints and guards over HTTP ----
  for (const ep of ['/api/execution/readiness', '/api/wallet/state', '/api/memecoins/positions', '/api/workstation/positions', '/api/diagnostics/system']) {
    const r = await call('GET', ep);
    rec(`GET ${ep}`, r.status === 200 && r.body?.success !== false, `status ${r.status}`);
  }
  const curve = await call('GET', `/api/market/curve/${mint.toBase58()}`);
  rec('GET /api/market/curve/:mint (real reserves)', curve.status === 200 && curve.body?.success === true, JSON.stringify(curve.body).slice(0, 220));
  const mainnetCfg = await call('POST', '/api/wallet/config', { walletAddress: trader.publicKey.toBase58(), rpcEndpoint: 'https://api.mainnet-beta.solana.com', enabledStrategies: { pumpFunSniper: true }, riskLimits: {} });
  rec('K6: POST /api/wallet/config with a mainnet RPC is refused', mainnetCfg.status === 400 && /CLUSTER_GUARD/.test(JSON.stringify(mainnetCfg.body)), JSON.stringify(mainnetCfg.body).slice(0, 260));
  const connAfter = await call('GET', '/api/wallet/state');
  rec('K6: RPC endpoint unchanged after the refused switch', JSON.stringify(connAfter.body).includes('mainnet') === false, 'wallet state mentions no mainnet endpoint');

  // ---- (d) forced on-chain revert: a competing buy lands between the app's quote and its send ----
  const rivalFund = Keypair.generate();
  await conn.requestAirdrop(rivalFund.publicKey, 5 * LAMPORTS_PER_SOL);
  const rival = await marketBuyTx(rivalFund, mintD, 1.5);
  await rpcCall(info.url, 'localnet_frontrunNext', [Buffer.from(rival.serialize()).toString('base64')]);
  const posBefore = ((await positions()) as any);
  const revert = await call('POST', '/api/execution/trade', { mint: mintD.toBase58(), symbol: 'LCL', name: 'Localnet', amountSol: 0.02, slippageBps: 1 });
  const posAfterList: any[] = Array.isArray(await positions()) ? ((await positions()) as any) : ((await positions()) as any)?.positions || [];
  const openLcl = posAfterList.filter((x) => x.mint === mintD.toBase58() && (x.status === 'ACTIVE' || x.status === 'PARTIALLY_CLOSED'));
  rec('(d) forced revert: app reports failure, no phantom position', revert.body?.success === false && openLcl.length === 0, `${revert.status} ${JSON.stringify(revert.body).slice(0, 330)}; open positions on mint: ${openLcl.length}`);
  void posBefore;
  const ataAfterRevert = await ata(mintD);
  rec('(d) wallet holds no tokens after the revert', ataAfterRevert === null || ataAfterRevert === 0n, `ATA ${ataAfterRevert}`);

  // The app pauses all execution for 15 s after a failure (EXECUTION_DISABLED: cooling down); that is itself behaviour worth seeing.
  const cooling = await call('POST', '/api/execution/trade', { mint: mintE.toBase58(), symbol: 'LCL', name: 'Localnet', amountSol: 0.02 });
  rec('(d) failure cooldown blocks the next trade', cooling.body?.success === false && /Cooling down/.test(JSON.stringify(cooling.body)), JSON.stringify(cooling.body).slice(0, 200));
  await sleep(16_000);
  // ---- (e) transient send failure: the app must not double-buy ----
  await rpcCall(info.url, 'localnet_failNextSends', [1]);
  const flaky = await call('POST', '/api/execution/trade', { mint: mintE.toBase58(), symbol: 'LCL', name: 'Localnet', amountSol: 0.02 });
  const flakyList: any[] = (await positions()) as any;
  const flat = Array.isArray(flakyList) ? flakyList : (flakyList as any)?.positions || [];
  const openFlaky = flat.filter((x: any) => x.mint === mintE.toBase58() && (x.status === 'ACTIVE' || x.status === 'PARTIALLY_CLOSED'));
  const chainFlaky = await ata(mintE);
  rec('(e) one failed send: at most one position, db qty == chain qty', openFlaky.length <= 1 && (openFlaky.length === 0 ? (chainFlaky ?? 0n) === 0n : BigInt(openFlaky[0].tokenQuantityRaw) === chainFlaky), `trade -> ${flaky.status} ${JSON.stringify(flaky.body).slice(0, 220)}; positions ${openFlaky.length}; chain ${chainFlaky}`);

  await sleep(16_000);
  // ---- (f) kill the app right after a buy lands on-chain, restart it on the same database ----
  await rpcCall(info.url, 'localnet_holdNextResponse', []);
  const inFlight = fetch(`${base}/api/execution/trade`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ mint: mintF.toBase58(), symbol: 'LCL', name: 'Localnet', amountSol: 0.02 }) }).catch(() => null);
  let held: string[] = [];
  for (let i = 0; i < 60 && !held.length; i++) {
    await sleep(250);
    held = (await rpcCall(info.url, 'localnet_stats', [])).held;
  }
  rec('(f) buy landed on-chain with its response withheld', held.length === 1, `signature ${held[0] ?? 'none'}`);
  proc.kill('SIGKILL');
  await inFlight;
  await sleep(500);
  const chainAfterKill = await ata(mintF);
  ({ base, proc } = await startServer());
  call = api(base);
  const canAgain = await waitCanArm(call);
  rec('can-arm after restart', canAgain.body?.allowed === true, JSON.stringify({ allowed: canAgain.body?.allowed, reasons: canAgain.body?.reasons }).slice(0, 300));
  const armAgain = await call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
  const recon = await call('POST', '/api/execution/reconcile', {});
  // orphan recovery runs in the background after startup; give it a moment, then ask for the book
  let recovered: any = null;
  for (let i = 0; i < 40 && !recovered; i++) {
    const list: any = await positions();
    const arr = Array.isArray(list) ? list : list?.positions || [];
    recovered = arr.find((x: any) => x.mint === mintF.toBase58() && x.status !== 'CLOSED' && BigInt(x.tokenQuantityRaw) > 0n) ?? null;
    if (!recovered) await sleep(500);
  }
  rec('(f) restart: position recovered from the chain', !!recovered && chainAfterKill !== null && BigInt(recovered.tokenQuantityRaw) === chainAfterKill, `reconcile ${recon.status} ${JSON.stringify(recon.body).slice(0, 160)}; db=${recovered?.tokenQuantityRaw} chain=${chainAfterKill}; re-arm ${armAgain.status} ${JSON.stringify(armAgain.body).slice(0, 900)}`);
  if (recovered) {
    const closeRecovered = await call('POST', '/api/execution/close', { positionId: recovered.id, sellPct: 100, reason: 'localnet recovered position' });
    rec('(f) recovered position can be sold', closeRecovered.status === 200 && closeRecovered.body?.success, JSON.stringify(closeRecovered.body).slice(0, 260));
  }

  // ---- kill switch over HTTP ----
  const ks = await call('POST', '/api/execution/kill-switch', { activate: true });
  const blocked = await call('POST', '/api/execution/trade', { mint: mintE.toBase58(), symbol: 'LCL', name: 'Localnet', amountSol: 0.02 });
  rec('kill switch blocks new buys', ks.status === 200 && blocked.body?.success === false, `${blocked.status} ${JSON.stringify(blocked.body).slice(0, 200)}`);
  await call('POST', '/api/execution/kill-switch', { activate: false });

  const stats = await rpcCall(info.url, 'localnet_stats', []);
  rec('RPC surface: no unsupported method was called', stats.unsupported.length === 0, `calls: ${JSON.stringify(stats.methods)}; unsupported: ${JSON.stringify(stats.unsupported)}`);

  return finish();

  function finish() {
    return null;
  }
}

async function cleanup() {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* gone */ }
  }
  await sleep(500);
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
}

main()
  .catch((e) => rec('harness error', false, String(e?.stack || e).slice(0, 800)))
  .finally(async () => {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} steps passed (scratch ${scratch})`);
    if (bad.length || process.env.LOCALNET_VERBOSE) {
      for (const [name, l] of Object.entries(logs)) console.log(`\n--- ${name} output (tail) ---\n${l.join('').split('\n').slice(-40).join('\n')}`);
    }
    fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2));
    await cleanup();
    process.exit(bad.length ? 1 : 0);
  });
