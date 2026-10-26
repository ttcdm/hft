// Recorded-shape fixtures for the public feeds the social/callout pipeline reads. These are hand-written to match
// the field names the production code reads (pump.fun frontend API coin objects and DexScreener boosts/pairs).
export const MINT_A = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
export const MINT_B = '2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L';

export const pumpCoin = (over: Record<string, any> = {}) => ({
  mint: MINT_A,
  name: 'Goatseus Maximus',
  symbol: 'GOAT',
  description: 'goat',
  image_uri: 'https://ipfs.io/ipfs/x',
  twitter: 'https://x.com/goatse',
  telegram: 'https://t.me/goatse_sol',
  website: 'https://goat.example',
  bonding_curve: 'BondingCurve1111111111111111111111111111111',
  associated_bonding_curve: 'AssocCurve11111111111111111111111111111111',
  creator: 'Creator11111111111111111111111111111111111',
  created_timestamp: Date.now() - 30_000,
  last_trade_timestamp: Date.now() - 5_000,
  complete: false,
  market_cap: 20,
  usd_market_cap: 6000,
  ...over,
});

export const dexBoosts = (mints: string[]) =>
  mints.map((m) => ({ chainId: 'solana', tokenAddress: m, amount: 500 }))
    .concat([{ chainId: 'ethereum', tokenAddress: '0xabc', amount: 1 }]);

export const dexPairs = (mint: string) => ({
  pairs: [
    {
      baseToken: { address: mint },
      priceUsd: '0.000006',
      fdv: 6000,
      volume: { m5: 21000 },
      txns: { m5: { buys: 40, sells: 10 } },
      info: { socials: [{ type: 'twitter', url: 'https://x.com/goatse' }], websites: [{ url: 'https://goat.example' }] },
    },
  ],
});

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
