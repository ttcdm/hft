/**
 * Devnet-only end-to-end harness for the live execution path (R2).
 *
 *   npm run devnet:e2e            # runs under scripts/devnet_guard.cjs
 *
 * Safety: devnet only, throwaway keypair generated here, scratch DB, no Jito block engine (the RPC transport sends, as on devnet normally). ALLOW_LIVE_REAL_MONEY_TRADING is set true in-process ONLY after the cluster's genesis hash
 * equals the devnet hash. It never reads .env, the repo keypair, or any real RPC URL.
 */
import './hermeticEnv'; // no .env is ever loaded by this script
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { redact, childReport } from './redact';

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
// Every throwaway wallet steps (i), (k), (t), (u) and (m) create is written here before it is funded, and left here (Mike, 2026-10-24).
const tempWalletDir = path.join(scratch, 'temp-wallets');
// 3I: what the opt-in steps (t), (u) and (n) need free in the harness wallet before they start: what they lend, plus fees and a margin.
const RPC_SWITCH_NEED_SOL = 0.1;
const SELLER_NEVER_BOUGHT_NEED_SOL = 0.15;
// (n): one harness buy plus the 0.015 SOL reserve, the first buy's token-account rent and fees, with a margin.
const LOSS_FLOOR_NEED_SOL = 0.05;
// (l): one harness buy and sell, the same as (n).
const READINESS_GATE_NEED_SOL = 0.05;
// 3K (m): 0.15 lent to the coin creator, and enough left for five 0.008 SOL auto buys under the 10% spendable ceiling, with a margin.
const SESSION_SPEND_NEED_SOL = 0.3;

// ---- sanitized environment: must be set before any server module is imported ----
process.env.SOLANA_RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
// S245: the public devnet RPC refuses more than ~15 requests a second per client (HTTP 429), and a refused stop-loss send used to stick.
// Against it the trading Connection spaces its requests to 10 a second (sends first); a private DEVNET_RPC_URL is not throttled unless asked.
if (!process.env.RPC_MAX_REQUESTS_PER_SEC && /(^|\/\/)api\.devnet\.solana\.com/i.test(process.env.SOLANA_RPC_URL)) process.env.RPC_MAX_REQUESTS_PER_SEC = '10';
// Everything printed goes through safe(): a private DEVNET_RPC_URL carries its key in the path and names its endpoint in the host.
const safe = (t: unknown) => redact(String(t), [process.env.DEVNET_RPC_URL]);
// No block engine: devnet's real configuration. A dead Jito URL makes readiness report Jito OFFLINE and arming refuses, so the RPC transport is used directly.
delete process.env.JITO_BLOCK_ENGINE_URL;
process.env.ENABLE_RPC_FALLBACK = 'true';
// Devnet pump curves hold a few cents of SOL; the mainnet liquidity minimum would make every test mint ineligible. Honoured off mainnet only.
process.env.MIN_LIQUIDITY_USD = '0';
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

