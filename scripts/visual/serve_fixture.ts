/**
 * VISUAL-TEST FIXTURE (not part of the app): boots the real server in-process on a scratch DB, then puts labelled
 * synthetic launches, watch-window entries and paper positions into the real singletons so the home board has rows to
 * lay out in a headless-browser pass. Nothing in the app imports this file; the data is never produced at runtime.
 * Usage: APP_PORT=3188 OPERATOR_PASSWORD=... npx tsx scripts/visual/serve_fixture.ts
 */
import '../hermeticEnv';
import '../../server/loadEnv';
import { Keypair } from '@solana/web3.js';

async function main() {
  process.env.APEX_DB_PATH ||= '/tmp/apex-visual-fixture.db';
  await import('../../server');
  const { memecoinAggregator } = await import('../../server/memecoinAggregator');
  const { PumpFeedListener } = await import('../../server/solana/pumpFeedListener');
  const { watchWindow } = await import('../../server/signals/watchWindow');
  const { workstationDb } = await import('../../server/db/database');
  const { solPriceService } = await import('../../server/market/solPriceService');
  const { replay, buyers, wallet } = await import('../../tests/fixtures/watch');

  solPriceService.setPrice(150, 'VISUAL_FIXTURE');
  const l = new PumpFeedListener();
  const names: Array<[string, string, number, number, number, number]> = [
    ['FIXA', 'Fixture Alpha', 2.1e-7, 12.5, 18.2, 3.1],
    ['FIXB', 'A Much Longer Fixture Token Name Beta', 8.4e-8, 41.0, 33.9, 9.8],
    ['FIXC', 'Fixture Gamma', 4.5e-7, 77.3, 52.4, 0.4],
    ['FIXD', 'Fixture Delta', 1.2e-8, 3.2, 12.0, 22.5],
    ['FIXE', 'Fixture Epsilon', 9.9e-7, 95.0, 61.7, 5.0],
    ['VERYLONGSYM', 'Fixture Zeta', 3.3e-8, 20.0, 25.5, 1.2],
  ];
  const mints: string[] = [];
  for (const [symbol, name, price, curve, top10, creatorPct] of names) {
    const mint = Keypair.generate().publicKey.toBase58();
    const creator = Keypair.generate().publicKey.toBase58();
    const ev = l.parseLogs({ err: null, signature: `vf-${symbol}`, logs: PumpFeedListener.asPumpInvocation(PumpFeedListener.encodeCreateEventLog({ name, symbol, uri: '', mint, creator })) } as any, { slot: 9 })!;
    const pool: any = memecoinAggregator.ingestOnChainCreateEvent(ev);
    Object.assign(pool, { priceNative: price, bondingCurveProgress: curve, top10HoldersPct: top10, devHoldingPct: creatorPct, liquidityUsd: 15_000 });
    mints.push(mint);
    // first three are inside the watch window; the fourth is released HOT
    const start = Date.now() - 12_000;
    if (mints.length <= 3) {
      watchWindow.watch(mint, creator, start);
      for (const { trade, at } of replay(mint, start, buyers(5 + mints.length * 3, 10).steps)) watchWindow.onTrade(trade, at);
    }
  }
  l.destroy();
  const now = Date.now();
  const pos = (i: number, symbol: string, entry: number, cur: number, ageMin: number) => ({
    id: `visual-fixture-${i}`, mint: mints[i], symbol, name: `Fixture ${symbol}`, tokenDecimals: 6, tokenQuantityRaw: '5000000000',
    entryPriceSol: entry, currentPriceSol: cur, currentValueSol: (cur * 5000) , costBasisLamports: Math.round(entry * 5000 * 1e9), realizedPnLSol: 0,
    status: 'OPEN', venue: 'PUMP_BONDING_CURVE', executionMode: 'PAPER', entryTxSignature: `PAPER:visual-fixture-${i}`,
    entryTimestamp: now - ageMin * 60_000, lastMarkTimestamp: now, recordUpdatedAt: now, updatedAt: now,
  });
  workstationDb.savePosition(pos(3, 'FIXD', 1.0e-8, 1.4e-8, 4) as any);
  workstationDb.savePosition(pos(4, 'FIXE', 9.0e-7, 7.2e-7, 22) as any);
  console.log('[visual-fixture] seeded', mints.length, 'launches, 3 watching, 2 holding');
}
main().catch((e) => { console.error(e); process.exit(1); });
