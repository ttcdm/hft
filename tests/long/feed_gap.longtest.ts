import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Connection } from '@solana/web3.js';
import { startValidator, scratch, cleanupScratch, sleep, LocalMarket, type ValidatorHandle } from '../helpers/localnetChain';

/**
 * LONG TEST (P4.2, R1-52): the validator's websocket is dropped mid-watch while the seeded creator sells.
 *
 * The real `PumpFeedListener` subscribes through a plain web3.js `Connection` to the local validator (real pump program binaries), and
 * a real `WatchWindow` is attached to it. The create and a buy are seen; then `localnet_dropWebSockets(3000)` closes the socket and
 * refuses reconnects for 3 s, and the creator sells inside that window. web3.js reconnects and resubscribes on its own and never
 * replays the sell's logs. Expected: the feed leaves ACTIVE, the launch is released DEAD with FEED_GAP (not left to turn HOT or READY
 * without the sell), and the feed is ACTIVE again afterwards. Also: the validator's slotSubscribe heartbeat reaches the listener.
 */
const dir = scratch('long-feedgap-');
let v: ValidatorHandle;
let market: LocalMarket;

beforeAll(async () => {
  v = await startValidator(dir);
  market = await LocalMarket.connect(v);
}, 120_000);

afterAll(async () => {
  await v?.stop();
  cleanupScratch(dir);
});

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

describe('localnet_dropWebSockets mid-watch', () => {
  it('the creator sells while the websocket is down: the launch is DEAD with FEED_GAP and the feed comes back ACTIVE', async () => {
    const { PumpFeedListener } = await import('../../server/solana/pumpFeedListener');
    const { WatchWindow } = await import('../../server/signals/watchWindow');
    const conn = new Connection(v.url, 'processed');
    const listener = new PumpFeedListener(conn);
    const ww = new WatchWindow({ publicFunders: [] });
    ww.attach(listener);
    const statuses: string[] = [];
    listener.on('feed_gap', () => statuses.push(listener.getTelemetry().status));
    const sells: string[] = [];
    listener.on('trade_event', (t: any) => { if (!t.isBuy) sells.push(t.signature); });
    try {
      expect(await listener.start()).toBe(true);
      // devnet run 25 (3K): ACTIVE once the validator confirms the subscription (CONNECTING until then)
      expect(await until(() => listener.getTelemetry().status === 'ACTIVE' && listener.getTelemetry().subscriptionConfirmed, 5_000)).toBe(true);
      await sleep(2_500); // the socket opens and the slot heartbeat (the validator's slotSubscribe) starts

      const mint = await market.createCoin('GAP');
      await market.buy(market.creator, mint, 0.2);
      const buyer = await market.fresh(2);
      await market.buy(buyer, mint, 0.5);
      expect(await until(() => ww.isWatching(mint.toBase58()) && listener.getTelemetry().tradesParsed >= 2, 10_000)).toBe(true);
      expect(listener.getTelemetry().feedGaps).toBe(0);

      await v.rpc('localnet_dropWebSockets', [3000]);
      const sellSig = await market.sell(market.creator, mint, 1);
      expect(sellSig).toBeTruthy();
      const stats = await v.rpc('localnet_stats');
      expect(stats.wsDown).toBe(true);
      expect(stats.logsDroppedWhileDown).toBeGreaterThanOrEqual(1);

      expect(await until(() => ww.getVerdict(mint.toBase58())?.state === 'DEAD', 10_000)).toBe(true);
      const verdict = ww.getVerdict(mint.toBase58())!;
      expect(verdict.reason).toMatch(/^FEED_GAP: .*SOCKET_CLOSED/);
      expect(statuses[0]).toBe('RECONNECTING');
      expect(sells).not.toContain(sellSig); // the sell's logs were never delivered

      // web3.js reconnects after the 3 s and the feed is ACTIVE again; a new launch is watched normally
      expect(await until(() => listener.getTelemetry().status === 'ACTIVE' && listener.getTelemetry().feedGaps === 1, 20_000)).toBe(true);
      const m2 = await market.createCoin('GAP2');
      expect(await until(() => ww.isWatching(m2.toBase58()), 10_000)).toBe(true);
    } finally {
      await listener.stop();
      listener.destroy();
    }
  }, 180_000);
});