const results: { step: string; ok: boolean; detail: string; skipped?: true }[] = [];
const rec = (step: string, ok: boolean, detail: string) => {
  detail = safe(detail);
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
};
// A check that could not be made for a reason outside the app (the RPC): SKIP, kept in results.json, neither a pass nor a FAIL.
const skip = (step: string, detail: string) => {
  detail = safe(detail);
  results.push({ step, ok: true, detail, skipped: true });
  console.log(`SKIP  ${step}: ${detail}`);
};
const solscan = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // S227: tracing starts here when APEX_TRACING=true, as server.ts does at boot, after the environment above is set and before any connection is made.
  const { tracingReady } = await import('../server/observability/init');
  await tracingReady;
  const web3 = await import('@solana/web3.js');
  const { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } = web3;

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
  console.log(`INFO  cluster: genesis hash == devnet (${genesis}); anything else aborted above`); // a statement of fact, not a pass
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
      console.log(`single airdrop request failed (not retried): ${safe(e.message).slice(0, 120)}`);
    }
    bal = await conn.getBalance(kp.publicKey);
  }
  // Sizes scale down to the balance: the 10% spendable ceiling means a buy of about 8% of the balance.
  const balSol = bal / LAMPORTS_PER_SOL;
  const { planFunding, liveBuyRequest, awaitSolPrice } = await import('./devnet_funding');
  const plan = planFunding(balSol, kp.publicKey.toBase58());
  const BUY_SOL = plan.buySol;
  const funded = plan.funded;
  rec('funding', funded, plan.message);
  if (plan.unfunded) return finish(); // nothing to simulate or send with an empty wallet; the message above says what to do

  const { PumpCurveService } = await import('../server/solana/pumpCurve');
  const { txBuilder } = await import('../server/solana/transactionBuilder');
  const { executionConfig } = await import('../server/solana/executionConfig');

  // ---- pick a live pump mint the app's own eligibility filter accepts (S226) ----
  const { PUMPFUN_PROGRAM_ID } = await import('../server/solana/programs');
  const { curveProgressPctOfState, isCurveTooFar } = await import('../server/signals/curveProgressCap');
  const { fetchTokenHolderDistribution } = await import('../server/solana/pumpCurve');
  const { MAX_CREATOR_HOLDING_PCT, MAX_TOP10_HOLDERS_PCT } = await import('../server/solana/executionConfig');
  const M = await import('./devnet_mints');
  const limits = { maxCreatorPct: MAX_CREATOR_HOLDING_PCT, maxTop10Pct: MAX_TOP10_HOLDERS_PCT };
  const selectedFile = path.join(scratch, 'selected-mint.json');
  const states = new Map<string, any>();
  const probeMint = async (m: string): Promise<import('./devnet_mints').MintProbe> => {
    let st: any;
    try {
      st = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: new PublicKey(m), executionMode: 'LIVE' });
    } catch (e: any) {
      return { mint: m, usable: false, creatorPct: null, top10Pct: null, note: safe(e.message).slice(0, 80) };
    }
    if (!st || st.complete) return { mint: m, usable: false, creatorPct: null, top10Pct: null, note: 'migrated or unreadable' };
    // S270 (run 14): a mint already past the app's curve-progress cap is refused by every LIVE buy (CURVE_PROGRESS_TOO_HIGH), so it cannot be
    // the harness mint. The listed default 3St3fM... reached 60.8% after the earlier runs' buys.
    const progress = curveProgressPctOfState(st);
    if (progress === null || isCurveTooFar(progress)) return { mint: m, usable: false, creatorPct: null, top10Pct: null, note: progress === null ? 'curve progress unreadable' : `curve ${progress.toFixed(1)}% sold, past the cap` };
    states.set(m, st);
    try {
      const d = await fetchTokenHolderDistribution(conn, new PublicKey(m), st.creator, st.bondingCurve);
      return { mint: m, usable: true, creatorPct: d.devHoldingPct, top10Pct: d.top10HoldersPct };
    } catch (e: any) {
      return { mint: m, usable: true, creatorPct: null, top10Pct: null, note: safe(e.message).slice(0, 80) };
    }
  };
  const allowWaiver = process.env.DEVNET_NO_WAIVER !== '1';
  let mint: string | null = null;
  let waive = false;
  let state: any = null;
  if (phase !== 'main') {
    // The crash and recover processes use the mint the main process chose; they do not choose again.
    const sel = JSON.parse(fs.readFileSync(selectedFile, 'utf8'));
    mint = sel.mint;
    waive = !!sel.waive;
    state = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: new PublicKey(mint!), executionMode: 'LIVE' });
  } else {
    const listed = (process.env.DEVNET_MINTS ? process.env.DEVNET_MINTS.split(',') : DEFAULT_MINTS).map((x) => x.trim()).filter(Boolean);
    const probes: import('./devnet_mints').MintProbe[] = [];
    const seen = new Set<string>();
    const MAX_PROBES = 25;
    const clearFound = () => probes.some((p) => M.classifyProbe(p, limits) === 'CLEAR');
    for (const m of listed) {
      if (clearFound() || probes.length >= MAX_PROBES) break;
      seen.add(m);
      probes.push(await probeMint(m));
    }
    if (!clearFound()) {
      console.log(`INFO  none of the listed mints clears creator <= ${limits.maxCreatorPct}% and top-10 <= ${limits.maxTop10Pct}%; scanning recent pump.fun devnet activity`);
      for (const m of await M.recentCreateMints(conn, PUMPFUN_PROGRAM_ID)) {
        if (clearFound() || probes.length >= MAX_PROBES) break;
        if (seen.has(m)) continue;
        seen.add(m);
        probes.push(await probeMint(m));
      }
    }
    const count = (c: string) => probes.filter((p) => M.classifyProbe(p, limits) === c).length;
    console.log(`INFO  probed ${probes.length} mint(s): ${count('CLEAR')} clear, ${count('OVER')} over a limit, ${count('UNKNOWN')} holder data unreadable, ${count('UNUSABLE')} unusable`);
    const ordered = M.orderCandidates(probes, limits, allowWaiver);
    const pick = ordered[0];
    if (!pick) {
      const why = count('UNKNOWN') > 0
        ? `holder data could not be read for ${count('UNKNOWN')} mint(s) (the public devnet RPC rate-limits it: set DEVNET_RPC_URL to a private devnet endpoint). An unknown share is never waived.`
        : allowWaiver ? 'no usable mint was found at all.' : 'every readable mint is over a limit and DEVNET_NO_WAIVER=1 forbids the waiver.';
      rec('mint', false, `no eligible pump.fun devnet mint: ${why} You can also pass DEVNET_MINTS=<comma list>.`);
      return finish();
    }
    mint = pick.mint;
    state = states.get(mint);
    waive = pick.kind === 'OVER';
    if (waive) {
      console.log(`WAIVER  no mint cleared the limits. Using ${mint}: creator ${pick.creatorPct.toFixed(1)}% (limit ${limits.maxCreatorPct}%), top-10 ${pick.top10Pct.toFixed(1)}% (limit ${limits.maxTop10Pct}%).`);
      console.log("WAIVER  The creator and top-10 checks are waived for this devnet run only, in the harness report. The app's own filter is unchanged. Set DEVNET_NO_WAIVER=1 to forbid this.");
    }
    fs.writeFileSync(selectedFile, JSON.stringify({ mint, waive }));
  }
  if (!mint || !state) {
    rec('mint', false, 'no usable active pump.fun devnet mint; pass DEVNET_MINTS=<comma list> (they go stale fast)');
    return finish();
  }
  console.log(`INFO  mint: ${mint}${waive ? ' (holder limits waived, see above)' : ''}`); // the failure case above is recorded; this line is not a pass
  const mintPk = new PublicKey(mint);

  if (phase === 'main') {
    // ---- (j) P4.2: a 10 s websocket block through a loopback proxy, then the pump feed boot path (scripts/devnet_e2e_steps.ts) ----
    {
      const S = await import('./devnet_e2e_steps');
      const { PumpFeedListener } = await import('../server/solana/pumpFeedListener');
      const { WatchWindow } = await import('../server/signals/watchWindow');
      const { pumpFunService, pumpBootMode } = await import('../server/pumpfunService');
      await S.feedGapThroughWsProxy({ mint, rec, sleep }, {
        Listener: PumpFeedListener, Window: WatchWindow, Connection, rpcUrl: process.env.SOLANA_RPC_URL!,
        bootPumpFeed: () => { const m = pumpBootMode(); if (m !== 'OFF') pumpFunService.startBackground({ httpPollers: m === 'FULL' }); return m; }, // as server.ts boots it
      });
    }

    // ---- stage 1: simulate (sigVerify false, replaceRecentBlockhash true) ----
    try {
      const quote = PumpCurveService.calculateBuyQuote({
        state, amountSol: BUY_SOL, slippageBps: 800, jitoTipSol: 0, priorityFeeLamports: 0, executionMode: 'LIVE',
      });
      const ata = PumpCurveService.getAssociatedTokenAddress(mintPk, kp.publicKey, state.tokenProgram);
      const buyTx = await txBuilder.buildBuyTransaction(conn, {
        buyer: kp.publicKey, mint: mintPk, bondingCurve: state.bondingCurve, associatedBondingCurve: state.associatedBondingCurve,
        associatedUser: ata, creator: state.creator, feeRecipient: state.feeRecipient, buybackFeeRecipient: state.buybackFeeRecipient,
        quoteMint: state.quoteMint, tokenProgram: state.tokenProgram, quoteTokenProgram: state.quoteTokenProgram,
        amountTokens: BigInt(quote.tokenAmountRaw), maxSolCostLamports: BigInt(quote.maxInputLamports),
        computeUnits: 250000, priorityFeeMicroLamports: executionConfig.getConfig().priorityFeeMicrolamports,
        jitoTipLamports: 0n, jitoTipAccount: executionConfig.getJitoTipAccountPublicKey(),
      });
      const sim = await conn.simulateTransaction(buyTx as any, { sigVerify: false, replaceRecentBlockhash: true });
      rec('simulate BUY', !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) + ' ' + (sim.value.logs || []).slice(-3).join(' | ') : `ok, ${sim.value.unitsConsumed} CU`);
    } catch (e: any) {
      rec('simulate BUY', false, String(e.message).slice(0, 300));
    }
  }
  if (!funded) return finish();

  // P1.2: the module's own singleton, the one server.ts uses. A second `new ExecutionCoordinator(true)` here ran a second exit loop on the
  // same DB and signer (N-55).
  const { executionCoordinator: coordinator } = await import('../server/execution/coordinator');
  const { localSigner } = await import('../server/solana/signer');
  const { workstationDb } = await import('../server/db/database');
  const { riskEngine } = await import('../server/risk/riskEngine');
  // server.ts starts the SOL/USD price service at boot (a LIVE buy needs a fresh price for the liquidity gate); this script does not run server.ts.
  const { solPriceService } = await import('../server/market/solPriceService');
  solPriceService.startAutoRefresh();
  const price = await awaitSolPrice(solPriceService);
  if (!price.ok) {
    rec('SOL/USD price', false, 'no price could be read from Coinbase, CoinGecko or Binance (all public; none is a mainnet or Jito host). No price is made up. Check the network and re-run.');
    return finish();
  }
  console.log(`INFO  SOL/USD ${price.usd} (read by the price service)`);
  if (phase === 'crash') {
    // Kill the process the instant the RPC returns a signature, before confirmation is recorded.
    const orig = Connection.prototype.sendRawTransaction;
    Connection.prototype.sendRawTransaction = async function (this: InstanceType<typeof Connection>, ...a: any[]) {
      const sig = await (orig as any).apply(this, a);
      console.log(`CRASH_AFTER_SUBMIT ${sig}`);
      process.exit(137);
    } as any;
  }
  coordinator.start(); // P1.1: the singleton starts nothing at import; this takes the DB and signer locks and starts the connection check, reconciliation and exit loop
  await sleep(4000); // let the background connection/reconciliation settle
  await coordinator.syncRealWalletBalance();
  // R1-121: arm only when the app's signer is the throwaway key generated above, never a key that came from the shell or an env file.
  const signerKey = localSigner.getStatus() === 'READY' ? localSigner.getPublicKey().toBase58() : localSigner.getStatus();
  if (signerKey !== kp.publicKey.toBase58()) {
    rec('signer is the throwaway key', false, `the app's signer is ${signerKey}, not the throwaway ${kp.publicKey.toBase58()}; not arming`);
    return finish();
  }
  const armed = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK');
  rec('arm LIVE (devnet)', armed.success, armed.message);
  if (!armed.success) return finish();

  const ataBalance = async () => {
    const accts = await conn.getTokenAccountsByOwner(kp.publicKey, { mint: mintPk });
    if (!accts.value.length) return 0n;
    const b = await conn.getTokenAccountBalance(accts.value[0].pubkey);
    return BigInt(b.value.amount);
  };
  const { readChainErr } = await import('./devnet_e2e_steps');
  const verify = async (label: string, sig?: string) => {
    if (!sig) return rec(`${label} getTransaction`, false, 'no signature');
    const err = await readChainErr(conn, sig);
    rec(`${label} getTransaction`, err === null, `${solscan(sig)}${err === undefined ? ' not read (no answer after retries)' : err ? ' err=' + JSON.stringify(err) : ''}`);
  };

  // The eligibility report for the buy, built from fresh holder data right before it (the coordinator refuses a report older than 60 s). Built here so
  // a rate-limited holder lookup inside the coordinator cannot refuse a mint that was already screened; with waive set, only the creator and top-10 checks are waived.
  // (h) buys a coin the harness itself created, so this takes the mint and reads its state; the holder waiver applies to that coin always
  // (its creator is the harness's second wallet, which holds most of it by construction).
  const buildBuyRequestFor = async (m: string, st: any, allowWaive: boolean) => {
    let report: import('../server/core/types').TokenEligibilityReport | undefined;
    try {
      const { EligibilityFilter } = await import('../server/signals/eligibilityFilter');
      const dist = await fetchTokenHolderDistribution(conn, new PublicKey(m), st.creator, st.bondingCurve);
      const liquidityUsd = (Number(st.realSolReserves) / 1e9) * price.usd! * 2;
      report = EligibilityFilter.evaluate(M.harnessEligibilityInput({ mint: m, symbol: 'E2E', name: 'E2E' }, st, dist, liquidityUsd), true);
      if (!report.isEligible && allowWaive) {
        const w = M.waiveHolderChecks(report);
        if (w) {
          console.log(`WAIVER  waiving for this run: ${w.waived.join('; ')}`);
          report = w.report;
        }
      }
    } catch (e: any) {
      console.log(`INFO  could not build the eligibility report (${safe(e.message).slice(0, 100)}); the coordinator will check by itself`);
      report = undefined;
    }
    return liveBuyRequest(m, BUY_SOL, Date.now(), report);
  };
  const buildBuyRequest = () => buildBuyRequestFor(mint!, state, waive);

  if (phase === 'recover') {
    const r = await coordinator.startupReconciliation();
    rec('(f) startupReconciliation after kill', r.status !== 'OFFLINE', `${r.status}: ${r.details}`);
    const open = workstationDb.loadPositions().filter((p) => p.mint === mint);
    rec('(f) position recovered', open.length > 0, JSON.stringify(open.map((p) => ({ id: p.id, status: p.status, qty: p.tokenQuantityRaw }))));
    // S256: sell what was recovered, so the next run's startup wallet scan does not adopt it (run 6's (a) was refused POSITION_ALREADY_OPEN on it)
    for (const p of open.filter((x) => x.status === 'OPEN' || x.status === 'PARTIALLY_CLOSED')) {
      const c = await coordinator.closePosition(p.id, 100, 'e2e cleanup after (f)').catch((e: any) => ({ success: false, error: String(e?.message ?? e) }));
      console.log(`INFO  (f) cleanup: recovered position ${p.id.slice(0, 8)} ${c.success ? 'sold' : `not sold (${safe(c.error ?? 'unknown')})`}`);
    }
    return finish();
  }
  if (phase === 'crash') {
    await coordinator.executeTrade(await buildBuyRequest());
    rec('crash phase', false, 'process should have been killed after submit');
    return finish();
  }

  // S256: tokens an earlier run left in this wallet are adopted at startup as RECOVERED positions; one on the harness mint would make (a)
  // POSITION_ALREADY_OPEN. Sell it first (it is the harness wallet's own leftover, not part of this run's checks).
  for (const p of workstationDb.loadPositions(undefined, 'ACTIVE').filter((x) => x.mint === mint && x.executionMode === 'LIVE')) {
    // S268 (L5): a throw here used to end the run before results.json was written
    const c = await coordinator.closePosition(p.id, 100, 'e2e leftover from an earlier run').catch((e: any) => ({ success: false, error: String(e?.message ?? e) }));
    console.log(`INFO  leftover position ${p.id.slice(0, 8)} on the harness mint ${c.success ? 'sold before (a)' : `not sold (${safe(c.error ?? 'unknown')})`}`);
    await sleep(31_000); // the per-mint cooldown that sell started
  }

  // (a) BUY through the RPC transport
  const buy = await coordinator.executeTrade(await buildBuyRequest());
  const buyDoneAt = Date.now();
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
  const ataAfter50 = await ataBalance();
  rec('(b) ATA after 50% holds roughly half (between 40% and 60% of before)', onchain > 0n && ataAfter50 * 100n >= onchain * 40n && ataAfter50 * 100n <= onchain * 60n, `before=${onchain} after=${ataAfter50}`);
  const c100 = await coordinator.closePosition(pos.id, 100, 'e2e 100%');
  rec('(c) close 100%', c100.success, c100.error || `pnl=${c100.pnlSol}`);
  const after = await conn.getBalance(kp.publicKey);
  rec('(c) ATA closed, rent returned', (await conn.getTokenAccountsByOwner(kp.publicKey, { mint: mintPk })).value.length === 0, `balance ${after / LAMPORTS_PER_SOL} SOL (expect ~0.00203928 rent back)`);
  for (const t of workstationDb.loadTransactions().filter((x) => x.direction === 'SELL')) await verify('(b/c) SELL', t.signature);

  // (d') forced revert through the app, (e') two sequential buys of one mint (scripts/devnet_e2e_steps.ts). The harness signs nothing itself.
  const steps: import('./devnet_e2e_steps').HarnessSteps = {
    coordinator, curve: PumpCurveService, db: workstationDb as any, riskLimits: () => riskEngine.getLimits(), mint: mint!,
    chainErr: (sig) => readChainErr(conn, sig),
    buildBuyRequest, rec, skip, link: solscan, sleep, rpcUrl: process.env.SOLANA_RPC_URL!,
    // S257: read when a step runs, not once here. (g) points the coordinator at a proxy and back, which gives it a new Connection; (h) then
    // wrapped the old one, and the app's price read never reached the wrapper (runs 6 and 7: "no read of the curve in 10 s").
    get connection() { return coordinator.getConnection() as any; },
    stop: {
      telegram: (await import('../server/socialScanner')).socialScanner,
      emergencyStop: (await import('../server/execution/emergencyStop')).emergencyStop,
      setKillSwitch: (on) => riskEngine.setKillSwitch(on),
      arm: (a, code) => coordinator.armLiveTrading(a, code),
      auto: (await import('../server/auto/controller')).autoSnipeController as any,
    },
  };
  const S = await import('./devnet_e2e_steps');
  // The (a) buy started the 30 s per-mint cooldown; (d') must reach the chain, so it waits that out first.
  await S.waitPast(steps, buyDoneAt, riskEngine.getLimits().cooldownPerMintMs, 'per-mint cooldown from the (a) buy');
  const revertedAt = await S.forcedRevertThroughApp(steps);
  await S.unreadableReservesRefused(steps); // (s) 3I: free, nothing is sent, so it runs inside the (d') failure cooldown
  await S.waitPast(steps, revertedAt, riskEngine.getLimits().cooldownAfterFailedTradeMs, "failure cooldown from the (d') revert");
  const lastBuyAt = await S.sequentialBuysOneMint(steps);
  await S.waitPast(steps, lastBuyAt, riskEngine.getLimits().cooldownPerMintMs, "per-mint cooldown from the (e') buy");
  await S.ambiguousSendThroughApp(steps); // P1.5
  await S.waitPast(steps, Date.now(), riskEngine.getLimits().cooldownPerMintMs, "per-mint cooldown from the (e'') buy");
  await S.heldBlockhashStopLoss(steps); // P1.7
  const gDoneAt = Date.now();
  await rpcSwitchStep(steps, S, { conn, web3, kp, coordinator, PumpCurveService, txBuilder });

  // (h) P1.6: opt-in (DEVNET_DUMP_SOL is the most the seed may take). The seed is sized from the coin's own curve (DEVNET_E2E_README.md).
  const dumpSol = Number(process.env.DEVNET_DUMP_SOL || 0);
  // The second wallet's key lives in the scratch directory next to the throwaway key; a run with the same APEX_E2E_SCRATCH first gets back
  // what an earlier run left in it, whether or not (h) runs this time.
  const secondKeyPath = path.join(scratch, 'second-wallet.json');
  const dumpMarket = async () => S.makeDumpMarket({ conn, payer: kp, web3, sdk: (await import('@pump-fun/pump-sdk')).PUMP_SDK, curve: PumpCurveService, builder: txBuilder, keyPath: secondKeyPath });
  if (fs.existsSync(secondKeyPath)) {
    // S268 (M5): a failed leftover refund is a FAIL line, not INFO
    try { await (await dumpMarket()).refund(); } catch (e: any) { rec('(h) leftover refund from the second wallet', false, `${safe(e?.message ?? e).slice(0, 120)}`); }
  }
  if (dumpSol > 0) {
    const market = await dumpMarket();
    const have = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    const maxSeedSol = Math.min(dumpSol, have - BUY_SOL - 0.3);
    if (maxSeedSol <= 0) {
      rec('(h) funding for the dump', false, `the throwaway ${kp.publicKey.toBase58()} has ${have.toFixed(3)} SOL; (h) needs the seed plus ${(BUY_SOL + 0.3).toFixed(2)} SOL`);
    } else {
      await S.failedReadThenDumpStopLoss(steps, market, {
        appBuySol: BUY_SOL,
        maxSeedSol,
        buildBuyRequestFor: async (m) => buildBuyRequestFor(m, await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: new PublicKey(m), executionMode: 'LIVE' }), true),
      });
    }
  } else {
    console.log('INFO  (h) skipped: set DEVNET_DUMP_SOL to the most the seed may take (the seed is sized from the coin\'s own curve, see DEVNET_E2E_README.md) to run the failed-read stop-loss step');
  }

  // (i) P4.1: opt-in. The creator cluster and funder truth through the app's own pump log stream, watch window and funder lookup, wired
  // as server.ts wires them (this script does not run server.ts). The harness's own throwaway wallets make every trade; the app trades nothing.
  if (process.env.DEVNET_CLUSTER_CHECK === '1') {
    const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
    const { watchWindow } = await import('../server/signals/watchWindow');
    const { pumpFeedListener } = await import('../server/solana/pumpFeedListener');
    const { FunderLookup, wireFunderLookup } = await import('../server/signals/funderLookup');
    watchWindow.attach(pumpFeedListener);
    wireFunderLookup(watchWindow, new FunderLookup(() => coordinator.getConnection()));
    watchWindow.start();
    const subscribed = await pumpFeedListener.start();
    rec('(i) creator cluster: the pump log stream subscribed', subscribed, subscribed ? 'onLogs on the coordinator connection' : 'pumpFeedListener.start() returned false');
    if (subscribed) {
      const kit = S.makeChainKit({ conn, web3, sdk: PUMP_SDK, curve: PumpCurveService, builder: txBuilder, keyDir: tempWalletDir });
      await S.creatorClusterOnChain(steps, kit, { snapshot: () => watchWindow.getSnapshot() }, kp);
    }
    watchWindow.stop();
    await pumpFeedListener.stop();
  } else {
    console.log('INFO  (i) skipped: set DEVNET_CLUSTER_CHECK=1 (needs about 0.4 SOL free, spends about 0.03) to run the creator-cluster and one-funder-cluster step');
  }

  await sellerNeverBoughtStep(steps, S, { conn, web3, kp, coordinator, PumpCurveService, txBuilder });

  await releaseGatesStep(steps, S, { conn, web3, kp, coordinator, workstationDb, PumpCurveService, txBuilder, buildBuyRequestFor });

  await S.waitPast(steps, gDoneAt, riskEngine.getLimits().cooldownPerMintMs, 'per-mint cooldown from the (g) buy');
  const nDoneAt = await lossFloorStep(steps, S, { conn, kp, buySol: BUY_SOL });
  await S.waitPast(steps, nDoneAt, riskEngine.getLimits().cooldownPerMintMs, 'per-mint cooldown from the (n) trades');
  const lDoneAt = await readinessGateStep(steps, S, { conn, kp, Keypair, coordinator, workstationDb });
  await S.waitPast(steps, lDoneAt, riskEngine.getLimits().cooldownPerMintMs, 'per-mint cooldown from the (l) trades');
  await sessionSpendStep(steps, S, { conn, web3, kp, coordinator, workstationDb, PumpCurveService, txBuilder }); // 3K (m): its own coins
  await S.emergencyStopThroughApp(steps); // P1.4, last: it leaves LIVE disarmed and auto OFF. Telegram-path panic sells the LIVE position; kill switch on/off/re-arm buys nothing

  // (f) crash after submit, then recover in a fresh process on the same scratch DB. This process holds that DB's and that key's
  // instance locks (P1.1), so it stops trading and releases them first; it trades nothing after this.
  const IL = await import('../server/system/instanceLock');
  const lockPaths = [IL.dbLockPath(workstationDb.getDbPath()), IL.signerLockPath(kp.publicKey.toBase58())].filter((p): p is string => !!p);
  if (!(await S.handOverToChildPhases(steps, {
    stopTrading: () => coordinator.cleanup(), isLiveArmed: () => coordinator.isLiveArmed(), disarm: () => coordinator.armLiveTrading(false),
    releaseAllLocks: IL.releaseAllLocks, holdsLock: (p) => IL.readLock(p)?.pid === process.pid, lockPaths,
    // the coordinator has no public handle on its running exit pass; the harness reads the private field it keeps (read only)
    exitPassDone: () => (coordinator as any).exitPassInFlight ?? Promise.resolve(),
  }))) return finish();
  const env = { ...process.env, APEX_E2E_SCRATCH: scratch };
  const self = process.argv[1];
  const run = (p: string) => spawnSync(process.execPath, ['--require', path.resolve('scripts/devnet_guard.cjs'), '--import', 'tsx', self, `--phase=${p}`], { env, encoding: 'utf8', timeout: 240_000 });
  const crash = run('crash');
  const crashed = /CRASH_AFTER_SUBMIT (\S+)/.exec(crash.stdout || '');
  rec('(f) process killed after submit', !!crashed, crashed ? solscan(crashed[1]) : `the child never reached the send: ${childReport(crash, [process.env.DEVNET_RPC_URL])}`);
  const rec2 = run('recover');
  process.stdout.write(rec2.stdout || '');
  rec('(f) recover process exit', rec2.status === 0, `exit ${rec2.status}`);

  return finish();
}

