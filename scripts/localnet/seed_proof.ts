/**
 * Proof run for scripts/devnet_seed.ts on the LOCAL chain (devnet is not reachable from the build container).
 *
 *   npm run localnet:seed
 *
 * The validator runs with LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS=1000000000 so the curve starts where devnet's Global does (1 SOL
 * virtual), not at the 30 SOL mainnet value. runSeed gets the LOCAL genesis hash as a library parameter; the CLI can only ever pass
 * devnet's. Checks: dry run sends nothing; create_v2 carries no buy; ~30 buys land inside the window; no sells anywhere; spend is
 * within the cap; and it prints the measured per-wallet cost the plan constants are calibrated from.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const ROOT = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-seed-'));
const checks: { name: string; ok: boolean; detail: string }[] = [];
const rec = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
const children: ChildProcess[] = [];

const freePort = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
async function freePortPair(): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const p = await freePort();
    try { await new Promise<void>((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(p + 1, '127.0.0.1', () => s.close(() => res())); }); return p; } catch { /* again */ }
  }
  throw new Error('no adjacent free ports');
}
const rpcCall = async (url: string, method: string, params: unknown[] = []) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};

async function main() {
  const vPort = await freePortPair();
  const v = spawn(process.execPath, ['--import', 'tsx', 'scripts/localnet/run_validator.ts', String(vPort)], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS: '1000000000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(v);
  v.stderr!.on('data', (d) => fs.appendFileSync(path.join(scratch, 'validator.log'), d));
  const info: { url: string; genesisHash: string } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('validator did not start')), 30_000);
    v.stdout!.on('data', (d) => { const line = String(d).split('\n').find((l) => l.startsWith('{')); if (line) { clearTimeout(t); resolve(JSON.parse(line)); } });
  });
  const conn = new Connection(info.url, 'confirmed');
  process.env.ALLOWED_CLUSTER = 'localnet'; process.env.LOCALNET_GENESIS_HASH = info.genesisHash; process.env.APEX_ENV_FILE = '';
  process.env.SOLANA_RPC_URL = info.url; process.env.APEX_DB_PATH = path.join(scratch, 'seed.db'); process.env.APEX_WAL_PATH = path.join(scratch, 'seed.wal');
  const { runSeed, HARD_CAP_SOL, SeedGuardError, SeedRunError, sweepFromFile } = await import('../devnet_seed');

  const funder = Keypair.generate();
  await conn.requestAirdrop(funder.publicKey, Math.round(0.7 * LAMPORTS_PER_SOL));
  const signer = { publicKey: funder.publicKey, sign: async (tx: any) => { tx.partialSign(funder); } };
  const stats0 = await rpcCall(info.url, 'localnet_stats', []);

  // 1. a guard refuses a different genesis before anything is sent
  try { await runSeed({ connection: conn, signer, allowedGenesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', dryRun: false }); rec('wrong genesis refused', false, 'did not throw'); }
  catch (e) { rec('wrong genesis refused', e instanceof SeedGuardError, String((e as Error).message).slice(0, 90)); }

  // 2. dry run sends nothing
  const sigsBefore = (await conn.getSignaturesForAddress(funder.publicKey)).length;
  const dry = await runSeed({ connection: conn, signer, allowedGenesis: info.genesisHash, dryRun: true, buyers: Number(process.env.SEED_PROOF_BUYERS || 30) });
  const sigsAfterDry = (await conn.getSignaturesForAddress(funder.publicKey)).length;
  rec('dry run sends nothing', dry.dryRun && sigsAfterDry === sigsBefore && dry.signatures.length === 0, `plan gross ${dry.plan.grossSol.toFixed(4)} SOL, signatures ${sigsAfterDry - sigsBefore}`);

  // 3. the real run
  const before = await conn.getBalance(funder.publicKey);
  const lines: string[] = [];
  const rep = await runSeed({ connection: conn, signer, allowedGenesis: info.genesisHash, dryRun: false, walletDir: path.join(scratch, 'main-wallets'), buyers: Number(process.env.SEED_PROOF_BUYERS || 30), log: (m) => { lines.push(m); console.log('  ' + m); } });
  const after = await conn.getBalance(funder.publicKey);
  const spent = (before - after) / LAMPORTS_PER_SOL;
  rec('spend within the hard cap', spent <= HARD_CAP_SOL && spent <= rep.plan.capSol, `funder spent ${spent.toFixed(4)} SOL (cap ${rep.plan.capSol}, hard ${HARD_CAP_SOL})`);
  rec('about 30 buys landed', rep.buysLanded >= 28, `${rep.buysLanded}/${rep.plan.buyers}${rep.buyers.filter((b) => b.error).length ? ' errors: ' + [...new Set(rep.buyers.filter((b) => b.error).map((b) => b.error))].join(' | ') : ''}`);
  // S6b: the rent constant the cost gate charges for a wallet's first pump buy must equal what the real program actually made the wallet pay.
  {
    const { userVolumeAccumulatorPda } = await import('@pump-fun/pump-sdk');
    const { PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS } = await import('../../server/risk/riskEngine');
    const firstBuyer = rep.buyers.find((b) => b.signature);
    const acc = firstBuyer ? await conn.getAccountInfo(userVolumeAccumulatorPda(new PublicKey(firstBuyer.wallet)), 'confirmed') : null;
    rec('first-buy rent constant equals the accumulator the program created', !!acc && acc.data.length === 137 && acc.lamports === PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS, acc ? `${acc.lamports} lamports, ${acc.data.length} bytes (constant ${PUMP_USER_VOLUME_ACCUMULATOR_RENT_LAMPORTS})` : 'no accumulator');
  }
  rec('buys inside about 30 s', (rep.buyWindowMs ?? 1e9) < 40_000, `${((rep.buyWindowMs ?? 0) / 1000).toFixed(1)} s`);

  // 4. what is in the transactions
  const logsOf = async (sig: string) => (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }))?.meta?.logMessages ?? [];
  const createLogs = await logsOf(rep.createSignature!);
  const createHasCreate = createLogs.some((l) => /Instruction: (CreateV2|Create)\b/.test(l));
  const createHasBuy = createLogs.some((l) => /Instruction: (Buy|ExtendAccount)/.test(l) && /Buy/.test(l));
  rec('create_v2 carries no buy', createHasCreate && !createHasBuy, `create ${createHasCreate}, buy ${createHasBuy}`);
  let sells = 0; const deltas: number[] = [];
  for (const b of rep.buyers) {
    if (!b.signature) continue;
    const tx = await conn.getTransaction(b.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if ((tx?.meta?.logMessages ?? []).some((l) => /Instruction: Sell/.test(l))) sells++;
    if (tx?.meta) deltas.push((tx.meta.preBalances[0] - tx.meta.postBalances[0]) / LAMPORTS_PER_SOL);
  }
  const allSigs = await conn.getSignaturesForAddress(new PublicKey(rep.mint!), { limit: 1000 });
  for (const s of allSigs) if ((await logsOf(s.signature)).some((l) => /Instruction: Sell/.test(l))) sells++;
  rec('no sells', sells === 0, `${sells} sell instructions across ${allSigs.length} mint transactions`);

  // 5. cost calibration
  const createTx = await conn.getTransaction(rep.createSignature!, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  const createCost = createTx?.meta ? (createTx.meta.preBalances[0] - createTx.meta.postBalances[0]) / LAMPORTS_PER_SOL : NaN;
  const maxBuy = deltas.length ? Math.max(...deltas) : Infinity, meanBuy = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
  console.log(`  measured: create tx cost ${createCost.toFixed(5)} SOL; buy tx wallet delta mean ${meanBuy.toFixed(5)} max ${maxBuy.toFixed(5)} (buy size ${rep.plan.buySol}); funded ${rep.plan.perBuyerFundSol} each; swept back ${rep.sweptSol?.toFixed(4)} SOL`);
  rec('every buyer was funded enough', maxBuy <= rep.plan.perBuyerFundSol, `max wallet outlay ${maxBuy.toFixed(5)} <= funded ${rep.plan.perBuyerFundSol}`);
  rec('planned create cost covers the measured one', createCost <= rep.plan.createCostSol, `${createCost.toFixed(5)} <= ${rep.plan.createCostSol}`);

  // 6. what the seeded token looks like to the app: one funder, ~30 buyers
  const { PumpCurveService } = await import('../../server/solana/pumpCurve');
  const st = await PumpCurveService.fetchPumpMarketState({ connection: conn, mint: new PublicKey(rep.mint!), executionMode: 'LIVE' });
  const realSol = st ? Number((st as any).realSolReserves ?? 0) / LAMPORTS_PER_SOL : NaN;
  console.log(`  curve after seeding: real SOL ${realSol.toFixed(4)}; buyers funded by ONE wallet (${rep.funder.slice(0, 6)}...), so the funder-cluster rule counts them as 1 buyer`);
  const stats1 = await rpcCall(info.url, 'localnet_stats', []);
  console.log(`  chain stats before/after: ${JSON.stringify(stats0)} -> ${JSON.stringify(stats1)}`);

  // 7. the failure that hit the first devnet run: the RPC rate-limits (429) after the wallets are funded. The run must fail, hand the money back, and leave the keys.
  {
    const f2 = Keypair.generate();
    await conn.requestAirdrop(f2.publicKey, Math.round(0.7 * LAMPORTS_PER_SOL));
    const signer2 = { publicKey: f2.publicKey, sign: async (tx: any) => { tx.partialSign(f2); } };
    let sends = 0, outage = 0, balOutage = 0;
    const flaky = new Proxy(conn, { get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        if (p === 'sendRawTransaction' && ++sends === 3) outage = 8; // create, fund batch 1, fund batch 2 are through; the next blockhash fetch is 429 for a whole retry budget
        if (p === 'getLatestBlockhash' && outage > 0) { if (--outage === 0) balOutage = 2; return Promise.reject(new Error('429 Too Many Requests')); }
        if (p === 'getBalance' && balOutage > 0) { balOutage--; return Promise.reject(new Error('429 Too Many Requests')); }
        return Reflect.apply(v as any, t, a);
      };
    } }) as Connection;
    const dir = path.join(scratch, 'seed-wallets');
    const f2Before = await conn.getBalance(f2.publicKey);
    let err: any; const logs: string[] = [];
    try { await runSeed({ connection: flaky, signer: signer2, allowedGenesis: info.genesisHash, dryRun: false, walletDir: dir, minSendGapMs: 20, retry: { baseMs: 20, maxMs: 100 }, log: (m) => logs.push(m) }); } catch (e) { err = e; }
    rec('429 mid-funding makes the run fail (not hang or pass)', err instanceof SeedRunError, err ? String(err.message).slice(0, 110) : 'no error');
    const swept = err instanceof SeedRunError ? err.sweptSol : 0;
    const file = err instanceof SeedRunError ? err.walletFile : undefined;
    rec('buyer keys were on disk before funding (0600, 30 wallets)', !!file && fs.existsSync(file) && (fs.statSync(file).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(file, 'utf8')).wallets.length === 30, file ? path.basename(file) : 'no file');
    rec('retries absorbed the first 429s (logged)', logs.some((l) => l.startsWith('retry getLatestBlockhash')) && logs.some((l) => l.startsWith('retry getBalance')), `${logs.filter((l) => l.startsWith('retry')).length} retry lines`);
    rec('the 20 funded wallets were swept back automatically', swept > 0.28, `swept ${swept.toFixed(4)} SOL (20 wallets x ${0.0147})`);
    let stranded = 0;
    if (file) { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); for (const w of saved.wallets) stranded += await conn.getBalance(new PublicKey(w.publicKey)); }
    rec('no SOL left in the buyer wallets', stranded === 0, `${stranded} lamports stranded`);
    const f2After = await conn.getBalance(f2.publicKey);
    rec('funder lost only fees and the create cost', (f2Before - f2After) / LAMPORTS_PER_SOL < 0.01, `net ${((f2Before - f2After) / LAMPORTS_PER_SOL).toFixed(5)} SOL`);
    if (file) {
      const again = await sweepFromFile({ connection: conn, allowedGenesis: info.genesisHash, file, minSendGapMs: 20, sleep: async () => undefined });
      rec('--sweep on the saved file finds nothing more to recover', again.sweptSol === 0 && again.wallets === 30, `${again.wallets} wallets, ${again.sweptSol} SOL`);
      // a wallet funded by hand after the fact is recovered by --sweep alone (the killed-process case)
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      await conn.requestAirdrop(new PublicKey(saved.wallets[0].publicKey), 20_000_000);
      const rec2 = await sweepFromFile({ connection: conn, allowedGenesis: info.genesisHash, file, minSendGapMs: 20, sleep: async () => undefined });
      rec('--sweep recovers SOL from a saved file', rec2.sweptSol > 0.019, `${rec2.sweptSol.toFixed(4)} SOL back to ${rec2.funder.slice(0, 6)}...`);
    }
  }

  // 8. S29: --make-funder creates and funds the separate seed funder from the "app" wallet; the seed then runs from it and never touches the app wallet.
  {
    const { makeFunder, loadFunderKeypair, MAX_MAKE_FUNDER_SOL } = await import('../devnet_seed');
    const appKp = Keypair.generate();
    await conn.requestAirdrop(appKp.publicKey, 1 * LAMPORTS_PER_SOL);
    const appSigner = { publicKey: appKp.publicKey, sign: async (tx: any) => { tx.partialSign(appKp); } };
    const keyFile = path.join(scratch, 'funder-dir', 'seed-funder.json');
    const appBefore = await conn.getBalance(appKp.publicKey);
    let refusedWrong = false;
    try { await makeFunder({ connection: conn, signer: appSigner, allowedGenesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', file: keyFile, fundSol: 0.2, autoOffConfirmed: true }); } catch { refusedWrong = true; }
    rec('make-funder refuses a different genesis: no key written, nothing sent', refusedWrong && !fs.existsSync(keyFile) && (await conn.getBalance(appKp.publicKey)) === appBefore, 'refused');
    const made = await makeFunder({ connection: conn, signer: appSigner, allowedGenesis: info.genesisHash, file: keyFile, fundSol: 0.2, autoOffConfirmed: true, sleep: async () => undefined });
    const fundedLamports = await conn.getBalance(new PublicKey(made.pubkey));
    const appAfter = await conn.getBalance(appKp.publicKey);
    rec('make-funder: the new wallet holds exactly the amount; the app wallet paid it plus one fee', fundedLamports === 200_000_000 && appBefore - appAfter === 200_000_000 + 5000, `funder ${fundedLamports} lamports, app paid ${appBefore - appAfter}`);
    rec('make-funder: key file 0600 in a 0700 directory, matches the printed public key', (fs.statSync(keyFile).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(keyFile)).mode & 0o777) === 0o700 && loadFunderKeypair(keyFile).publicKey.toBase58() === made.pubkey, made.pubkey.slice(0, 6) + '...');
    let overCap = false;
    try { await makeFunder({ connection: conn, signer: appSigner, allowedGenesis: info.genesisHash, file: path.join(scratch, 'funder-dir', 'over.json'), fundSol: MAX_MAKE_FUNDER_SOL + 0.01, autoOffConfirmed: true }); } catch { overCap = true; }
    rec('make-funder refuses more than the cap', overCap && !fs.existsSync(path.join(scratch, 'funder-dir', 'over.json')), `cap ${MAX_MAKE_FUNDER_SOL} SOL`);
    const fk = loadFunderKeypair(keyFile);
    const appMid = await conn.getBalance(appKp.publicKey);
    const seeded = await runSeed({ connection: conn, signer: { publicKey: fk.publicKey, sign: async (tx: any) => { tx.partialSign(fk); } }, allowedGenesis: info.genesisHash, dryRun: false, walletDir: path.join(scratch, 'mf-wallets'), buyers: 3, minSendGapMs: 20, sleep: async () => undefined });
    rec('a seed run paid from the made funder lands its buys and leaves the app wallet untouched', seeded.buysLanded === 3 && (await conn.getBalance(appKp.publicKey)) === appMid, `${seeded.buysLanded}/3 landed, app wallet change ${(await conn.getBalance(appKp.publicKey)) - appMid} lamports`);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nSEED_PROOF ${failed.length ? 'FAILED: ' + failed.map((f) => f.name).join(', ') : 'OK'} (${checks.length} checks)`);
  return failed.length ? 1 : 0;
}

main().then((c) => { children.forEach((p) => p.kill()); process.exit(c); }).catch((e) => { console.error(e); children.forEach((p) => p.kill()); process.exit(1); });
