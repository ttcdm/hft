import { describe, it, expect, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PumpFeedListener } from '../server/solana/pumpFeedListener';
import { WatchWindow } from '../server/signals/watchWindow';

/** Q6d: the dev buy is a TradeEvent in the create transaction. It was emitted before the create event, so no watch existed to receive it. */
describe('Q6d: the dev buy in a create transaction reaches the watch window', () => {
  const listeners: PumpFeedListener[] = [];
  afterEach(() => { while (listeners.length) listeners.pop()!.destroy(); });

  it('a create tx that also carries the creator\'s buy gives the new watch that trade', async () => {
    const mint = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    let cb: ((logs: any, ctx: any) => void) | null = null;
    const conn: any = { onLogs: (_p: PublicKey, fn: any) => { cb = fn; return 1; }, removeOnLogsListener: async () => undefined, getSignaturesForAddress: async () => [] };
    const listener = new PumpFeedListener(conn);
    listeners.push(listener);
    const watch = new WatchWindow();
    watch.attach(listener);
    await listener.start();

    const create = PumpFeedListener.encodeCreateEventLog({ name: 'Dev', symbol: 'DEV', uri: 'u', mint, creator });
    const devBuy = PumpFeedListener.encodeTradeEventLog({
      mint, solAmountLamports: 500_000_000n, tokenAmount: 20_000_000_000_000n, isBuy: true, user: creator,
      timestampSec: Math.floor(Date.now() / 1000), virtualSolReserves: 30_500_000_000n, virtualTokenReserves: 1_050_000_000_000_000n,
      realSolReserves: 500_000_000n, realTokenReserves: 780_000_000_000_000n,
    });
    cb!({ err: null, signature: 'createtx', logs: [...PumpFeedListener.asPumpInvocation(create), ...PumpFeedListener.asPumpInvocation(devBuy)] }, { slot: 9 });

    const snap = watch.getSnapshot();
    expect(snap.watching).toHaveLength(1);
    expect(snap.watching[0].metrics.tradeCount).toBe(1);
    expect(snap.watching[0].metrics.buyVolumeSol).toBeCloseTo(0.5, 9);
  });
});