/**
 * (k) P4.3, opt-in: the release gates through the app's own log stream, watch window and auto controller, wired as server.ts wires them (this script
 * does not run server.ts). DEVNET_RELEASE_GATES=1 runs the SHADOW-then-PAPER part (about 1 SOL lent, most of it refunded); DEVNET_CURVE_CAP=1 adds
 * the curve-cap push, which needs about 25.8 SOL more with 30 SOL virtual reserves (computed from the coin's own curve; see DEVNET_E2E_README.md).
 * Kept in its own function so it merges apart from the other steps.
 */
async function releaseGatesStep(steps: import('./devnet_e2e_steps').HarnessSteps, S: typeof import('./devnet_e2e_steps'), d: {
  conn: any; web3: any; kp: any; coordinator: any; workstationDb: any; PumpCurveService: any; txBuilder: any;
  buildBuyRequestFor: (m: string, st: any, allowWaive: boolean) => Promise<any>;
}): Promise<void> {
  if (process.env.DEVNET_RELEASE_GATES !== '1') {
    console.log('INFO  (k) skipped: set DEVNET_RELEASE_GATES=1 (needs about 1.2 SOL free, spends about 0.1) to run the SHADOW/PAPER release-gates step; add DEVNET_CURVE_CAP=1 (about 27 SOL more, see the README) for the curve-cap push');
    return;
  }
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { watchWindow } = await import('../server/signals/watchWindow');
  const { pumpFeedListener } = await import('../server/solana/pumpFeedListener');
  const { FunderLookup, wireFunderLookup } = await import('../server/signals/funderLookup');
  const { onChainPoolStats } = await import('../server/market/poolStats');
  const { memecoinAggregator } = await import('../server/memecoinAggregator');
  const { maxCurveProgressPct } = await import('../server/signals/curveProgressCap');
  const { autoSnipeController } = await import('../server/auto/controller');
  watchWindow.setScoreFn((mint) => { const pool = memecoinAggregator.getPools().find((p) => p.contractAddress === mint); return pool ? memecoinAggregator.evaluateTokenConfluence(pool).score : null; });
  watchWindow.setCurveProgressFn((mint) => onChainPoolStats.get(mint)?.curveProgressPct ?? null);
  watchWindow.attach(pumpFeedListener); // idempotent in effect: a second create of a watched mint and a repeated trade are both ignored
  wireFunderLookup(watchWindow, new FunderLookup(() => d.coordinator.getConnection()));
  watchWindow.start();
  autoSnipeController.attachWatchWindow();
  const subscribed = await pumpFeedListener.start();
  steps.rec('(k) release gates: the pump log stream subscribed', subscribed, subscribed ? 'onLogs on the coordinator connection' : 'pumpFeedListener.start() returned false');
  if (subscribed) {
    const kit = S.makeChainKit({ conn: d.conn, web3: d.web3, sdk: PUMP_SDK, curve: d.PumpCurveService, builder: d.txBuilder, keyDir: tempWalletDir });
    const curveState = (m: string) => d.PumpCurveService.fetchPumpMarketState({ connection: d.conn, mint: new d.web3.PublicKey(m), executionMode: 'LIVE' });
    await S.releaseGatesOnChain(steps, kit, { snapshot: () => watchWindow.getSnapshot() }, d.kp, {
      decisions: (mint) => d.workstationDb.loadDecisions({ mint }),
      curveState,
      progressPct: (mint) => onChainPoolStats.get(mint)?.curveProgressPct ?? null,
      capPct: maxCurveProgressPct(),
      buildBuyRequestFor: async (m) => d.buildBuyRequestFor(m, await curveState(m), true),
      balanceSol: async (k) => (await d.conn.getBalance(k.publicKey)) / 1e9,
      isLiveArmed: () => d.coordinator.isLiveArmed(),
    }, { curveCap: process.env.DEVNET_CURVE_CAP === '1' });
  }
  autoSnipeController.detachWatchWindow();
  watchWindow.stop();
  await pumpFeedListener.stop();
}

