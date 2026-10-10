/**
 * Devnet-only end-to-end harness for the live execution path (R2).
 *
 *   npm run devnet:e2e            # runs under scripts/devnet_guard.cjs
 *
 * Safety: devnet only, throwaway keypair generated here, scratch DB, Jito pointed at a dead local port so the
 * RPC fallback is exercised. ALLOW_LIVE_REAL_MONEY_TRADING is set true in-process ONLY after the cluster's genesis hash
 * equals the devnet hash. It never reads .env, the repo keypair, or any real RPC URL.
 */
import './hermeticEnv'; // no .env is ever loaded by this script
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEFAULT_MINTS = [
  'B3Wt5hoP1jb5a6LVKmjuaBVBvwcjBwuWCfskQayLxJDz',
  '7f5XHtKyoEgtQd2PRhJeFVzag1tHCN3FtwUUv8uiGV62',
  'B1iVXZeMDYFzrYHXYwPh17n8cEkEM4bB4Mdd77N2osnp',
  'FxS38bTrPuaJxUCTrNEb6YpubJyKibfdUj7ScRjYkQkH',
];

const phase = process.argv.includes('--phase=crash') ? 'crash' : process.argv.includes('--phase=recover') ? 'recover' : 'main';
const scratch = process.env.APEX_E2E_SCRATCH || fs.mkdtempSync(path.join(os.tmpdir(), 'apex-e2e-'));
const keyPath = path.join(scratch, 'throwaway-keypair.json');

// ---- sanitized environment: must be set before any server module is imported ----
process.env.SOLANA_RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
process.env.JITO_BLOCK_ENGINE_URL = 'http://127.0.0.1:9';
process.env.ENABLE_RPC_FALLBACK = 'true';
process.env.JITO_MAX_RETRIES = '1';
process.env.JITO_RETRY_INTERVAL_MS = '200';
process.env.APEX_DB_PATH = path.join(scratch, 'e2e.db');
process.env.SIGNER_KEYPAIR_PATH = keyPath;
process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'false';
delete process.env.ALLOWED_CLUSTER;
delete process.env.OPERATOR_PRIVATE_KEY;
delete process.env.SOLANA_PRIVATE_KEY;

if (/mainnet|jito\.wtf/i.test(process.env.SOLANA_RPC_URL)) {
  console.error('refusing: RPC URL looks like mainnet');
  process.exit(2);
}

