/**
 * Localnet dry run of the devnet harness's Stage 3 steps (task 3I): (s), (t), (u) and (n) in scripts/devnet_e2e_steps.ts, the same functions
 * `npm run devnet:e2e` runs, against the LiteSVM local validator (real pump.fun program binaries, scripts/localnet/validator.ts).
 *
 *   npx tsx scripts/localnet/harness_steps.ts            (prints PASS/FAIL lines, exits 1 on any FAIL)
 *
 * The app's coordinator, feed listener, watch window and funder lookup run in this process, wired as devnet_e2e.ts wires them; the
 * validator runs in its own process (LiteSVM's allocator does not survive sharing a process with the server modules). Safety: everything
 * is loopback. ALLOWED_CLUSTER=localnet with the validator's own genesis hash, a scratch DB and a throwaway key funded only by the local
 * airdrop, external feeds off, no .env read (hermeticEnv). Every temp wallet's key is written under <scratch>/temp-wallets before it is
 * funded, as on devnet, and the run checks they all end empty.
 */
import '../hermeticEnv';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-3i-steps-'));
const tempWalletDir = path.join(scratch, 'temp-wallets');
const results: { step: string; ok: boolean; detail: string }[] = [];
const rec = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePortPair(): Promise<number> {
  const one = (p: number) => new Promise<number>((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(p, '127.0.0.1', () => { const got = (s.address() as net.AddressInfo).port; s.close(() => res(got)); });
  });
  return (async () => {
    for (let i = 0; i < 50; i++) {
      const p = await one(0);
      try { await one(p + 1); return p; } catch { /* taken: try again */ }
    }
    throw new Error('no adjacent free ports');
  })();
}

async function main() {
  const port = await freePortPair();
  const validator = spawn(process.execPath, ['--import', 'tsx', 'scripts/localnet/run_validator.ts', String(port)], {
    cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? scratch }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const vlog = path.join(scratch, 'validator.log');
  validator.stderr!.on('data', (d) => fs.appendFileSync(vlog, d));
  const info: { url: string; genesisHash: string } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('validator did not start')), 60_000);
    validator.stdout!.on('data', (d) => {
      fs.appendFileSync(vlog, d);
      const line = String(d).split('\n').find((l) => l.startsWith('{'));
      if (line) { clearTimeout(t); resolve(JSON.parse(line)); }
    });
  });
  try {
    await run(info);
  } finally {
    validator.kill('SIGTERM');
  }
}

