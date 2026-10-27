import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { startApp, scratchDir } from './helpers/liveServer';

/**
 * R5-40: POST /api/execution/trade called executeTrade directly, skipping executeSnipe's gates (confluence, pool checks, the synthetic-pool
 * refusal). The real server in a child process (PAPER, no feeds, a dead RPC): the refusal must come from executeSnipe, whose messages
 * (no SOL/USD price yet, no real pool) the coordinator never produces.
 */
describe('R5-40 over HTTP: POST /api/execution/trade runs the executeSnipe gates', () => {
  it('a buy of a mint with no SOL price and no real pool is refused by executeSnipe, nothing reaches the coordinator', async () => {
    const app = await startApp(scratchDir('fixd-r540'), {});
    try {
      const r = await app.call('POST', '/api/execution/trade', { mint: Keypair.generate().publicKey.toBase58(), symbol: 'R540', name: 'R540', amountSol: 0.01 });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json.success).toBe(false);
      expect(String(r.json.error)).toMatch(/no SOL\/USD price has been read yet|Token pool .* not found/);
      expect(r.json.lifecycleState).toBeUndefined(); // a coordinator answer always carries one
    } finally {
      await app.stop();
    }
  }, 300_000);
});