/**
 * (n) 3C, opt-in (DEVNET_LOSS_FLOOR=1): the net daily PnL floor, its latch and the resume flags through executeTrade on the harness mint, then
 * a child boot with MAX_POSITION_SIZE_SOL=abc that must refuse before any network call. Returns when its last trade settled.
 */
async function lossFloorStep(steps: import('./devnet_e2e_steps').HarnessSteps, S: typeof import('./devnet_e2e_steps'), d: { conn: any; kp: any; buySol: number }): Promise<number> {
  if (process.env.DEVNET_LOSS_FLOOR !== '1') {
    console.log(`INFO  (n) skipped: set DEVNET_LOSS_FLOOR=1 (needs ${LOSS_FLOOR_NEED_SOL} SOL free, spends about 0.003: one buy and sell's fees) to run the net daily PnL floor step (3C)`);
    return 0;
  }
  if (!(await S.hasBudget(steps, '(n) 3C: net daily PnL floor', async () => (await d.conn.getBalance(d.kp.publicKey)) / 1e9, LOSS_FLOOR_NEED_SOL, 'DEVNET_LOSS_FLOOR'))) return 0;
  const { executionConfig } = await import('../server/solana/executionConfig');
  const { solPriceService } = await import('../server/market/solPriceService');
  const { riskEngine } = await import('../server/risk/riskEngine');
  const { autoSnipeController } = await import('../server/auto/controller');
  const doneAt = await S.lossFloorLatch(steps, {
    floorUsd: () => executionConfig.getConfig().maxDailyLossUsd,
    setFloorUsd: (usd) => { executionConfig.updateConfig({ maxDailyLossUsd: usd }); },
    price: () => solPriceService.getPrice(),
    refreshPrice: () => solPriceService.refresh(),
    dailyPnlSol: () => riskEngine.getDailyTotalPnLSol('LIVE'),
    latch: () => riskEngine.getDailyLossLatch('LIVE'),
    clearLatch: () => riskEngine.clearDailyLossLatch(),
    resume: (o) => autoSnipeController.resume(o),
    orderSol: d.buySol,
  });
  const bootDb = path.join(scratch, 'boot-check-abc.db');
  S.bootRefusesBadLimit(steps, () => spawnSync(process.execPath, ['--require', path.resolve('scripts/devnet_guard.cjs'), '--import', 'tsx', 'server.ts'], {
    encoding: 'utf8', timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? scratch, APEX_ENV_FILE: '', NODE_ENV: 'production', APP_PORT: '0',
      ALLOWED_CLUSTER: 'devnet', SOLANA_RPC_URL: process.env.SOLANA_RPC_URL!, APEX_DB_PATH: bootDb, SIGNER_KEYPAIR_PATH: path.join(scratch, 'no-such-key.json'),
      APEX_DISABLE_EXTERNAL_FEEDS: 'true', MAX_POSITION_SIZE_SOL: 'abc',
    },
  }), bootDb);
  return doneAt;
}

