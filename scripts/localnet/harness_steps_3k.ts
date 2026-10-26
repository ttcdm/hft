/**
 * Localnet dry run of the devnet harness's Stage 3 steps for task 3K: (m) for 3B, (o) for 3E and (p) for 3F in scripts/devnet_e2e_steps.ts, the same
 * functions `npm run devnet:e2e` runs, against the LiteSVM local validator (real pump.fun program binaries, scripts/localnet/validator.ts).
 *
 *   npx tsx scripts/localnet/harness_steps_3k.ts            (prints PASS/FAIL/SKIP lines, exits 1 on any FAIL)
 *   APEX_3K_ONLY=m, o or p                                   (one step only)
 *
 * Built like scripts/localnet/harness_steps.ts (3I): the app's coordinator, auto controller and watch window run in this process for (m);
 * (o) boots server.ts in child processes on its own scratch DB and its own throwaway signer. Everything is loopback; ALLOWED_CLUSTER=localnet
 * with the validator's genesis hash, throwaway keys funded only by the local airdrop, external feeds off, no .env read (hermeticEnv). Every
 * temp wallet's key is written under <scratch>/temp-wallets before it is funded, and the run checks they all end empty.
 */
import '../hermeticEnv';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-3k-steps-'));
const tempWalletDir = path.join(scratch, 'temp-wallets');
const only = process.env['APEX_3K_ONLY'] ?? '';
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

  Object.assign(process.env, {
    ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: info.genesisHash, SOLANA_RPC_URL: info.url, APEX_ENV_FILE: '',
    APEX_DB_PATH: path.join(scratch, 'app.db'), SIGNER_KEYPAIR_PATH: keyPath, LOCALNET_SOL_PRICE_USD: '150',
    ALLOW_LIVE_REAL_MONEY_TRADING: 'true', APEX_DISABLE_EXTERNAL_FEEDS: 'true', STARTUP_GRACE_PERIOD_MS: '0', ENABLE_RPC_FALLBACK: 'true',
    JITO_BLOCK_ENGINE_URL: '',
    MIN_LIQUIDITY_USD: '0', // as devnet_e2e.ts sets it: a fresh curve's real SOL is below the mainnet minimum
  });
  const S = await import('../devnet_e2e_steps');
  const { PUMP_SDK } = await import('@pump-fun/pump-sdk');
  const { PumpCurveService } = await import('../../server/solana/pumpCurve');
  const { txBuilder } = await import('../../server/solana/transactionBuilder');
  const { executionCoordinator: coordinator } = await import('../../server/execution/coordinator');
  const { workstationDb } = await import('../../server/db/database');
  const { solPriceService } = await import('../../server/market/solPriceService');
  const { awaitSolPrice } = await import('../devnet_funding');
  const { watchWindow } = await import('../../server/signals/watchWindow');
  const { autoSnipeController } = await import('../../server/auto/controller');
  const { memecoinAggregator } = await import('../../server/memecoinAggregator');

  const price = await awaitSolPrice(solPriceService);
  rec('SOL/USD price (LOCALNET_FIXED)', price.ok, String(price.usd));
  coordinator.start();
  await coordinator.syncRealWalletBalance();
  let armed = { success: false, message: 'not tried' };
  for (let i = 0; i < 60 && !armed.success; i++) { armed = coordinator.armLiveTrading(true, 'CONFIRM_LIVE_TRADING_RISK'); if (!armed.success) await sleep(1000); }
  rec('arm LIVE (localnet)', armed.success, armed.message);

  const kit = S.makeChainKit({ conn, web3, sdk: PUMP_SDK, curve: PumpCurveService, builder: txBuilder, keyDir: tempWalletDir });
  const bal = async () => (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
  const steps = { coordinator, rec, sleep, skip: (step: string, detail: string) => rec(`${step} (a SKIP in the dry run)`, false, detail) };

  if (!only || only === 'm') {
    if (armed.success && (await S.hasBudget(steps, '(m) 3B: DEVNET_LIVE session spend', bal, 0.25, 'DEVNET_SESSION_SPEND'))) {
      const coins = S.stepCoins(steps, '(m) 3B: DEVNET_LIVE session spend', kit, kp);
      const b0 = await bal();
      await S.sessionSpendMatchesWallet(steps, {
        auto: autoSnipeController as any,
        watch: watchWindow as any,
        confluence: memecoinAggregator,
        balanceLamports: () => conn.getBalance(kp.publicKey),
        haltReason: () => coordinator.getHaltReason(),
        openLive: () => workstationDb.loadPositions('LIVE', 'ACTIVE'),
        makeCoins: (n) => coins.make(n),
        cleanupCoins: () => coins.cleanup(),
      });
      console.log(`INFO  (m) cost the harness wallet ${(b0 - (await bal())).toFixed(5)} SOL`);
    }
  }
  if (!only || only === 'p') {
    const L = '(p) 3F: no re-entry after an exit';
    if (armed.success && (await S.hasBudget(steps, L, bal, 0.05, 'DEVNET_REENTRY_BLOCK'))) {
      const { liveBuyRequest } = await import('../devnet_funding');
      const { riskEngine } = await import('../../server/risk/riskEngine');
      let creator: any = null;
      const b0 = await bal();
      await S.reentryBlockedAfterExit({
        ...steps, curve: PumpCurveService, db: workstationDb as any, riskLimits: () => riskEngine.getLimits(), mint: '', chainErr: async () => undefined,
        buildBuyRequest: async () => { throw new Error('unused'); }, link: (sig: string) => sig.slice(0, 16),
      }, {
        makeCoin: () => S.makeHarnessCoin(steps, L, { kit, creator: () => (creator ??= kit.newWallet()), payer: kp }),
        buildBuyRequestFor: async (m) => liveBuyRequest(m, 0.01, Date.now()),
        position: (id) => workstationDb.loadPositions().find((p) => p.id === id),
        balanceLamports: () => conn.getBalance(kp.publicKey),
        auto: autoSnipeController,
      });
      console.log(`INFO  (p) cost the harness wallet ${(b0 - (await bal())).toFixed(5)} SOL`);
    }
  }
  coordinator.armLiveTrading(false);

  if (!only || only === 'o') {
    const L = '(o) 3E: kill survives a restart';
    if (await S.hasBudget(steps, L, bal, 0.2, 'DEVNET_KILL_RESTART')) {
      const crypto = await import('node:crypto');
      const { WorkstationDatabase } = await import('../../server/db/database');
      const signer = kit.newWallet(); // the step's own server signer: its key is on disk before it is funded
      const creator = kit.newWallet();
      const relay = await S.startSendHoldingRelay(info.url);
      const dbPath = path.join(scratch, 'o-app.db');
      const token = crypto.randomBytes(24).toString('hex');
      let mint = '';
      const b0 = await bal();
      await S.killSurvivesRestart(steps, {
        boot: () => S.spawnServer({
          token, logFile: path.join(scratch, 'o-server.log'),
          env: {
            PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? scratch, NODE_ENV: 'production', APEX_ENV_FILE: '',
            ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: info.genesisHash, SOLANA_RPC_URL: relay.url, SOLANA_WS_URL: relay.wsUrl,
            JITO_BLOCK_ENGINE_URL: '', ENABLE_RPC_FALLBACK: 'true', APEX_DB_PATH: dbPath, SIGNER_KEYPAIR_PATH: path.join(tempWalletDir, `${signer.publicKey.toBase58()}.json`),
            LOCALNET_SOL_PRICE_USD: '150', ALLOW_LIVE_REAL_MONEY_TRADING: 'true', APEX_DISABLE_EXTERNAL_FEEDS: 'true', STARTUP_GRACE_PERIOD_MS: '0',
            MIN_LIQUIDITY_USD: '0', AUTO_SNIPE_ENABLED: 'true',
          },
        }),
        relay,
        get buyBody() { return { mint, symbol: 'O3K', name: '3K harness', amountSol: 0.01, confirmLive: true }; },
        plantAutoOwned: (positionId, m) => {
          const db = new WorkstationDatabase(dbPath);
          db.logDecision({ autoMode: 'DEVNET_LIVE', mint: m, source: 'TEST', stage: 'fill', outcome: 'BOUGHT', reason: 'e2e (o): marks the hand-bought position auto-owned', positionId });
          (db as any).db.close();
        },
        fund: async () => {
          await kit.transfer(kp, signer.publicKey, 0.15); // the 10% spendable ceiling: a 0.01 SOL buy needs about 0.12 in the wallet
          await kit.transfer(kp, creator.publicKey, 0.03);
          mint = (await kit.create(creator, 'O3K', '3K harness')).mint;
        },
        cleanup: async () => {
          const errors: string[] = [];
          try { await relay.close(); } catch (e: any) { errors.push(`relay close: ${String(e?.message ?? e).slice(0, 80)}`); }
          for (const w of [signer, creator]) { // each wallet on its own: one failed refund does not skip the other
            if (mint) { try { await kit.sellAll(w, mint); } catch { /* nothing held */ } }
            try { await kit.refund(w, kp.publicKey); } catch (e: any) { errors.push(`refund ${w.publicKey.toBase58()}: ${String(e?.message ?? e).slice(0, 80)}`); }
          }
          if (errors.length) throw new Error(errors.join('; '));
        },
      });
      console.log(`INFO  (o) cost the harness wallet ${(b0 - (await bal())).toFixed(5)} SOL`);
    }
  }

  // Every temp wallet written to disk ends empty (refunded, less nothing but dust under one fee).
  const left: string[] = [];
  const files = fs.existsSync(tempWalletDir) ? fs.readdirSync(tempWalletDir) : [];
  for (const f of files) {
    const w = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(tempWalletDir, f), 'utf8'))));
    const l = await conn.getBalance(w.publicKey);
    if (l > 5000) left.push(`${f}: ${l}`);
  }
  rec('every temp wallet refunded (at most one fee of dust left)', left.length === 0, `${files.length} key file(s) in ${tempWalletDir}${left.length ? `; holding SOL: ${left.join(', ')}` : ''}`);

  coordinator.cleanup();
}

main()
  .catch((e) => rec('dry-run error', false, String(e?.stack ?? e).slice(0, 800)))
  .finally(() => {
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} steps passed (scratch ${scratch})`);
    process.exit(bad.length ? 1 : 0);
  });
