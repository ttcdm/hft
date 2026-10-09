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
  c.stdout!.on('data', (d) => logs[name].push(String(d)));
  c.stderr!.on('data', (d) => logs[name].push(String(d)));
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
    await send(tx, [creator, mint]);
    return mint.publicKey;
  }
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

  let mint: PublicKey;
  try {
    mint = await createCoin();
    rec('seed: create_v2', true, `mint ${mint.toBase58()} created by the real pump program`);
    await marketBuy(creator, mint, 0.2);
    // A realistic distribution so the app's own safety filters (creator share, top-10 share, liquidity) have something to judge.
    for (let i = 0; i < 14; i++) {
      const w = Keypair.generate();
      await conn.requestAirdrop(w.publicKey, 2 * LAMPORTS_PER_SOL);
      await marketBuy(w, mint, 0.6);
    }
    const st = (await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' }))!;
    rec('seed: 15 buyers', st.realSolReserves > 0n && !st.complete, `real SOL reserves ${Number(st.realSolReserves) / 1e9}, virtual ${Number(st.virtualSolReserves) / 1e9}`);
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

  const ata = async () => {
    const accts = await conn.getTokenAccountsByOwner(trader.publicKey, { mint });
    if (!accts.value.length) return null;
    return BigInt((await conn.getTokenAccountBalance(accts.value[0].pubkey)).value.amount);
  };
  const positions = async () => (await call('GET', '/api/workstation/positions')).body;

  // ---- arm LIVE ----
  const mode0 = await call('GET', '/api/execution/mode');
  rec('GET /api/execution/mode', mode0.status === 200, JSON.stringify(mode0.body));
  const syncRpc = await call('POST', '/api/wallet/sync-rpc', {});
  rec('POST /api/wallet/sync-rpc', syncRpc.status === 200, JSON.stringify(syncRpc.body).slice(0, 200));
  const can = await call('GET', '/api/execution/can-arm');
  rec('GET /api/execution/can-arm', can.status === 200, JSON.stringify({ allowed: can.body?.allowed, reasons: can.body?.reasons }).slice(0, 400));
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