/**
 * (l) 3A, opt-in (DEVNET_READINESS_GATE=1): a Reconcile that ends in RECONCILIATION_MISMATCH after the arm refuses the next LIVE buy
 * (LIVE_NOT_READY), and a buy goes through again once the row is resolved and Reconcile is EXECUTION_READY. The unresolved row is written
 * into this run's scratch database with a made-up signature for a made-up mint; nothing is sent for it. Returns when its last trade settled.
 */
async function readinessGateStep(
  steps: import('./devnet_e2e_steps').HarnessSteps,
  S: typeof import('./devnet_e2e_steps'),
  d: { conn: any; kp: any; Keypair: any; coordinator: any; workstationDb: any },
): Promise<number> {
  if (process.env.DEVNET_READINESS_GATE !== '1') {
    console.log(`INFO  (l) skipped: set DEVNET_READINESS_GATE=1 (needs ${READINESS_GATE_NEED_SOL} SOL free, spends about 0.003: one buy and sell's fees) to run the per-buy readiness step (3A)`);
    return 0;
  }
  if (!(await S.hasBudget(steps, '(l) 3A: per-buy readiness', async () => (await d.conn.getBalance(d.kp.publicKey)) / 1e9, READINESS_GATE_NEED_SOL, 'DEVNET_READINESS_GATE'))) return 0;
  const bs58 = (await import('bs58')).default;
  const { randomBytes } = await import('crypto');
  return S.readinessGateAfterMismatch(steps, {
    reconcile: () => d.coordinator.startupReconciliation({ fresh: true }),
    isLiveArmed: () => d.coordinator.isLiveArmed(),
    plantUnresolvedBuy: () => {
      const signature = bs58.encode(randomBytes(64));
      const saved = d.workstationDb.saveTransaction({
        signature, orderId: `e2e-l-${signature.slice(0, 8)}`, correlationId: 'e2e-l', mint: d.Keypair.generate().publicKey.toBase58(), direction: 'BUY',
        submissionTransport: 'SOLANA_RPC', submissionTime: Date.now(), reconciliationState: 'RECONCILIATION_REQUIRED', networkFeeLamports: 5000,
        jitoTipLamports: 0, executionMode: 'LIVE',
      });
      if (!saved) throw new Error('the unresolved buy row could not be written');
      return signature;
    },
    resolveRow: (sig) => {
      const row = d.workstationDb.loadTransactions().find((t: any) => t.signature === sig);
      if (!row) throw new Error(`row ${sig.slice(0, 8)} not found`);
      if (!d.workstationDb.saveTransaction({ ...row, reconciliationState: 'REVERTED', error: 'e2e (l): resolved by the harness' })) throw new Error('the row could not be resolved');
    },
  });
}

