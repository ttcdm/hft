/**
 * Proof that seeding from a SEPARATE wallet leaves the app's wallet audit quiet, and that seeding from the APP wallet does not.
 *
 *   npm run localnet:seed-audit
 *
 * The app (server.ts) runs in DEVNET_LIVE auto mode against the LiteSVM validator; its monitor calls auditWallet every 5 s, and an
 * unexplained wallet change halts all trading. Run A seeds (runSeed, 8 buyers) from a separate funder: the app must stay in
 * DEVNET_LIVE with no HALT_ALL. Run B (the control) seeds from the app's own wallet: the audit must halt. Without B, A could pass
 * because the audit never looked. Loopback only, throwaway keys.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

const ROOT = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-seedaudit-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: { name: string; ok: boolean }[] = [];
const rec = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
const children: ChildProcess[] = [];
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
  const f = path.join(scratch, `${name}.log`);
  c.stdout!.on('data', (d) => fs.appendFileSync(f, d)); c.stderr!.on('data', (d) => fs.appendFileSync(f, d));
  children.push(c);
  return c;
}

async function main() {
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const vPort = await freePortPair();
  const validator = startProc('validator', ['--import', 'tsx', 'scripts/localnet/run_validator.ts', String(vPort)], { ...baseEnv, LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS: '1000000000' });
  const info: { url: string; genesisHash: string } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('validator did not start')), 30_000);
    validator.stdout!.on('data', (d) => { const line = String(d).split('\n').find((l) => l.startsWith('{')); if (line) { clearTimeout(t); resolve(JSON.parse(line)); } });
  });
  const conn = new Connection(info.url, 'confirmed');
  const appWallet = Keypair.generate(), seedFunder = Keypair.generate();
  const keyPath = path.join(scratch, 'app-keypair.json');
  fs.writeFileSync(keyPath, JSON.stringify(Array.from(appWallet.secretKey)), { mode: 0o600 });
  await conn.requestAirdrop(appWallet.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.requestAirdrop(seedFunder.publicKey, Math.round(0.7 * LAMPORTS_PER_SOL));

  process.env.ALLOWED_CLUSTER = 'localnet'; process.env.LOCALNET_GENESIS_HASH = info.genesisHash; process.env.APEX_ENV_FILE = '';
  process.env.SOLANA_RPC_URL = info.url; process.env.APEX_DB_PATH = path.join(scratch, 'driver.db');
  const { runSeed } = await import('../devnet_seed');

  const token = crypto.randomBytes(24).toString('hex');
  const port = await freePort();
  startProc('server', ['--import', 'tsx', 'server.ts'], {
    ...baseEnv, NODE_ENV: 'production', APP_PORT: String(port), OPERATOR_AUTH_TOKEN: token, OPERATOR_PASSWORD: 'localnet-seed-audit', APEX_ENV_FILE: '',
    ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: info.genesisHash, SOLANA_RPC_URL: info.url, SOLANA_WS_URL: info.url.replace('http', 'ws').replace(/:(\d+)/, (_m, p) => `:${Number(p) + 1}`),
    ENABLE_RPC_FALLBACK: 'true', APEX_DB_PATH: path.join(scratch, 'app.db'), SIGNER_KEYPAIR_PATH: keyPath,
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
  await call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING_RISK' });
  const mode = await call('POST', '/api/auto/mode', { mode: 'DEVNET_LIVE', confirmationCode: 'CONFIRM_AUTO_DEVNET' });
  rec('app is in DEVNET_LIVE with the audit running', mode.status === 200 && (await call('GET', '/api/auto/status')).body?.mode === 'DEVNET_LIVE', `mode ${JSON.stringify(mode.body).slice(0, 80)}`);
  await sleep(12_000); // two or three audit looks so the wallet mark is set

  const seedOpts = { connection: conn, allowedGenesis: info.genesisHash, dryRun: false, buyers: 8, windowMs: 10_000, minSendGapMs: 100, retry: { baseMs: 50 } };
  const status = async () => (await call('GET', '/api/auto/status')).body;
  const halted = (st: any) => st?.mode !== 'DEVNET_LIVE' || st?.killed || (st?.decisions ?? []).some((d: any) => d.outcome === 'HALT_ALL');

  // A. a different wallet seeds
  const appBefore = await conn.getBalance(appWallet.publicKey);
  const t0 = Date.now();
  const repA = await runSeed({ ...seedOpts, signer: { publicKey: seedFunder.publicKey, sign: async (tx: any) => tx.partialSign(seedFunder) }, walletDir: path.join(scratch, 'wA') });
  await sleep(Math.max(0, 16_000 - (Date.now() - t0))); // the run plus enough time for at least three audit looks across the balance changes
  const stA = await status();
  const appAfter = await conn.getBalance(appWallet.publicKey);
  rec('seed from a separate wallet landed', repA.buysLanded >= 7 && JSON.parse(fs.readFileSync(repA.walletFile!, 'utf8')).funder === seedFunder.publicKey.toBase58(), `${repA.buysLanded}/8 buys, wallet file funder = the separate wallet`);
  rec('app wallet balance did not move', appAfter === appBefore, `${appBefore} -> ${appAfter} lamports`);
  rec('auditWallet stayed quiet: still DEVNET_LIVE, no HALT_ALL, not killed', !halted(stA), `mode ${stA?.mode}, killed ${stA?.killed}, ${(stA?.decisions ?? []).length} decision rows`);

  // B. control: the APP wallet seeds, which is what the 16:41Z run did
  await call('POST', '/api/auto/resume', {}).catch(() => undefined);
  const repB = await runSeed({ ...seedOpts, signer: { publicKey: appWallet.publicKey, sign: async (tx: any) => tx.partialSign(appWallet) }, walletDir: path.join(scratch, 'wB') }).catch((e) => e);
  let stB: any = null;
  for (let i = 0; i < 12; i++) { await sleep(2000); stB = await status(); if (halted(stB)) break; }
  rec('control: seeding from the APP wallet does halt auto (the audit is live and discriminates)', halted(stB), `mode ${stB?.mode}, killed ${stB?.killed}${repB instanceof Error ? ', run error: ' + repB.message.slice(0, 60) : ''}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nSEED_AUDIT_PROOF ${failed.length ? 'FAILED: ' + failed.map((f) => f.name).join(', ') : 'OK'} (${checks.length} checks)`);
  return failed.length ? 1 : 0;
}
main().then((c) => { children.forEach((p) => p.kill()); process.exit(c); }).catch((e) => { console.error(e); children.forEach((p) => p.kill()); process.exit(1); });
