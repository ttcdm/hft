export interface TokenLinkItem {
  id:
    | 'dexscreener'
    | 'pumpfun'
    | 'gmgn'
    | 'birdeye'
    | 'solscan'
    | 'photon'
    | 'bullx'
    | 'axiom'
    | 'twitter'
    | 'telegram'
    | 'website';
  name: string;
  shortName: string;
  url: string;
  description: string;
  colorClass: string;
  badgeBgClass: string;
  isAvailable: boolean;
}

export function sanitizeExternalUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === 'none' ||
    trimmed.toLowerCase() === 'null' ||
    trimmed.toLowerCase() === 'n/a' ||
    trimmed.toLowerCase() === 'undefined'
  ) {
    return undefined;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function sanitizeTwitterUrl(raw?: string | null, fallbackSymbol?: string, isSolana = true): string {
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed && trimmed.toLowerCase() !== 'none' && trimmed.toLowerCase() !== 'n/a') {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return trimmed;
      }
      const handle = trimmed.replace(/^@/, '');
      return `https://x.com/${handle}`;
    }
  }
  const sym = (fallbackSymbol || '').replace('$', '').trim();
  return `https://x.com/search?q=${encodeURIComponent(`$${sym}${isSolana ? ' solana' : ''}`)}`;
}

export function sanitizeTelegramUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === 'none' ||
    trimmed.toLowerCase() === 'n/a' ||
    trimmed.toLowerCase() === 'null'
  ) {
    return undefined;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  const handle = trimmed.replace(/^@/, '');
  return `https://t.me/${handle}`;
}

