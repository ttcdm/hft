import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { executionConfig } from '../server/solana/executionConfig';
import { workstationDb } from '../server/db/database';
import { Logger } from '../server/middleware/enterprise';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { MockSolanaRpc } from './e2e/helpers/mockRpc';
import { redact, childReport } from '../scripts/redact';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const dummyTx = (payer: PublicKey, fill: number): VersionedTransaction => {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.signatures = [new Uint8Array(64).fill(fill)];
  return tx;
};

function setup(jitoUrl: string, over: Record<string, unknown> = {}) {
  const real = executionConfig.getConfig();
  vi.spyOn(executionConfig, 'getConfig').mockReturnValue({ ...real, jitoBlockEngineUrl: jitoUrl, ...over });
  const c = new ExecutionCoordinator(new MockSolanaRpc().createConnection());
  const rpcSubmit = vi.spyOn((c as any).rpcTransport, 'submit');
  vi.spyOn((c as any).rpcTransport, 'confirm').mockResolvedValue({ confirmed: true, slot: 5 } as any);
  return { c, rpcSubmit };
}
const params = (orderId: string, tx: VersionedTransaction, owner = Keypair.generate().publicKey) => {
  const mint = Keypair.generate().publicKey;
  return {
    tx, orderId, correlationId: 'corr-s227', side: 'BUY' as const, mint: mint.toBase58(), mintPubkey: mint, owner, tokenProgram: TOKEN_PROGRAM_ID,
    preSnapshot: { timestamp: Date.now(), walletSolLamports: 1e9, tokenBalanceRaw: '0', tokenDecimals: 6, slot: 1 } as any, jitoTipLamports: 0,
  };
};
const sigOf = (tx: VersionedTransaction) => (tx.signatures[0].every((b) => b === tx.signatures[0][0]) ? Buffer.from(tx.signatures[0]).toString('hex') : '');