type FeedStepDeps = { conn: any; web3: any; kp: any; coordinator: any; PumpCurveService: any; txBuilder: any };

/**
 * (t) 3I, opt-in (DEVNET_FEED_SWITCH=1): two quick RPC switches move the app's pump feed and leave one log subscription (B7, B10). Wired as
 * server.ts wires it: the listener follows the coordinator, and the watch window is attached so a launch after the switch can be seen.
 */
async function rpcSwitchStep(steps: import('./devnet_e2e_steps').HarnessSteps, S: typeof import('./devnet_e2e_steps'), d: FeedStepDeps): Promise<void> {
  if (process.env.DEVNET_FEED_SWITCH !== '1') {
    console.log(`INFO  (t) skipped: set DEVNET_FEED_SWITCH=1 (needs ${RPC_SWITCH_NEED_SOL} SOL free, spends about 0.02) to run the two-quick-RPC-switches step (B7/B10)`);
    return;
  }
  if (!(await S.hasBudget(steps, '(t) B7/B10: two quick RPC switches', async () => (await d.conn.getBalance(d.kp.publicKey)) / 1e9, RPC_SWITCH_NEED_SOL, 'DEVNET_FEED_SWITCH'))) return;
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { watchWindow } = await import('../server/signals/watchWindow');
  const { pumpFeedListener } = await import('../server/solana/pumpFeedListener');
  const { PUMPFUN_PROGRAM_ID } = await import('../server/solana/programs');
  watchWindow.attach(pumpFeedListener);
  watchWindow.start();
  try {
    await S.rpcSwitchMovesFeed(steps, {
      listener: pumpFeedListener as any, coordinator: d.coordinator, Connection: d.web3.Connection, pumpProgramId: PUMPFUN_PROGRAM_ID.toBase58(),
      rpcUrl: process.env.SOLANA_RPC_URL!, feed: { snapshot: () => watchWindow.getSnapshot() },
      kit: S.makeChainKit({ conn: d.conn, web3: d.web3, sdk: PUMP_SDK, curve: d.PumpCurveService, builder: d.txBuilder, keyDir: tempWalletDir }), payer: d.kp,
    });
  } finally {
    watchWindow.stop();
  }
}

