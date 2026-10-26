import fs from 'node:fs';
import { describe, it, expect, afterAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, LOCALNET_STUB_GENESIS } from './helpers/liveServer';

const dirs: string[] = []; const handles: Array<{ stop(): Promise<void> }> = [];
afterAll(async () => { for (const h of handles) await h.stop(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('Q25: POST /api/pumpfun/callouts/rules validates and keeps only known keys', () => {
  it('rejects out-of-range and wrong-typed values, strips unknown keys', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const d = scratchDir('q25-'); dirs.push(d);
      const app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS }); handles.push(app);
      expect((await app.call('POST', '/api/pumpfun/callouts/rules', { snipeAmountUsd: 1e9 })).status).toBe(400);
      expect((await app.call('POST', '/api/pumpfun/callouts/rules', { autoSnipeOnConfluence: 'yes' })).status).toBe(400);
      expect((await app.call('POST', '/api/pumpfun/callouts/rules', { jitoPriorityTipSol: 5 })).status).toBe(400);
      const ok = await app.call('POST', '/api/pumpfun/callouts/rules', { snipeAmountUsd: 7, evil: 'x', __proto__: { polluted: 1 }, getAutoSnipeRules: 1 });
      expect(ok.status).toBe(200);
      expect(ok.json.rules.snipeAmountUsd).toBe(7);
      expect(ok.json.rules.evil).toBeUndefined();
      expect(ok.json.rules.getAutoSnipeRules).toBeUndefined();
      expect(ok.json.rules.maxEntryMultiple).toBe(1.35); // untouched fields keep their value
    } finally { await rpc.close(); }
  }, 90_000);
});