describe('S227: with no block engine configured an order goes straight to the RPC transport and is recorded as such', () => {
  it('logs no "Jito attempts exhausted", writes no fallback journal row, and stores SOLANA_RPC (also after the PENDING row was written first)', async () => {
    const { c, rpcSubmit } = setup('');
    const owner = Keypair.generate().publicKey;
    const tx = dummyTx(owner, 9);
    const sig = (await import('bs58')).default.encode(tx.signatures[0]);
    rpcSubmit.mockResolvedValue({ signature: sig, transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    const warn = vi.spyOn(Logger, 'warn');
    const journal = vi.spyOn(workstationDb, 'logJournal');
    const orderId = `s227-${Math.random().toString(36).slice(2)}`;
    const res = await c.submitAndConfirmWithRetry(params(orderId, tx, owner));
    expect(res).toMatchObject({ success: true, transport: 'SOLANA_RPC', lifecycleState: 'CONFIRMED' });
    expect(warn.mock.calls.map((x) => String(x[0])).join('\n')).not.toMatch(/Jito attempts exhausted/);
    expect(journal.mock.calls.map((x) => x[0])).not.toContain('FALLBACK_RPC_ATTEMPT');
    const rows = workstationDb.loadTransactions(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0].submissionTransport).toBe('SOLANA_RPC');
    c.cleanup();
  });

  it('saving a transaction again with a different transport updates the stored transport (a Jito attempt that ends on RPC says RPC)', () => {
    const base = { signature: `sig-${Math.random()}`, orderId: `o-${Math.random()}`, correlationId: 'c', mint: 'M', direction: 'BUY' as const, submissionTime: 1, reconciliationState: 'PENDING' as const, networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE' as const };
    workstationDb.saveTransaction({ ...base, submissionTransport: 'JITO' });
    workstationDb.saveTransaction({ ...base, submissionTransport: 'SOLANA_RPC', reconciliationState: 'RECONCILED' });
    const rows = workstationDb.loadTransactions(base.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ submissionTransport: 'SOLANA_RPC', reconciliationState: 'RECONCILED' });
  });

  it('with a block engine configured the exhausted-then-fallback warning is still logged', async () => {
    const { c, rpcSubmit } = setup('http://127.0.0.1:9', { enableRpcFallback: true });
    vi.spyOn(c.getJitoTransport(), 'isEnabled').mockReturnValue(true);
    vi.spyOn(c as any, 'getJitoReadiness').mockReturnValue({ ready: false, enabled: true, status: 'OFFLINE', reason: 'down' });
    vi.spyOn(c.getJitoTransport(), 'probe').mockResolvedValue({ healthy: false } as any);
    const owner = Keypair.generate().publicKey;
    const tx = dummyTx(owner, 10);
    rpcSubmit.mockResolvedValue({ signature: (await import('bs58')).default.encode(tx.signatures[0]), transport: 'SOLANA_RPC', success: true, submitDurationMs: 1, lifecycleState: 'BUNDLE_PENDING' } as any);
    const warn = vi.spyOn(Logger, 'warn');
    await c.submitAndConfirmWithRetry(params(`s227-${Math.random().toString(36).slice(2)}`, tx, owner));
    expect(warn.mock.calls.map((x) => String(x[0])).join('\n')).toMatch(/Jito attempts exhausted/);
    c.cleanup();
  });
});

describe('S227: an order already recorded as landed adds no row', () => {
  it('submitAndConfirmWithRetry answers from the recorded row before writing anything, and sends nothing', async () => {
    const { c, rpcSubmit } = setup('');
    const orderId = `s227-dup-${Math.random().toString(36).slice(2)}`;
    workstationDb.saveTransaction({
      signature: `landed-${Math.random()}`, orderId, correlationId: 'c', mint: 'M', direction: 'BUY', submissionTransport: 'SOLANA_RPC', submissionTime: 1,
      landingSlot: 42, reconciliationState: 'RECONCILED', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
    });
    const before = workstationDb.loadTransactions(orderId).length;
    const res = await c.submitAndConfirmWithRetry(params(orderId, dummyTx(Keypair.generate().publicKey, 11)));
    expect(res).toMatchObject({ success: true, lifecycleState: 'CONFIRMED', transport: 'SOLANA_RPC', slot: 42 });
    expect(workstationDb.loadTransactions(orderId)).toHaveLength(before);
    expect(rpcSubmit).not.toHaveBeenCalled();
    c.cleanup();
  });
});

describe('S227: the blockhash check says so when it ran', () => {
  it('logs one INFO line for a passing BUY check, and none when the check was skipped', async () => {
    const { c } = setup('');
    vi.stubEnv('APEX_VERIFY_BLOCKHASH', 'true');
    vi.stubEnv('ALLOWED_CLUSTER', 'devnet');
    // the independent RPC answers "valid"; no network is used
    vi.spyOn(Connection.prototype, 'isBlockhashValid').mockResolvedValue({ context: { slot: 1 }, value: true } as any);
    const info = vi.spyOn(Logger, 'info');
    const tx = dummyTx(Keypair.generate().publicKey, 12);
    expect(await (c as any).blockhashProblem(tx, 'BUY')).toBeNull();
    const passed = (xs: unknown[][]) => xs.map((x) => String(x[0])).filter((m) => /independent blockhash check passed for the BUY/.test(m));
    expect(passed(info.mock.calls)).toHaveLength(1);
    info.mockClear();
    vi.stubEnv('ALLOWED_CLUSTER', 'localnet'); // skipped: nothing was checked, so nothing is claimed
    expect(await (c as any).blockhashProblem(tx, 'BUY')).toBeNull();
    expect(passed(info.mock.calls)).toHaveLength(0);
    c.cleanup();
  });
});

describe('S227: no part of a private RPC URL survives in anything the harness prints', () => {
  const url = 'https://my-endpoint-abc.solana-devnet.quiknode.pro/0123456789abcdef0123/?apikey=secretvalue1';
  it('redact removes the URL, the host, the endpoint name, every cut-off tail of the host, the path key and the query value', () => {
    const host = new URL(url).host;
    const texts = [
      `failed to fetch ${url}`,
      `getaddrinfo ENOTFOUND ${host}`,
      `...${host.slice(-14)}`, // a log line cut in the middle of the host (the leak seen on the Mac: "t.quiknode.pro")
      `key 0123456789abcdef0123 value secretvalue1 name my-endpoint-abc`,
    ];
    for (const t of texts) {
      const out = redact(t, [url]);
      for (const bit of ['my-endpoint', 'quiknode', 'solana-devnet', '0123456789abcdef0123', 'secretvalue1', host.slice(-9)]) expect(out).not.toContain(bit);
    }
    expect(redact('visit https://faucet.solana.com now', [])).toBe('visit <url> now');
    expect(redact('no url here', [url])).toBe('no url here');
  });

  it('childReport shows how the child ended and its last non-guard lines, without secrets', () => {
    const host = new URL(url).host;
    const r = childReport(
      { status: null, signal: 'SIGTERM', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), stdout: 'one\ntwo\n', stderr: `[devnet-guard] allow fetch https://${host}\nreal error at ${url}\n` },
      [url]
    );
    expect(r).toMatch(/did not finish \(ETIMEDOUT\)/);
    expect(r).toMatch(/one \| two \| real error at <rpc>/);
    expect(r).not.toMatch(/devnet-guard|quiknode|secretvalue1/);
  });

  it('childReport keeps the first line of an INSTANCE_LOCKED refusal (the lock path and the holder pid), however long the stack after it', () => {
    const msg = 'INSTANCE_LOCKED: /scratch/cloud-harness/e2e.db.lock is held by running process 4242 (started 2026-10-27T10:01:00.000Z). '
      + 'Only one server may use a database or a signing key at a time. Stop that process (or container) first. '
      + 'If it is gone, the lock frees itself 30 s after its last heartbeat; if it is not an Apex server (a reused pid), delete the lock file.';
    const stack = Array.from({ length: 12 }, (_, i) => `    at frame${i} (/home/user/work/integ2/server/x${i}.ts:${i}:1)`).join('\n');
    const r = childReport({ status: 1, signal: null, stdout: 'INFO  SOL/USD 99\n', stderr: `/home/user/work/integ2/server/system/instanceLock.ts:198\nInstanceLockError: ${msg}\n${stack}\n` }, [url]);
    expect(r).toMatch(/^exit 1; INSTANCE_LOCKED: \/scratch\/cloud-harness\/e2e\.db\.lock is held by running process 4242 \(started 2026-10-27T10:01:00\.000Z\)/);
    expect(r).toMatch(/last output: .*frame11/);
    expect(r.length).toBeLessThanOrEqual(800);
  });

  it('the devnet guard prints a private RPC host as <rpc> and a public host as itself', () => {
    const guard = path.resolve(process.cwd(), 'scripts/devnet_guard.cjs');
    const run = (code: string, env: Record<string, string>) => spawnSync(process.execPath, ['--require', guard, '-e', code], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
    const priv = run("fetch('http://127.0.0.1:9/key').catch(()=>{})", { DEVNET_RPC_URL: 'http://127.0.0.1:9/key' });
    expect(priv.stderr).toContain('<rpc>');
    expect(priv.stderr).not.toContain('127.0.0.1');
    const pub = run("fetch('http://127.0.0.1:9/key').catch(()=>{})", { DEVNET_RPC_URL: '', SOLANA_RPC_URL: '', SOLANA_WS_URL: '' });
    expect(pub.stderr).toContain('http://127.0.0.1:9');
  });

  it('the harness prints through safe(), imports tracing so APEX_TRACING works, and the crash child gets a longer limit', () => {
    const src = fs.readFileSync('scripts/devnet_e2e.ts', 'utf8');
    expect(src).toMatch(/detail = safe\(detail\)/);
    expect(src).toMatch(/safe\(e\?\.stack \|\| e\)/);
    expect(src).toMatch(/import\('\.\.\/server\/observability\/init'\)/);
    expect(src).toMatch(/await tracingReady/);
    expect(src).toMatch(/childReport\(crash/);
    expect(src).toMatch(/timeout: 240_000/);
  });
});