/** (u) 3I, opt-in (DEVNET_SELLER_NEVER_BOUGHT=1): a seller that never bought is looked up and its sell is CREATOR_SOLD (B3). Wired as (i). */
async function sellerNeverBoughtStep(steps: import('./devnet_e2e_steps').HarnessSteps, S: typeof import('./devnet_e2e_steps'), d: FeedStepDeps): Promise<void> {
  if (process.env.DEVNET_SELLER_NEVER_BOUGHT !== '1') {
    console.log(`INFO  (u) skipped: set DEVNET_SELLER_NEVER_BOUGHT=1 (needs ${SELLER_NEVER_BOUGHT_NEED_SOL} SOL free, spends about 0.03) to run the seller-that-never-bought step (B3)`);
    return;
  }
  if (!(await S.hasBudget(steps, '(u) B3: a seller that never bought', async () => (await d.conn.getBalance(d.kp.publicKey)) / 1e9, SELLER_NEVER_BOUGHT_NEED_SOL, 'DEVNET_SELLER_NEVER_BOUGHT'))) return;
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { watchWindow } = await import('../server/signals/watchWindow');
  const { pumpFeedListener } = await import('../server/solana/pumpFeedListener');
  const { FunderLookup, wireFunderLookup } = await import('../server/signals/funderLookup');
  watchWindow.attach(pumpFeedListener);
  wireFunderLookup(watchWindow, new FunderLookup(() => d.coordinator.getConnection()));
  watchWindow.start();
  const subscribed = await pumpFeedListener.start();
  steps.rec('(u) B3: the pump log stream subscribed', subscribed, subscribed ? 'onLogs on the coordinator connection' : 'pumpFeedListener.start() returned false');
  try {
    if (subscribed) {
      const kit = S.makeChainKit({ conn: d.conn, web3: d.web3, sdk: PUMP_SDK, curve: d.PumpCurveService, builder: d.txBuilder, keyDir: tempWalletDir });
      await S.sellerWhoNeverBought(steps, kit, { snapshot: () => watchWindow.getSnapshot() }, d.kp);
    }
  } finally {
    watchWindow.stop();
    await pumpFeedListener.stop();
  }
}

