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
  const { runSeed, planSeed, HARD_CAP_SOL, SeedGuardError } = await import('../devnet_seed');

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
  const rep = await runSeed({ connection: conn, signer, allowedGenesis: info.genesisHash, dryRun: false, buyers: Number(process.env.SEED_PROOF_BUYERS || 30), log: (m) => { lines.push(m); console.log('  ' + m); } });
  const after = await conn.getBalance(funder.publicKey);
  const spent = (before - after) / LAMPORTS_PER_SOL;
  rec('spend within the hard cap', spent <= HARD_CAP_SOL && spent <= rep.plan.capSol, `funder spent ${spent.toFixed(4)} SOL (cap ${rep.plan.capSol}, hard ${HARD_CAP_SOL})`);
  rec('about 30 buys landed', rep.buysLanded >= 28, `${rep.buysLanded}/${rep.plan.buyers}${rep.buyers.filter((b) => b.error).length ? ' errors: ' + [...new Set(rep.buyers.filter((b) => b.error).map((b) => b.error))].join(' | ') : ''}`);
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

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nSEED_PROOF ${failed.length ? 'FAILED: ' + failed.map((f) => f.name).join(', ') : 'OK'} (${checks.length} checks)`);
  return failed.length ? 1 : 0;
}

main().then((c) => { children.forEach((p) => p.kill()); process.exit(c); }).catch((e) => { console.error(e); children.forEach((p) => p.kill()); process.exit(1); });
