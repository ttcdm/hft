import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WatchWindow, publicFundersFromEnv } from '../server/signals/watchWindow';
import { replay, buyers, wallet } from './fixtures/watch';

const mintId = () => Keypair.generate().publicKey.toBase58();

function watchedWith(ww: WatchWindow, mint: string, funder: string, n = 30, creator = wallet()) {
  const start = Date.now() - 60_000;
  ww.watch(mint, creator, start);
  const b = buyers(n, 25);
  b.wallets.forEach((w) => ww.setFunder(w, funder));
  for (const { trade, at } of replay(mint, start, b.steps)) ww.onTrade(trade, at);
  return start;
}
const uniqueBuyers = (ww: WatchWindow, mint: string, at: number) => ww.evaluate(mint, at)!.metrics.uniqueBuyers;

describe('S4d: only an explicit allowlist exempts a funder from clustering', () => {
  it('a sybil funder stays one cluster however many mints its wallets buy', () => {
    const ww = new WatchWindow({ publicFunders: [] });
    const sybil = wallet();
    const target = mintId();
    const start = watchedWith(ww, target, sybil);
    for (let i = 0; i < 12; i++) { const other = mintId(); watchedWith(ww, other, sybil, 3); ww.evaluate(other, Date.now() - 30_000); }
    expect(uniqueBuyers(ww, target, start + 40_000)).toBe(1);
  });

  it('an allowlisted funder (an exchange hot wallet) does not tie its wallets together; a different funder still does', () => {
    const exchange = wallet(); const sybil = wallet();
    const ww = new WatchWindow({ publicFunders: [exchange] });
    const a = mintId(); const b = mintId();
    const sa = watchedWith(ww, a, exchange); const sb = watchedWith(ww, b, sybil);
    expect(uniqueBuyers(ww, a, sa + 40_000)).toBe(30);
    expect(uniqueBuyers(ww, b, sb + 40_000)).toBe(1);
  });

  it('the creator funding its own buyers is the creator cluster even if the creator is on the list', () => {
    const creator = wallet();
    const ww = new WatchWindow({ publicFunders: [creator] });
    const m = mintId();
    const s = watchedWith(ww, m, creator, 30, creator);
    expect(uniqueBuyers(ww, m, s + 40_000)).toBe(1);
  });

  it('the list comes from APEX_PUBLIC_FUNDERS (comma separated, trimmed) and is empty by default', () => {
    expect(publicFundersFromEnv({}).size).toBe(0);
    expect([...publicFundersFromEnv({ APEX_PUBLIC_FUNDERS: ' A , B,,' })]).toEqual(['A', 'B']);
  });
});