/**
 * (m) 3B, task 3K, opt-in (DEVNET_SESSION_SPEND=1): a 5-buy DEVNET_LIVE auto session through the app's own auto controller and coordinator;
 * the session's spentSol (what GET /api/auto/status returns) against the wallet's drop around each buy (S.sessionSpendMatchesWallet).
 */
async function sessionSpendStep(steps: import('./devnet_e2e_steps').HarnessSteps, S: typeof import('./devnet_e2e_steps'), d: FeedStepDeps & { workstationDb: any }): Promise<void> {
  const L = '(m) 3B: DEVNET_LIVE session spend';
  if (process.env.DEVNET_SESSION_SPEND !== '1') {
    console.log(`INFO  (m) skipped: set DEVNET_SESSION_SPEND=1 (needs ${SESSION_SPEND_NEED_SOL} SOL free, spends about 0.04) to run the 5-buy DEVNET_LIVE session spend step (3B)`);
    return;
  }
  const bal = async () => (await d.conn.getBalance(d.kp.publicKey)) / 1e9;
  if (!(await S.hasBudget(steps, L, bal, SESSION_SPEND_NEED_SOL, 'DEVNET_SESSION_SPEND'))) return;
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { watchWindow } = await import('../server/signals/watchWindow');
  const { autoSnipeController } = await import('../server/auto/controller');
  const { memecoinAggregator } = await import('../server/memecoinAggregator');
  const kit = S.makeChainKit({ conn: d.conn, web3: d.web3, sdk: PUMP_SDK, curve: d.PumpCurveService, builder: d.txBuilder, keyDir: tempWalletDir });
  const coins = S.stepCoins(steps, L, kit, d.kp);
  const b0 = await bal().catch(() => null);
  await S.sessionSpendMatchesWallet(steps, {
    auto: autoSnipeController as any,
    watch: watchWindow as any,
    confluence: memecoinAggregator,
    balanceLamports: () => d.conn.getBalance(d.kp.publicKey),
    haltReason: () => d.coordinator.getHaltReason(),
    openLive: () => d.workstationDb.loadPositions('LIVE', 'ACTIVE'),
    makeCoins: (n) => coins.make(n),
    cleanupCoins: () => coins.cleanup(),
  });
  const b1 = await bal().catch(() => null);
  if (b0 !== null && b1 !== null) console.log(`INFO  (m) cost the harness wallet ${(b0 - b1).toFixed(5)} SOL`);
}

function finish() {
  const bad = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped).length;
  const counted = results.length - skipped;
  console.log(`\n${counted - bad.length}/${counted} steps passed${skipped ? `, ${skipped} skipped (see the SKIP lines)` : ''}`);
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', safe(e?.stack || e));
  process.exit(1);
});
