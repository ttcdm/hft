import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, MAINNET_GENESIS, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

/** The real server process and its real HTTP API: the System checks and latency routes answer with live reads, not constants. */
const dirs: string[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const dir = () => { const d = scratchDir('s177-'); dirs.push(d); return d; };

describe('S177 over HTTP', () => {
  let good: RpcStub; let bad: RpcStub; let goodApp: AppHandle; let badApp: AppHandle;
  beforeAll(async () => {
    good = await startRpcStub(LOCALNET_STUB_GENESIS);
    bad = await startRpcStub(MAINNET_GENESIS);
    goodApp = await startApp(dir(), { SOLANA_RPC_URL: good.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    badApp = await startApp(dir(), { SOLANA_RPC_URL: bad.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    handles.push(goodApp, badApp);
  }, 120_000);
  afterAll(() => { good.close(); bad.close(); });

  it('/api/system/checks reads the cluster check from the RPC: matching genesis is OK, a mainnet answer is FAIL', async () => {
    const ok = (await goodApp.call('GET', '/api/system/checks')).json;
    expect(ok.success).toBe(true);
    expect(ok.checks.map((c: any) => c.id)).toEqual(['cluster', 'signer', 'rpc', 'reconciliation', 'halt', 'killswitch', 'feed', 'capacity', 'marks', 'database']);
    const cluster = (j: any) => j.checks.find((c: any) => c.id === 'cluster');
    await new Promise((r) => setTimeout(r, 1500));
    expect(cluster((await goodApp.call('GET', '/api/system/checks')).json).status).toBe('OK');
    const bad1 = cluster((await badApp.call('GET', '/api/system/checks')).json);
    expect(bad1.status).toBe('FAIL');
    expect(bad1.detail).toMatch(/genesis/i);
  }, 60_000);

  it('/api/system/latency answers with empty, honest figures on a fresh journal', async () => {
    const r = (await goodApp.call('GET', '/api/system/latency')).json;
    expect(r.success).toBe(true);
    expect(r.counts.transactions).toBe(0);
    expect(r.sendToConfirm).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/nothing to measure/);
  });

  it('the old toy route is gone', async () => {
    expect((await goodApp.call('GET', '/api/unit-tests')).status).toBe(404);
  });
});