async function run(info: { url: string; genesisHash: string }) {
  const web3 = await import('@solana/web3.js');
  const { Keypair, Connection, LAMPORTS_PER_SOL } = web3;
  const conn = new Connection(info.url, 'confirmed');
  const kp = Keypair.generate();
  const keyPath = path.join(scratch, 'throwaway-keypair.json');
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  await conn.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);

  // The environment the app's modules read at import: the same shape as tests/helpers/localnetChain.ts's server env.
  Object.assign(process.env, {
    ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: info.genesisHash, SOLANA_RPC_URL: info.url, APEX_ENV_FILE: '',
    APEX_DB_PATH: path.join(scratch, 'app.db'), SIGNER_KEYPAIR_PATH: keyPath, LOCALNET_SOL_PRICE_USD: '150',
    ALLOW_LIVE_REAL_MONEY_TRADING: 'true', APEX_DISABLE_EXTERNAL_FEEDS: 'true', STARTUP_GRACE_PERIOD_MS: '0', ENABLE_RPC_FALLBACK: 'true',
    JITO_BLOCK_ENGINE_URL: '',
  });
  const S = await import('../devnet_e2e_steps');
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { PumpCurveService } = await import('../../server/solana/pumpCurve');
  const { txBuilder } = await import('../../server/solana/transactionBuilder');
  const { executionCoordinator: coordinator } = await import('../../server/execution/coordinator');
  const { workstationDb } = await import('../../server/db/database');
  const { riskEngine } = await import('../../server/risk/riskEngine');
  const { solPriceService } = await import('../../server/market/solPriceService');
  const { liveBuyRequest, awaitSolPrice } = await import('../devnet_funding');
  const { watchWindow } = await import('../../server/signals/watchWindow');
  const { pumpFeedListener } = await import('../../server/solana/pumpFeedListener');
  const { FunderLookup, wireFunderLookup } = await import('../../server/signals/funderLookup');
  const { PUMPFUN_PROGRAM_ID } = await import('../../server/solana/programs');

  const price = await awaitSolPrice(solPriceService);
  rec('SOL/USD price (LOCALNET_FIXED)', price.ok, String(price.usd));
  coordinator.start();
  await coordinator.syncRealWalletBalance();
  let armed = { success: false, message: 'not tried' };
  for (let i = 0; i < 60 && !armed.success; i++) { armed = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK'); if (!armed.success) await sleep(1000); }
  rec('arm LIVE (localnet)', armed.success, armed.message);

  const kit = S.makeChainKit({ conn, web3, sdk: PUMP_SDK, curve: PumpCurveService, builder: txBuilder, keyDir: tempWalletDir });
  const bal = async () => (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;

  // A coin for (s), made by a throwaway creator (no buy: (s) never reaches the quote).
  const c0 = kit.newWallet();
  await kit.transfer(kp, c0.publicKey, 0.05);
  const coin = await kit.create(c0, 'S3IA', 'S3I harness');
  const steps: import('../devnet_e2e_steps').HarnessSteps = {
    coordinator, curve: PumpCurveService, db: workstationDb as any, riskLimits: () => riskEngine.getLimits(), mint: coin.mint,
    chainErr: async () => undefined, buildBuyRequest: async () => liveBuyRequest(coin.mint, 0.01, Date.now()),
    rec, link: (sig) => sig.slice(0, 16),
    // the dry run injects only what the steps must ride out, so a SKIP here is a failure
    skip: (step, detail) => rec(`${step} (a SKIP in the dry run)`, false, detail), sleep, rpcUrl: info.url,
    get connection() { return coordinator.getConnection() as any; },
  };

  if (armed.success) await S.unreadableReservesRefused(steps);
  // The control: the same buy without the wrapper gets past the curve-progress check (it is not refused CURVE_PROGRESS_UNREADABLE),
  // so the refusal above came from the stripped reserves. A coin with only its creator fails eligibility later; nothing is sent then.
  const control = armed.success ? await coordinator.executeTrade(liveBuyRequest(coin.mint, 0.01, Date.now())) : null;
  rec('(s) control: without the wrapper the buy is not refused CURVE_PROGRESS_UNREADABLE', !!control && !/CURVE_PROGRESS_UNREADABLE/.test(control.error ?? ''), `${control?.lifecycleState} ${control?.error ?? ''}`.slice(0, 200));
  for (const p of workstationDb.loadPositions().filter((x) => x.mint === coin.mint && x.status !== 'CLOSED')) await coordinator.closePosition(p.id, 100, 'dry-run cleanup');
  coordinator.armLiveTrading(false);
  try { await kit.refund(c0, kp.publicKey); } catch (e: any) { rec('(s) refund of the coin creator', false, String(e?.message ?? e)); }

  watchWindow.attach(pumpFeedListener);
  wireFunderLookup(watchWindow, new FunderLookup(() => coordinator.getConnection()));
  watchWindow.start();

  const b0 = await bal();
  if (await S.hasBudget(steps, '(t) B7/B10: two quick RPC switches', bal, 0.1, 'DEVNET_FEED_SWITCH')) {
    await S.rpcSwitchMovesFeed(steps, {
      listener: pumpFeedListener as any, coordinator, Connection, pumpProgramId: PUMPFUN_PROGRAM_ID.toBase58(), rpcUrl: info.url,
      feed: { snapshot: () => watchWindow.getSnapshot() }, kit, payer: kp,
    });
  }
  const b1 = await bal();
  console.log(`INFO  (t) cost the harness wallet ${(b0 - b1).toFixed(5)} SOL`);

  const subscribed = await pumpFeedListener.start();
  rec('(u) B3: the pump log stream subscribed', subscribed, `status ${pumpFeedListener.getTelemetry().status}`);
  if (subscribed && (await S.hasBudget(steps, '(u) B3: a seller that never bought', bal, 0.15, 'DEVNET_SELLER_NEVER_BOUGHT'))) {
    await S.sellerWhoNeverBought(steps, kit, { snapshot: () => watchWindow.getSnapshot() }, kp);
  }
  const b2 = await bal();
  console.log(`INFO  (u) cost the harness wallet ${(b1 - b2).toFixed(5)} SOL`);
  watchWindow.stop();
  await pumpFeedListener.stop();

  // (n) 3C: a coin the app's own filters accept (a creator buy and 14 buyers, funded by the local airdrop: market setup, not harness
  // wallets), then the loss-floor step through executeTrade, then the child boot with MAX_POSITION_SIZE_SOL=abc.
  {
    const { executionConfig } = await import('../../server/solana/executionConfig');
    const { autoSnipeController } = await import('../../server/auto/controller');
    const mkt = Keypair.generate();
    await conn.requestAirdrop(mkt.publicKey, 2 * LAMPORTS_PER_SOL);
    const seeded = await kit.create(mkt, 'N3CL', 'S3C harness');
    await kit.buy(mkt, seeded.mint, 0.2);
    for (let i = 0; i < 14; i++) {
      const w = Keypair.generate();
      await conn.requestAirdrop(w.publicKey, 2 * LAMPORTS_PER_SOL);
      await kit.buy(w, seeded.mint, 0.6);
    }
    // Run 16 on devnet: a 429 on the balance sync right before the clearDailyLossLatch buy. The resume below has the validator answer the
    // next two getBalance reads with HTTP 429 (under the kill switch's 3), and the step's next sync waits until the validator took that.
    let failReads: Promise<unknown> | null = null;
    const nSync = async () => { if (failReads) { await failReads; failReads = null; } return coordinator.syncRealWalletBalance(); };
    const nCoordinator = new Proxy(coordinator, {
      get: (t, k) => (k === 'syncRealWalletBalance' ? nSync : typeof (t as any)[k] === 'function' ? (t as any)[k].bind(t) : (t as any)[k]),
    });
    const nSteps = { ...steps, coordinator: nCoordinator, mint: seeded.mint, buildBuyRequest: async () => liveBuyRequest(seeded.mint, 0.01, Date.now()) } as typeof steps;
    for (let i = 0; i < 30 && !coordinator.isLiveArmed(); i++) { coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK'); if (!coordinator.isLiveArmed()) await sleep(1000); }
    if (await S.hasBudget(nSteps, '(n) 3C: net daily PnL floor', bal, 0.05, 'DEVNET_LOSS_FLOOR')) {
      const bn = await bal();
      await S.lossFloorLatch(nSteps, {
        floorUsd: () => executionConfig.getConfig().maxDailyLossUsd,
        setFloorUsd: (usd) => { executionConfig.updateConfig({ maxDailyLossUsd: usd }); },
        price: () => solPriceService.getPrice(),
        refreshPrice: () => solPriceService.refresh(),
        dailyPnlSol: () => riskEngine.getDailyTotalPnLSol('LIVE'),
        latch: () => riskEngine.getDailyLossLatch('LIVE'),
        clearLatch: () => riskEngine.clearDailyLossLatch(),
        resume: (o) => {
          if (o.clearDailyLossLatch) {
            failReads = fetch(info.url, { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'localnet_failNextReads', params: [2, 'getBalance', null, 'http429'] }) }).then((r) => r.json());
          }
          return autoSnipeController.resume(o);
        },
        orderSol: 0.01,
      });
      console.log(`INFO  (n) cost the harness wallet ${(bn - (await bal())).toFixed(5)} SOL`);
      rec('(n) cleanup: MAX_DAILY_LOSS_USD back to the tier default, latch clear', executionConfig.getConfig().maxDailyLossUsd === 7 && riskEngine.getDailyLossLatch('LIVE') === null, `MAX_DAILY_LOSS_USD ${executionConfig.getConfig().maxDailyLossUsd}`);
    }
    coordinator.armLiveTrading(false);
    const bootDb = path.join(scratch, 'boot-check-abc.db');
    S.bootRefusesBadLimit(steps, () => spawnSync(process.execPath, ['--require', path.resolve('scripts/devnet_guard.cjs'), '--import', 'tsx', 'server.ts'], {
      encoding: 'utf8', timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? scratch, APEX_ENV_FILE: '', NODE_ENV: 'production', APP_PORT: '0',
        ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: info.genesisHash, SOLANA_RPC_URL: info.url, APEX_DB_PATH: bootDb,
        SIGNER_KEYPAIR_PATH: path.join(scratch, 'no-such-key.json'), APEX_DISABLE_EXTERNAL_FEEDS: 'true', MAX_POSITION_SIZE_SOL: 'abc',
      },
    }), bootDb);
  }

  // Underfunded: the budget check refuses and no wallet is made.
  const before = fs.readdirSync(tempWalletDir).length;
  const refused: { step: string; ok: boolean }[] = [];
  const ok = await S.hasBudget({ rec: (step, o) => refused.push({ step, ok: o }) }, '(u) B3: a seller that never bought', bal, 1_000, 'DEVNET_SELLER_NEVER_BOUGHT');
  rec('underfunded: the budget check refuses, no temp wallet made', !ok && refused.length === 1 && !refused[0].ok && fs.readdirSync(tempWalletDir).length === before, JSON.stringify(refused));

  // Every temp wallet written to disk ends empty (refunded, less nothing but dust under one fee).
  const left: string[] = [];
  for (const f of fs.readdirSync(tempWalletDir)) {
    const w = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(tempWalletDir, f), 'utf8'))));
    const l = await conn.getBalance(w.publicKey);
    if (l > 5000) left.push(`${f}: ${l}`);
  }
  rec('every temp wallet refunded (at most one fee of dust left)', left.length === 0, `${fs.readdirSync(tempWalletDir).length} key file(s) in ${tempWalletDir}${left.length ? `; holding SOL: ${left.join(', ')}` : ''}`);

  coordinator.cleanup();
}

main()
  .catch((e) => rec('dry-run error', false, String(e?.stack ?? e).slice(0, 800)))
  .finally(() => {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} steps passed (scratch ${scratch})`);
    process.exit(bad.length ? 1 : 0);
  });
