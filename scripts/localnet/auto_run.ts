/**
 * Localnet auto-trading run: the app (server.ts) in DEVNET_LIVE auto mode against the LiteSVM validator, fed by a SIMULATED market.
 *
 *   npm run localnet:auto            (RUN_SECONDS=300 by default; KEEP_UP=1 leaves the server running for a browser)
 *
 * What it can tell you: whether the auto path (feed -> watch window -> confluence -> buy -> exit) trades end to end on a real
 * chain flow, what each decision was, and what the round trips cost. What it cannot: whether auto makes money on a real market.
 * The price path is whatever this script's coin scripts make it, so the profit figure is a property of the simulation.
 * Nothing leaves loopback; all keys are throwaway.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';

const ROOT = process.cwd();
const scratch = process.env.AUTO_RUN_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'apex-auto-'));
fs.mkdirSync(scratch, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 300);
const children: ChildProcess[] = [];
const logs: Record<string, string[]> = {};
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (m: string) => console.log(`${stamp()}  ${m}`);

const freePort = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
async function freePortPair(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    try { await new Promise<void>((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(p + 1, '127.0.0.1', () => s.close(() => res())); }); return p; } catch { /* again */ }
  }
  throw new Error('no adjacent free ports');
}
function startProc(name: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const c = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  logs[name] = [];
  const f = path.join(scratch, `${name}.log`);
  c.stdout!.on('data', (d) => { logs[name].push(String(d)); fs.appendFileSync(f, d); });
  c.stderr!.on('data', (d) => { logs[name].push(String(d)); fs.appendFileSync(f, d); });
  children.push(c);
  return c;
}
const rpcCall = async (url: string, method: string, params: unknown[] = []) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

type CoinKind = 'runner' | 'fader' | 'thin' | 'rug' | 'flat' | 'sybil';
const SCRIPT: CoinKind[] = ['runner', 'thin', 'sybil', 'fader', 'rug', 'flat'];

