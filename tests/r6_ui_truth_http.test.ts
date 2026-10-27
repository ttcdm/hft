import fs from 'node:fs';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, haltInSeparateProcess, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

/**
 * Round 6 (haiku-attack 2026-10-26), over the real server's HTTP API: what the code knows reaches the operator.
 * R6-1 / R7-1: GET /api/system/checks serves the open operator alerts, with a level, as the runbook says.
 */
const dirs: string[] = [];
const handles: Array<{ stop(): Promise<void> }> = [];
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const dir = () => { const d = scratchDir('r6-http-'); dirs.push(d); return d; };

describe('R6-1/R7-1: /api/system/checks serves the operator alerts', () => {
  let rpc: RpcStub; let app: AppHandle;
  beforeAll(async () => {
    const d = dir();
    rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    haltInSeparateProcess(`${d}/app.db`, 'r6 http halt'); // the next boot raises TRADING_HALTED from the journal
    app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
    handles.push(app);
  }, 120_000);
  afterAll(() => rpc.close());

  it('the restored halt is listed as a CRITICAL operator alert and the alerts row is FAIL; clearing the halt removes it', async () => {
    const r = await app.call('GET', '/api/system/checks');
    expect(r.status).toBe(200);
    const halted = r.json.operatorAlerts.find((a: any) => a.code === 'TRADING_HALTED');
    expect(halted.level).toBe('CRITICAL');
    expect(halted.message).toMatch(/r6 http halt/);
    expect(r.json.checks.find((c: any) => c.id === 'alerts').status).toBe('FAIL');
    await app.call('POST', '/api/auto/resume', { clearHalt: true });
    const after = (await app.call('GET', '/api/system/checks')).json;
    expect(after.operatorAlerts.some((a: any) => a.code === 'TRADING_HALTED')).toBe(false);
  });
});
