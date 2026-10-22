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

// ---- sanitized environment: must be set before any server module is imported ----
process.env.SOLANA_RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
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

const results: { step: string; ok: boolean; detail: string }[] = [];
const rec = (step: string, ok: boolean, detail: string) => {
  detail = safe(detail);
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
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
  const verify = async (label: string, sig?: string) => {
    if (!sig) return rec(`${label} getTransaction`, false, 'no signature');
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    rec(`${label} getTransaction`, !!t && !t.meta?.err, `${solscan(sig)}${t?.meta?.err ? ' err=' + JSON.stringify(t.meta.err) : ''}`);
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
    return finish();
  }
  if (phase === 'crash') {
    await coordinator.executeTrade(await buildBuyRequest());
    rec('crash phase', false, 'process should have been killed after submit');
    return finish();
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
    chainErr: async (sig) => {
      const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      return t ? (t.meta?.err ?? null) : undefined;
    },
    buildBuyRequest, rec, link: solscan, sleep, connection: coordinator.getConnection() as any, rpcUrl: process.env.SOLANA_RPC_URL!,
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
  await S.waitPast(steps, revertedAt, riskEngine.getLimits().cooldownAfterFailedTradeMs, "failure cooldown from the (d') revert");
  const lastBuyAt = await S.sequentialBuysOneMint(steps);
  await S.waitPast(steps, lastBuyAt, riskEngine.getLimits().cooldownPerMintMs, "per-mint cooldown from the (e') buy");
  await S.ambiguousSendThroughApp(steps); // P1.5
  await S.waitPast(steps, Date.now(), riskEngine.getLimits().cooldownPerMintMs, "per-mint cooldown from the (e'') buy");
  await S.heldBlockhashStopLoss(steps); // P1.7
  const gDoneAt = Date.now();

  // (h) P1.6: opt-in, because moving a fresh curve past the -20% stop needs about 3.6 SOL sold into it (DEVNET_E2E_README.md)
  const dumpSol = Number(process.env.DEVNET_DUMP_SOL || 0);
  if (dumpSol > 0) {
    const have = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    if (have < dumpSol + 0.3) {
      rec('(h) funding for the dump', false, `DEVNET_DUMP_SOL=${dumpSol} needs at least ${(dumpSol + 0.3).toFixed(1)} SOL in ${kp.publicKey.toBase58()}; it has ${have.toFixed(3)}`);
    } else {
      const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
      const market = S.makeDumpMarket({ conn, payer: kp, web3, sdk: PUMP_SDK, curve: PumpCurveService, builder: txBuilder });
      await S.failedReadThenDumpStopLoss(steps, market, {
        seedSol: dumpSol,
        buildBuyRequestFor: async (m) => buildBuyRequestFor(m, await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: new PublicKey(m), executionMode: 'LIVE' }), true),
      });
    }
  } else {
    console.log('INFO  (h) skipped: set DEVNET_DUMP_SOL=5 and fund the throwaway wallet with at least 5.3 SOL to run the failed-read stop-loss step');
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
      const kit = S.makeChainKit({ conn, web3, sdk: PUMP_SDK, curve: PumpCurveService, builder: txBuilder });
      await S.creatorClusterOnChain(steps, kit, { snapshot: () => watchWindow.getSnapshot() }, kp);
    }
    watchWindow.stop();
    await pumpFeedListener.stop();
  } else {
    console.log('INFO  (i) skipped: set DEVNET_CLUSTER_CHECK=1 (needs about 0.4 SOL free, spends about 0.03) to run the creator-cluster and one-funder-cluster step');
  }

  await S.waitPast(steps, gDoneAt, riskEngine.getLimits().cooldownPerMintMs, 'per-mint cooldown from the (g) buy');
  await S.emergencyStopThroughApp(steps); // P1.4, last: it leaves LIVE disarmed and auto OFF. Telegram-path panic sells the LIVE position; kill switch on/off/re-arm buys nothing

  // (f) crash after submit, then recover in a fresh process on the same scratch DB
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

function finish() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} steps passed`);
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', safe(e?.stack || e));
  process.exit(1);
});
