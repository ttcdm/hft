import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { startApp, scratchDir, startRpcStub, LOCALNET_STUB_GENESIS } from './helpers/liveServer';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('S27: SIGKILL on the harness pid takes the real server down (no orphan)', () => {
  it('after kill -9 the server port stops answering', async () => {
    const rpc = await startRpcStub(LOCALNET_STUB_GENESIS);
    try {
      const d = scratchDir('s27-'); dirs.push(d);
      const app = await startApp(d, { SOLANA_RPC_URL: rpc.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS });
      expect((await fetch(`${app.base}/api/health`)).ok).toBe(true);
      process.kill(app.pid, 'SIGKILL');
      let answered = true;
      for (let i = 0; i < 20 && answered; i++) {
        await new Promise((r) => setTimeout(r, 150));
        answered = await fetch(`${app.base}/api/health`).then(() => true, () => false);
      }
      expect(answered).toBe(false);
    } finally { await rpc.close(); }
  }, 60_000);
});
