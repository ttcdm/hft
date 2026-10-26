import fs from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { ARMED_MESSAGE, PANIC_CONFIRM_TEXT, panicOutcome } from '../src/utils/tradingCopy';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS } from './helpers/liveServer';

describe('Q37: arm and panic wording matches what the server does', () => {
  it('the armed message names the cluster and no longer promises Jito bundles', () => {
    expect(ARMED_MESSAGE('devnet')).toMatch(/devnet/);
    expect(ARMED_MESSAGE('devnet')).not.toMatch(/jito|bundle/i);
    expect(ARMED_MESSAGE()).toMatch(/configured cluster/);
  });
  it('the panic prompt says it trips the kill switch, disarms and stops auto, and that failures stay open', () => {
    expect(PANIC_CONFIRM_TEXT).toMatch(/kill switch/);
    expect(PANIC_CONFIRM_TEXT).toMatch(/disarm/);
    expect(PANIC_CONFIRM_TEXT).toMatch(/auto/);
    expect(PANIC_CONFIRM_TEXT).toMatch(/stay open/);
  });
  it('a panic with failures is an error banner, a clean one is a success banner', () => {
    expect(panicOutcome(true, 200, { success: false, message: 'INCOMPLETE' }).type).toBe('error');
    expect(panicOutcome(true, 200, { success: true, message: 'done' })).toEqual({ text: 'done', type: 'success' });
    expect(panicOutcome(false, 500, {}).text).toMatch(/may still be open/);
  });
});

const dirs: string[] = []; const handles: Array<{ stop(): Promise<void> }> = [];
afterAll(async () => { for (const h of handles) await h.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('Q37: POST /api/wallet/panic-liquidate over HTTP', () => {
  it('stops auto mode (killed) and reports success only when nothing failed', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const d = scratchDir('q37-'); dirs.push(d);
      const app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS }); handles.push(app);
      expect((await app.call('GET', '/api/auto/status')).json.killed).toBe(false);
      const r = await app.call('POST', '/api/wallet/panic-liquidate', {});
      expect(r.status).toBe(200);
      expect(r.json.success).toBe(true);
      expect(r.json.message).toMatch(/auto stopped/);
      const st = (await app.call('GET', '/api/auto/status')).json;
      expect(st.killed).toBe(true);
      expect(st.mode).toBe('OFF');
    } finally { await rpc.close(); }
  }, 90_000);
});
