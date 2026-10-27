import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Keypair, PublicKey } from '@solana/web3.js';
import { startValidator, startLocalnetApp, armLive, LocalMarket, scratch, cleanupScratch, signedTxCount, type ValidatorHandle, type LocalnetApp } from '../helpers/localnetChain';

/**
 * P1.5 localnet check (R1-2): a LIVE buy that lands in the bank while the RPC answers the send with a 502 is not recorded REVERTED.
 * Real server process, real pump.fun program (LiteSVM), real signer and transports; the fault is the validator's
 * `localnet_landThenFailNextSend`. The landed buy gets exactly one position in the same process (no restart), its quantity is the
 * wallet's token balance, and a second buy of the mint is refused.
 */
const dir = scratch('long-ambiguous-');
let v: ValidatorHandle;
let market: LocalMarket;
let app: LocalnetApp;
let trader: Keypair;
let coin: PublicKey;

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
  const signer = await market.signerKeyFile(dir, 5);
  trader = signer.keypair;
  app = await startLocalnetApp({ dir, validator: v, signerKeyPath: signer.path, confluenceThreshold: 0, holderFeed: true });
  market.watchedBy(() => app); // R2-3: seeded coins wait until this app has looked up their holders
  ({ mint: coin } = await market.seedCoin(14, 0.6));
  await armLive(app);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await v?.stop();
  cleanupScratch(dir);
});

describe('P1.5: a buy that landed behind a 502 is a position, not a REVERTED row', () => {
  it('one send, one position equal to the chain balance, no REVERTED row, and the re-buy is refused', async () => {
    const before = await signedTxCount(v.conn, trader.publicKey);
    await v.rpc('localnet_landThenFailNextSend');
    const r = await app.call('POST', '/api/execution/trade', { mint: coin.toBase58(), symbol: 'AMB', name: 'Ambiguous', amountSol: 0.02, confirmLive: true });
    expect((await v.rpc('localnet_stats')).landedThenFailed.length, JSON.stringify(r.json)).toBe(1);
    expect((await signedTxCount(v.conn, trader.publicKey)) - before).toBe(1);
    expect(['CONFIRMED', 'RECONCILIATION_REQUIRED']).toContain(r.json?.lifecycleState);

    // the position appears without a restart (at once when the confirm sees it, else through orphan recovery)
    let pos: any;
    for (let i = 0; i < 80 && !pos; i++) {
      const list = (await app.call('GET', '/api/workstation/positions')).json?.positions ?? [];
      pos = list.find((p: any) => p.mint === coin.toBase58() && p.executionMode === 'LIVE' && p.status === 'OPEN');
      if (!pos) await new Promise((res) => setTimeout(res, 750));
    }
    expect(pos, 'no position for the landed buy').toBeTruthy();
    const positions = ((await app.call('GET', '/api/workstation/positions')).json?.positions ?? []).filter((p: any) => p.mint === coin.toBase58() && p.status !== 'CLOSED');
    expect(positions).toHaveLength(1);
    expect(BigInt(pos.tokenQuantityRaw)).toBe(await market.tokenBalance(trader.publicKey, coin));

    const again = await app.call('POST', '/api/execution/trade', { mint: coin.toBase58(), symbol: 'AMB', name: 'Ambiguous', amountSol: 0.02, confirmLive: true });
    expect(again.json?.success).toBe(false);
    expect(String(again.json?.error)).toMatch(/POSITION_ALREADY_OPEN|UNRESOLVED_BUY|Cooling down/);
    expect((await signedTxCount(v.conn, trader.publicKey)) - before).toBe(1);
  });
});