export function getTokenExternalLinks(params: {
  mintOrCa: string;
  symbol: string;
  name?: string;
  chain?: string;
  platform?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  /**
   * Q41: the cluster the server trades on. On devnet / localnet a token does not exist on the mainnet-only sites, and Solscan needs the
   * cluster in the URL. Omitted or mainnet: the links are unchanged.
   */
  cluster?: string | null;
}): TokenLinkItem[] {
  const { mintOrCa, symbol, chain = 'SOLANA', platform = 'PUMP_FUN', twitter, telegram, website, cluster } = params;
  const testCluster = cluster === 'devnet' || cluster === 'localnet' ? cluster : null;
  const ca = (mintOrCa || '').trim();
  const sym = (symbol || '').trim().replace('$', '');
  const chainUpper = (chain || 'SOLANA').toUpperCase();
  const isSolana = chainUpper.includes('SOL');
  const isBase = chainUpper.includes('BASE');
  const isEth = chainUpper.includes('ETH');

  // DexScreener URL
  let dexscreenerUrl = `https://dexscreener.com/search?q=${encodeURIComponent(ca || sym)}`;
  if (ca) {
    if (isSolana) dexscreenerUrl = `https://dexscreener.com/solana/${ca}`;
    else if (isBase) dexscreenerUrl = `https://dexscreener.com/base/${ca}`;
    else if (isEth) dexscreenerUrl = `https://dexscreener.com/ethereum/${ca}`;
  }

  // Pump.fun URL (Solana / pump tokens only)
  const isPumpFunEligible = (isSolana || ca.endsWith('pump') || platform === 'PUMP_FUN') && !isBase && !isEth;
  const pumpfunUrl = ca ? `https://pump.fun/coin/${ca}` : `https://pump.fun/board`;

  // GMGN.ai URL (Top sniper/smart money tool for Solana & Base)
  const gmgnChain = isBase ? 'base' : isEth ? 'eth' : 'sol';
  const gmgnUrl = ca ? `https://gmgn.ai/${gmgnChain}/token/${ca}` : `https://gmgn.ai`;

  // Birdeye URL
  const birdeyeChain = isSolana ? 'solana' : isBase ? 'base' : isEth ? 'ethereum' : 'solana';
  const birdeyeUrl = ca ? `https://birdeye.so/token/${ca}?chain=${birdeyeChain}` : `https://birdeye.so`;

  // Block Explorer (Solscan / Basescan / Etherscan)
  let explorerName = 'Solscan';
  const clusterQuery = testCluster === 'devnet' ? '?cluster=devnet' : testCluster === 'localnet' ? '?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899' : '';
  let explorerUrl = ca ? `https://solscan.io/token/${ca}${clusterQuery}` : `https://solscan.io`;
  if (isBase) {
    explorerName = 'Basescan';
    explorerUrl = ca ? `https://basescan.org/token/${ca}` : `https://basescan.org`;
  } else if (isEth) {
    explorerName = 'Etherscan';
    explorerUrl = ca ? `https://etherscan.io/token/${ca}` : `https://etherscan.io`;
  }

  // Photon SOL
  const photonUrl = ca && isSolana ? `https://photon-sol.tinyastro.io/en/lp/${ca}` : `https://photon-sol.tinyastro.io`;

  // BullX
  const bullxUrl = ca && isSolana ? `https://bullx.io/terminal?chainId=1399811149&address=${ca}` : `https://bullx.io`;

  // Axiom Trade
  const axiomUrl = ca && isSolana ? `https://axiom.trade/t/${ca}` : `https://axiom.trade`;

  // X / Twitter (Official link or search)
  const twitterClean = sanitizeTwitterUrl(twitter, sym, isSolana);

  // Telegram (Official link or undefined)
  const telegramClean = sanitizeTelegramUrl(telegram);

  // Project Website (Official link or undefined)
  const websiteClean = sanitizeExternalUrl(website);

  const items: TokenLinkItem[] = [
    {
      id: 'dexscreener',
      name: 'DexScreener',
      shortName: 'DexScreener',
      url: dexscreenerUrl,
      description: 'Real-time candlestick charts, 5m/1h volume, liquidity & live order flow',
      colorClass: 'text-cyan-400 hover:text-cyan-300 border-cyan-500/40 hover:border-cyan-400',
      badgeBgClass: 'bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
      isAvailable: Boolean(ca || sym),
    },
    {
      id: 'pumpfun',
      name: 'Pump.fun',
      shortName: 'Pump.fun',
      url: pumpfunUrl,
      description: 'Bonding curve progress, developer profile, and live coin chat room',
      colorClass: 'text-rose-400 hover:text-rose-300 border-rose-500/40 hover:border-rose-400',
      badgeBgClass: 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border-rose-500/30',
      isAvailable: isPumpFunEligible && Boolean(ca),
    },
    {
      id: 'gmgn',
      name: 'GMGN.ai',
      shortName: 'GMGN',
      url: gmgnUrl,
      description: 'Smart money wallet tracking, top holder sniper analysis, and dev holding flow',
      colorClass: 'text-emerald-400 hover:text-emerald-300 border-emerald-500/40 hover:border-emerald-400',
      badgeBgClass: 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      isAvailable: Boolean(ca),
    },
    {
      id: 'birdeye',
      name: 'Birdeye',
      shortName: 'Birdeye',
      url: birdeyeUrl,
      description: 'Institutional DEX aggregator, depth analysis, and security verification',
      colorClass: 'text-blue-400 hover:text-blue-300 border-blue-500/40 hover:border-blue-400',
      badgeBgClass: 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border-blue-500/30',
      isAvailable: Boolean(ca),
    },
    {
      id: 'solscan',
      name: explorerName,
      shortName: explorerName,
      url: explorerUrl,
      description: 'On-chain block explorer, token accounts, top holders, and mint status',
      colorClass: 'text-purple-400 hover:text-purple-300 border-purple-500/40 hover:border-purple-400',
      badgeBgClass: 'bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border-purple-500/30',
      isAvailable: Boolean(ca),
    },
    {
      id: 'photon',
      name: 'Photon SOL',
      shortName: 'Photon',
      url: photonUrl,
      description: 'Ultra-fast trading terminal with millisecond price updates and quick-swap',
      colorClass: 'text-amber-400 hover:text-amber-300 border-amber-500/40 hover:border-amber-400',
      badgeBgClass: 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border-amber-500/30',
      isAvailable: isSolana && Boolean(ca),
    },
    {
      id: 'bullx',
      name: 'BullX',
      shortName: 'BullX',
      url: bullxUrl,
      description: 'Hybrid multi-chain trading terminal with pump.fun integration',
      colorClass: 'text-teal-400 hover:text-teal-300 border-teal-500/40 hover:border-teal-400',
      badgeBgClass: 'bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 border-teal-500/30',
      isAvailable: isSolana && Boolean(ca),
    },
    {
      id: 'axiom',
      name: 'Axiom Trade',
      shortName: 'Axiom',
      url: axiomUrl,
      description: 'High-speed execution terminal with MEV protection and instant fills',
      colorClass: 'text-orange-400 hover:text-orange-300 border-orange-500/40 hover:border-orange-400',
      badgeBgClass: 'bg-orange-500/10 hover:bg-orange-500/20 text-orange-300 border-orange-500/30',
      isAvailable: isSolana && Boolean(ca),
    },
    {
      id: 'twitter',
      name: twitter ? '𝕏 (Official Profile)' : '𝕏 (Twitter Search)',
      shortName: twitter ? '𝕏 Official' : '𝕏 Search',
      url: twitterClean,
      description: twitter
        ? 'Verified project 𝕏 handle, dev updates, and community presence'
        : 'Search live influencer callouts, caller confluence, and community sentiment',
      colorClass: 'text-sky-400 hover:text-sky-300 border-sky-500/40 hover:border-sky-400',
      badgeBgClass: 'bg-sky-500/10 hover:bg-sky-500/20 text-sky-300 border-sky-500/30',
      isAvailable: Boolean(sym || twitter),
    },
  ];

  if (telegramClean) {
    items.push({
      id: 'telegram',
      name: 'Official Telegram',
      shortName: 'Telegram',
      url: telegramClean,
      description: 'Official verified Telegram community channel, dev announcements & voice rooms',
      colorClass: 'text-blue-400 hover:text-blue-300 border-blue-500/40 hover:border-blue-400',
      badgeBgClass: 'bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border-blue-500/30',
      isAvailable: true,
    });
  }

  if (websiteClean) {
    items.push({
      id: 'website',
      name: 'Project Website',
      shortName: 'Website',
      url: websiteClean,
      description: 'Official project homepage, whitepaper documentation & dapp interface',
      colorClass: 'text-emerald-400 hover:text-emerald-300 border-emerald-500/40 hover:border-emerald-400',
      badgeBgClass: 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      isAvailable: true,
    });
  }

  if (testCluster) {
    // These sites index mainnet only: a devnet / localnet mint is not there, and a link to a mainnet page for the same address misleads.
    const mainnetOnly = new Set(['dexscreener', 'pumpfun', 'gmgn', 'birdeye', 'photon', 'bullx', 'axiom']);
    for (const item of items) {
      if (mainnetOnly.has(item.id)) {
        item.isAvailable = false;
        item.description = `Mainnet only: this token is on ${testCluster}, so ${item.shortName} does not list it`;
      }
    }
  }

  return items;
}