async function main() {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const vPort = await freePortPair();
  const validator = startProc('validator', ['--import', 'tsx', 'scripts/localnet/run_validator.ts', String(vPort)], baseEnv);
  const info: { url: string; genesisHash: string } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('validator did not start')), 30_000);
    validator.stdout!.on('data', (d) => { const line = String(d).split('\n').find((l) => l.startsWith('{')); if (line) { clearTimeout(t); resolve(JSON.parse(line)); } });
  });
  const conn = new Connection(info.url, 'confirmed');
  const trader = Keypair.generate();
  const keyPath = path.join(scratch, 'throwaway-keypair.json');
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(trader.secretKey)), { mode: 0o600 });
  await conn.requestAirdrop(trader.publicKey, 5 * LAMPORTS_PER_SOL);

  process.env.ALLOWED_CLUSTER = 'localnet'; process.env.LOCALNET_GENESIS_HASH = info.genesisHash; process.env.APEX_ENV_FILE = '';
  process.env.SOLANA_RPC_URL = info.url; process.env.APEX_DB_PATH = path.join(scratch, 'driver.db'); process.env.APEX_WAL_PATH = path.join(scratch, 'engine.wal');
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { PumpCurveService } = await import('../../server/solana/pumpCurve');
  const { txBuilder } = await import('../../server/solana/transactionBuilder');

  const send = async (tx: any, signers: Keypair[]) => {
    if ('version' in tx) tx.sign(signers); else tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize());
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error('tx failed ' + JSON.stringify(st.err));
    return sig;
  };
  const createCoin = async (creator: Keypair): Promise<PublicKey> => {
    const mint = Keypair.generate();
    const ix = await (PUMP_SDK as any).createV2Instruction({ mint: mint.publicKey, name: 'Sim', symbol: 'SIM', uri: 'http://127.0.0.1/none', creator: creator.publicKey, user: creator.publicKey, mayhemMode: false });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.feePayer = creator.publicKey;
    await send(tx, [creator, mint]);
    return mint.publicKey;
  };
  const buy = async (kp: Keypair, mint: PublicKey, sol: number) => {
    const state = (await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' }))!;
    const q = PumpCurveService.calculateBuyQuote({ state, amountSol: sol, slippageBps: 3000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' } as any);
    const tx = await txBuilder.buildBuyTransaction(conn, {
      buyer: kp.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: PumpCurveService.getAssociatedTokenAddress(mint, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: BigInt(q.tokenAmountRaw),
      maxSolCostLamports: BigInt(q.maxInputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    } as any);
    return send(tx, [kp]);
  };
  const tokenBalance = async (kp: Keypair, mint: PublicKey): Promise<bigint> => {
    const a = await conn.getTokenAccountsByOwner(kp.publicKey, { mint });
    return a.value.length ? BigInt((await conn.getTokenAccountBalance(a.value[0].pubkey)).value.amount) : 0n;
  };
  const sell = async (kp: Keypair, mint: PublicKey, fraction = 1) => {
    const bal = await tokenBalance(kp, mint);
    const amount = BigInt(Math.floor(Number(bal) * fraction));
    if (amount <= 0n) return null;
    const state = (await PumpCurveService.fetchPumpMarketState({ connection: conn, mint, executionMode: 'LIVE' }))!;
    const q = PumpCurveService.calculateSellQuote({ state, tokenAmountRaw: amount, slippageBps: 5000, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' } as any);
    const tx = await txBuilder.buildSellTransaction(conn, {
      seller: kp.publicKey, mint, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: PumpCurveService.getAssociatedTokenAddress(mint, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: amount,
      minSolOutputLamports: BigInt(q.minOutputLamports), computeUnits: 300_000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n,
    } as any);
    return send(tx, [kp]);
  };
  const fresh = async (sol: number) => { const kp = Keypair.generate(); await conn.requestAirdrop(kp.publicKey, Math.ceil(sol * LAMPORTS_PER_SOL)); return kp; };

  // ---- the app ----
  const token = crypto.randomBytes(24).toString('hex');
  const port = await freePort();
  const server = startProc('server', ['--import', 'tsx', 'server.ts'], {
    ...baseEnv, NODE_ENV: 'production', APP_PORT: String(port), OPERATOR_AUTH_TOKEN: token, OPERATOR_PASSWORD: 'localnet-auto-run', APEX_ENV_FILE: '',
    ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: info.genesisHash, SOLANA_RPC_URL: info.url, SOLANA_WS_URL: info.url.replace('http', 'ws').replace(/:(\d+)/, (_m, p) => `:${Number(p) + 1}`),
    ENABLE_RPC_FALLBACK: 'true', APEX_DB_PATH: path.join(scratch, 'app.db'), SIGNER_KEYPAIR_PATH: keyPath, APEX_WAL_PATH: path.join(scratch, 'app.wal'),
    LOCALNET_SOL_PRICE_USD: '150', ALLOW_LIVE_REAL_MONEY_TRADING: 'true', AUTO_SNIPE_ENABLED: 'true',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ } await sleep(250); }
  const call = async (method: 'GET' | 'POST', p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* none */ }
    return { status: r.status, body: j };
  };
  for (let i = 0; i < 120; i++) { const c = await call('GET', '/api/execution/can-arm'); if (c.body?.allowed) break; await sleep(500); }
  const arm = await call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
  say(`arm: ${arm.status} ${JSON.stringify(arm.body).slice(0, 100)}`);
  const mode = await call('POST', '/api/auto/mode', { mode: 'DEVNET_LIVE', confirmationCode: 'CONFIRM_AUTO_DEVNET' });
  say(`auto mode: ${mode.status} ${JSON.stringify(mode.body).slice(0, 160)}`);
  const walletStart = await conn.getBalance(trader.publicKey);

  // ---- the simulated market ----
  const stats = { coins: [] as Array<{ kind: CoinKind; mint: string; buyers: number; errors: number }> };
  const runCoin = async (kind: CoinKind) => {
    const rec = { kind, mint: '', buyers: 0, errors: 0 };
    stats.coins.push(rec);
    try {
      const creator = await fresh(25);
      const mint = await createCoin(creator);
      rec.mint = mint.toBase58();
      say(`coin ${kind} ${rec.mint.slice(0, 6)} created`);
      await buy(creator, mint, 0.2);
      const wallets: Keypair[] = [];
      const doBuy = async (sol: number) => { try { const w = await fresh(sol + 0.05); await buy(w, mint, sol); wallets.push(w); rec.buyers++; } catch (e: any) { rec.errors++; if (rec.errors < 3) say(`  ${kind} buy error ${String(e.message).slice(0, 120)}`); } };
      if (kind === 'sybil') { // 38 'distinct' buyers that one funder wallet paid for: the watch window should merge them into one cluster
        const funder = await fresh(50);
        for (let i = 0; i < 60; i++) {
          const w = Keypair.generate();
          const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: w.publicKey, lamports: Math.round(0.6 * LAMPORTS_PER_SOL) }));
          t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; t.feePayer = funder.publicKey;
          try { await send(t, [funder]); await buy(w, mint, rnd(0.12, 0.4)); wallets.push(w); rec.buyers++; } catch (e: any) { rec.errors++; }
          await sleep(rnd(300, 800));
        }
        return;
      }
      if (kind === 'flat') { for (let i = 0; i < 6; i++) { await doBuy(rnd(0.05, 0.15)); await sleep(rnd(2000, 5000)); } return; }
      if (kind === 'rug') { for (let i = 0; i < 14; i++) { await doBuy(rnd(0.4, 0.9)); await sleep(rnd(500, 1200)); } await sell(creator, mint, 1).catch(() => undefined); say(`  rug: creator sold ${rec.mint.slice(0, 6)}`); return; }
      // runner / fader: ~260 distinct small buyers (no whale, all buys) arriving eight at a time, which is the broadest crowd the score
      // can ask for. 'thin' is the same shape with half the crowd and bigger tickets, so it shows what the gate refuses.
      const crowd = async (n: number, lo: number, hi: number, pauseLo: number, pauseHi: number) => {
        for (let i = 0; i < n; i += 8) { await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(() => doBuy(rnd(lo, hi)))); await sleep(rnd(pauseLo, pauseHi)); }
      };
      if (kind === 'thin') { await crowd(60, 0.3, 0.7, 300, 800); await sleep(3000); return; }
      await crowd(260, 0.10, 0.16, 50, 250);
      if (kind === 'runner') {
        await crowd(80, 0.1, 0.3, 1500, 2500); // momentum keeps coming
        for (let i = 0; i < wallets.length; i += 3) { await sell(wallets[i], mint, 1).catch(() => undefined); await sleep(1000); } // then early holders take profit
      } else {
        await sleep(5000);
        for (const w of wallets) { await sell(w, mint, 1).catch(() => undefined); await sleep(rnd(300, 800)); } // the crowd leaves
      }
    } catch (e: any) { rec.errors++; say(`coin ${kind} failed: ${String(e.message).slice(0, 160)}`); }
  };
  const coinTasks: Promise<void>[] = [];
  const t0 = Date.now();
  let idx = 0;
  const launcher = setInterval(() => { if (idx < SCRIPT.length) coinTasks.push(runCoin(SCRIPT[idx++])); }, 12_000);
  coinTasks.push(runCoin(SCRIPT[idx++]));

  // ---- watch it ----
  let lastN = 0;
  while ((Date.now() - t0) / 1000 < RUN_SECONDS) {
    await sleep(10_000);
    const st = await call('GET', '/api/auto/status');
    const board = await call('GET', '/api/board');
    const pos = await call('GET', '/api/workstation/positions');
    const decisions: any[] = st.body?.decisions ?? [];
    const open = (pos.body?.positions ?? []).filter((p: any) => p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED').length;
    say(`auto=${st.body?.mode}${st.body?.killed ? ' KILLED' : ''}${st.body?.downgradeReason ? ' downgraded:' + st.body.downgradeReason : ''} watching=${board.body?.watching?.length ?? '?'} (${(board.body?.watching ?? []).map((w: any) => w.state[0]).join('')}) decisions=${decisions.length} open=${open} session=${JSON.stringify(st.body?.session ? { buys: st.body.session.buys, spent: +st.body.session.spentSol.toFixed(4), pnl: st.body.session.sessionPnlSol } : null)}`);
    for (const d of decisions.slice(lastN)) say(`  decision ${d.outcome} ${String(d.mint).slice(0, 6)} ${d.reason ?? ''}`.slice(0, 520));
    lastN = decisions.length;
  }
  clearInterval(launcher);
  say('run time over; letting running coins finish, then closing what auto still holds');
  await Promise.race([Promise.allSettled(coinTasks), sleep(60_000)]);
  await sleep(5000);

  const st = await call('GET', '/api/auto/status');
  const posAll = (await call('GET', '/api/workstation/positions')).body?.positions ?? [];
  const stillOpen = posAll.filter((p: any) => p.status === 'OPEN' || p.status === 'PARTIALLY_CLOSED');
  for (const p of stillOpen) { const r = await call('POST', '/api/execution/close', { positionId: p.id, sellPct: 100, reason: 'auto_run end' }); say(`  closed leftover ${p.symbol} ${p.id.slice(0, 6)}: ${JSON.stringify(r.body).slice(0, 120)}`); }
  await sleep(3000);
  const final = (await call('GET', '/api/workstation/positions')).body?.positions ?? [];
  const walletEnd = await conn.getBalance(trader.publicKey);
  const decisions: any[] = (await call('GET', '/api/auto/status')).body?.decisions ?? [];
  const byOutcome: Record<string, number> = {}; for (const d of decisions) byOutcome[`${d.outcome}${d.reason ? ':' + String(d.reason).slice(0, 40) : ''}`] = (byOutcome[`${d.outcome}${d.reason ? ':' + String(d.reason).slice(0, 40) : ''}`] ?? 0) + 1;
  // where the money went: the wallet's own balance change in each of the position's transactions (fee payer is account 0)
  const txCost = async (sig?: string) => {
    if (!sig) return null;
    try { const t: any = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }); return t ? { walletDeltaSol: (t.meta.postBalances[0] - t.meta.preBalances[0]) / 1e9, feeSol: t.meta.fee / 1e9 } : null; } catch { return null; }
  };
  const legs: any[] = [];
  for (const p of final) legs.push({ mint: p.mint.slice(0, 6), entry: await txCost(p.entryTxSignature), exit: await txCost(p.exitTxSignature) });
  const realized = final.reduce((a: number, p: any) => a + (p.realizedPnLSol ?? 0), 0);
  const summary = {
    label: 'SIMULATED MARKET ON LOCALNET: the price path is this script, not a market',
    runSeconds: RUN_SECONDS, coins: stats.coins, decisionsByOutcome: byOutcome,
    legs,
    positions: final.map((p: any) => ({ symbol: p.symbol, mint: p.mint.slice(0, 6), status: p.status, costSol: p.costBasisLamports / 1e9, entry: p.entryPriceSol, realizedPnLSol: p.realizedPnLSol, exitReason: p.exitReason })),
    realizedPnLSolSum: realized, walletSolStart: walletStart / 1e9, walletSolEnd: walletEnd / 1e9, walletDeltaSol: (walletEnd - walletStart) / 1e9,
    autoStatus: { mode: st.body?.mode, killed: st.body?.killed, downgradeReason: st.body?.downgradeReason, session: st.body?.session },
  };
  fs.writeFileSync(path.join(scratch, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n' + JSON.stringify(summary, null, 2));
  say(`scratch: ${scratch}`);
  if (process.env.KEEP_UP) { say(`server left running at ${base} (operator password: localnet-auto-run). Ctrl-C to stop.`); await new Promise(() => undefined); }
}

main().catch((e) => { console.error('harness error', e?.stack || e); for (const [n, l] of Object.entries(logs)) console.error(`--- ${n} tail ---\n${l.join('').split('\n').slice(-25).join('\n')}`); process.exitCode = 1; })
  .finally(async () => { for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } } await sleep(500); for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } process.exit(process.exitCode ?? 0); });