const results: { step: string; ok: boolean; detail: string }[] = [];
const rec = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
};
const solscan = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const web3 = await import('@solana/web3.js');
  const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } = web3;

  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
  console.log(`throwaway address: ${kp.publicKey.toBase58()}  (scratch: ${scratch})`);

  const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    console.error(`ABORT: genesis ${genesis} is not devnet`);
    process.exit(2);
  }
  rec('cluster', true, `genesis hash == devnet (${genesis})`);
  // The only place the real-money flag is flipped, and only after the assertion above.
  process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';

  // Faucet policy: never loop and never request repeatedly. By default no airdrop at all; the wallet uses what it has.
  // DEVNET_AIRDROP_ONCE=1 sends exactly one 1 SOL request (no retry) for a brand-new throwaway wallet.
  let bal = await conn.getBalance(kp.publicKey);
  if (bal === 0 && process.env.DEVNET_AIRDROP_ONCE === '1') {
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, 'confirmed');
    } catch (e: any) {
      console.log(`single airdrop request failed (not retried): ${String(e.message).slice(0, 120)}`);
    }
    bal = await conn.getBalance(kp.publicKey);
  }
  // Sizes scale down to the balance: the 10% spendable ceiling means a buy of about 8% of the balance.
  const balSol = bal / LAMPORTS_PER_SOL;
  const BUY_SOL = Math.min(0.01, Number((balSol * 0.08).toFixed(5)));
  const funded = balSol >= 0.03;
  rec('funding', funded, `${balSol} SOL at ${kp.publicKey.toBase58()}; buy size ${BUY_SOL} SOL${funded ? '' : ' (too low to trade: fund this devnet address and re-run; only the simulate stage runs)'}`);

  const { PumpCurveService } = await import('../server/solana/pumpCurve');
  const { txBuilder } = await import('../server/solana/transactionBuilder');
  const { executionConfig } = await import('../server/solana/executionConfig');

  // ---- pick a live pump mint ----
  const mints = (process.env.DEVNET_MINTS ? process.env.DEVNET_MINTS.split(',') : DEFAULT_MINTS).map((s) => s.trim());
  let mint: string | null = null;
  let state: any = null;
  for (const m of mints) {
    try {
      const s = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: new PublicKey(m), executionMode: 'LIVE' });
      if (s && !s.complete) {
        mint = m;
        state = s;
        break;
      }
    } catch (e: any) {
      console.log(`mint ${m} unusable: ${String(e.message).slice(0, 100)}`);
    }
  }
  if (!mint) {
    rec('mint', false, 'no usable active pump.fun devnet mint; pass DEVNET_MINTS=<comma list> (they go stale fast)');
    return finish();
  }
  rec('mint', true, mint);
  const mintPk = new PublicKey(mint);

  if (phase === 'main') {
    // ---- stage 1: simulate (sigVerify false, replaceRecentBlockhash true) ----
    try {
      const quote = PumpCurveService.calculateBuyQuote({
        state, solAmountSol: BUY_SOL, slippageBps: 800, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE',
      } as any);
      const ata = PumpCurveService.getAssociatedTokenAddress(mintPk, kp.publicKey, state.tokenProgram);
      const buyTx = await txBuilder.buildBuyTransaction(conn, {
        buyer: kp.publicKey, mint: mintPk, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
        associatedUser: ata, creator: state.creator, feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient,
        quoteMint: state.quoteMint, tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram,
        amountTokens: BigInt(quote.tokenAmountRaw), maxSolCostLamports: BigInt(quote.maxInputLamports),
        computeUnits: 250000, priorityFeeMicroLamports: executionConfig.getConfig().priorityFeeMicrolamports,
        jitoTipLamports: 0n, jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
      } as any);
      const sim = await conn.simulateTransaction(buyTx as any, { sigVerify: false, replaceRecentBlockhash: true });
      rec('simulate BUY', !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) + ' ' + (sim.value.logs || []).slice(-3).join(' | ') : `ok, ${sim.value.unitsConsumed} CU`);
    } catch (e: any) {
      rec('simulate BUY', false, String(e.message).slice(0, 300));
    }
  }
  if (!funded) return finish();

  const { ExecutionCoordinator } = await import('../server/execution/coordinator');
  const { workstationDb } = await import('../server/db/database');
  const { localSigner } = await import('../server/solana/signer');
  const coordinator = new ExecutionCoordinator(true);
  if (phase === 'crash') {
    // Kill the process the instant the RPC returns a signature, before confirmation is recorded.
    const orig = Connection.prototype.sendRawTransaction;
    Connection.prototype.sendRawTransaction = async function (...a: any[]) {
      const sig = await (orig as any).apply(this, a);
      console.log(`CRASH_AFTER_SUBMIT ${sig}`);
      process.exit(137);
    } as any;
  }
  await sleep(4000); // let the constructor's background connection/reconciliation settle
  await coordinator.syncRealWalletBalance();
  const armed = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
  rec('arm LIVE (devnet)', armed.success, armed.message);
  if (!armed.success) return finish();

  const ataBalance = async () => {
    const accts = await conn.getTokenAccountsByOwner(kp.publicKey, { mint: mintPk });
    if (!accts.value.length) return 0n;
    const b = await conn.getTokenAccountBalance(accts.value[0].pubkey);
    return BigInt(b.value.amount);
  };
  const verify = async (label: string, sig?: string) => {
    if (!sig) return rec(`${label} getTransaction`, false, 'no signature');
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    rec(`${label} getTransaction`, !!t && !t.meta?.err, `${solscan(sig)}${t?.meta?.err ? ' err=' + JSON.stringify(t.meta.err) : ''}`);
  };

  if (phase === 'recover') {
    const r = await coordinator.startupReconciliation();
    rec('(f) startupReconciliation after kill', r.status !== 'OFFLINE', `${r.status}: ${r.details}`);
    const open = workstationDb.loadPositions().filter((p) => p.mint === mint);
    rec('(f) position recovered', open.length > 0, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status, qty: p.tokenQuantityRaw }))));
    return finish();
  }
  if (phase === 'crash') {
    await coordinator.executeTrade({
      mint, symbol: 'E2E', name: 'E2E', amountSol: BUY_SOL, source: 'MANUAL', provenance: 'MANUAL_OPERATOR', executionMode: 'LIVE',
    } as any);
    rec('crash phase', false, 'process should have been killed after submit');
    return finish();
  }

  // (a) BUY via Jito failure -> RPC fallback
  const buy = await coordinator.executeTrade({
    mint, symbol: 'E2E', name: 'E2E', amountSol: BUY_SOL, source: 'MANUAL', provenance: 'MANUAL_OPERATOR', executionMode: 'LIVE',
  } as any);
  rec('(a) BUY', buy.success && buy.lifecycleState === 'CONFIRMED', `${buy.lifecycleState} ${buy.error || ''}`);
  await verify('(a)', buy.txSignature || buy.signature);
  const txRows = workstationDb.loadTransactions();
  rec('(a) fell back to RPC', txRows.some((t) => t.direction === 'BUY' && t.submissionTransport === 'SOLANA_RPC'), txRows.map((t) => `${t.direction}:${t.submissionTransport}`).join(','));
  const pos = workstationDb.loadPositions().find((p) => p.mint === mint);
  const onchain = await ataBalance();
  rec('(a) tokenQuantityRaw == ATA balance', !!pos && BigInt(pos.tokenQuantityRaw as any) === onchain, `db=${pos?.tokenQuantityRaw} chain=${onchain}`);
  if (!pos) return finish();

  // (b) 50% close, (c) 100% close
  const c50 = await coordinator.closePosition(pos.id, 50, 'e2e 50%');
  rec('(b) close 50%', c50.success, c50.error || `pnl=${c50.pnlSol}`);
  rec('(b) ATA after 50%', true, `chain=${await ataBalance()}`);
  const c100 = await coordinator.closePosition(pos.id, 100, 'e2e 100%');
  rec('(c) close 100%', c100.success, c100.error || `pnl=${c100.pnlSol}`);
  const after = await conn.getBalance(kp.publicKey);
  rec('(c) ATA closed, rent returned', (await conn.getTokenAccountsByOwner(kp.publicKey, { mint: mintPk })).value.length === 0, `balance ${after / LAMPORTS_PER_SOL} SOL (expect ~0.00203928 rent back)`);
  for (const t of workstationDb.loadTransactions().filter((x) => x.direction === 'SELL')) await verify('(b/c) SELL', t.signature);

  // (d) forced revert: max cost of 1 lamport cannot be satisfied
  try {
    const ata = PumpCurveService.getAssociatedTokenAddress(mintPk, kp.publicKey, state.tokenProgram);
    const q = PumpCurveService.calculateBuyQuote({ state, solAmountSol: BUY_SOL, slippageBps: 800, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE' } as any);
    const bad = await txBuilder.buildBuyTransaction(conn, {
      buyer: kp.publicKey, mint: mintPk, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: ata, creator: state.creator, feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient,
      quoteMint: state.quoteMint, tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram,
      amountTokens: BigInt(q.tokenAmountRaw), maxSolCostLamports: 1n, computeUnits: 250000, priorityFeeMicroLamports: 1000,
      jitoTipLamports: 0n, jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
    } as any);
    await localSigner.signTransaction(bad);
    const sig = await conn.sendRawTransaction(bad.serialize(), { skipPreflight: true });
    const st = await conn.confirmTransaction(sig, 'confirmed');
    rec('(d) forced revert', !!st.value.err, `${solscan(sig)} err=${JSON.stringify(st.value.err)}`);
  } catch (e: any) {
    rec('(d) forced revert', false, String(e.message).slice(0, 200));
  }

  // (e) same orderId is not resubmitted
  const prior = workstationDb.loadTransactions().find((t) => t.direction === 'BUY');
  if (prior) {
    const dupTx = await txBuilder.buildBuyTransaction(conn, {
      buyer: kp.publicKey, mint: mintPk, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
      associatedUser: PumpCurveService.getAssociatedTokenAddress(mintPk, kp.publicKey, state.tokenProgram), creator: state.creator,
      feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient, quoteMint: state.quoteMint,
      tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram, amountTokens: 1n, maxSolCostLamports: 1000n,
      computeUnits: 250000, priorityFeeMicroLamports: 1000, jitoTipLamports: 0n, jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
    } as any);
    await localSigner.signTransaction(dupTx);
    const before = workstationDb.loadTransactions(prior.orderId).length;
    const r = await coordinator.submitAndConfirmWithRetry({
      tx: dupTx, orderId: prior.orderId, correlationId: 'e2e-dup', side: 'BUY', mint, mintPubkey: mintPk, owner: kp.publicKey,
      tokenProgram: state.tokenProgram, preSnapshot: {} as any, jitoTipLamports: 0,
    });
    rec('(e) same orderId skipped', workstationDb.loadTransactions(prior.orderId).length === before, `rows ${before} -> ${workstationDb.loadTransactions(prior.orderId).length}, result=${r.lifecycleState}`);
  } else {
    rec('(e) same orderId skipped', false, 'no prior BUY row');
  }

  // (f) crash after submit, then recover in a fresh process on the same scratch DB
  const env = { ...process.env, APEX_E2E_SCRATCH: scratch };
  const self = process.argv[1];
  const run = (p: string) => spawnSync(process.execPath, ['--require', path.resolve('scripts/devnet_guard.cjs'), '--import', 'tsx', self, `--phase=${p}`], { env, encoding: 'utf8', timeout: 120_000 });
  const crash = run('crash');
  const crashed = /CRASH_AFTER_SUBMIT (\S+)/.exec(crash.stdout || '');
  rec('(f) process killed after submit', !!crashed, crashed ? solscan(crashed[1]) : (crash.stdout + crash.stderr).slice(-300));
  const rec2 = run('recover');
  process.stdout.write(rec2.stdout || '');
  rec('(f) recover process exit', rec2.status === 0, `exit ${rec2.status}`);

  return finish();
}

function finish() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} steps passed`);
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e?.stack || e);
  process.exit(1);
});
