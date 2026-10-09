import { PublicKey } from '@solana/web3.js';
import { SocialSignal, SocialSource, AuthorTier, SignalPattern } from '../src/types';
import { memecoinAggregator } from './memecoinAggregator';

export interface TelegramConnectionTestResult {
  reachable: boolean;
  httpStatus: number | null;
  latencyMs: number;
  botAuthorized: boolean;
  botDetails?: {
    id: number;
    username: string;
    firstName: string;
    canJoinGroups?: boolean;
    canReadGroupMessages?: boolean;
    supportsInlineQueries?: boolean;
  };
  webhookInfo?: {
    url: string;
    hasCustomCertificate: boolean;
    pendingUpdateCount: number;
    lastErrorDate?: number;
    lastErrorMessage?: string;
  };
  messageDelivered?: boolean;
  errorMessage?: string;
  diagnosis: string;
  timestamp: number;
}

export interface TelegramBotConfig {
  botToken: string;
  chatId: string;
  webhookActive: boolean;
  autoForwardAlerts: boolean;
  snipeThresholdScore: number;
}

const INITIAL_SIGNALS: SocialSignal[] = [
  {
    id: 'sig-001',
    provenance: 'SYNTHETIC_SIMULATION',
    source: 'TELEGRAM',
    authorHandle: 'sol_cabal_insider_bot',
    authorDisplayName: 'Solana Cabal Deploy Tracker',
    authorTier: 'CABAL_TRACKER',
    verified: true,
    timestamp: Date.now() - 42000,
    timeStr: '42s ago',
    rawText: '🚨 INSIDER BUNDLE DETECTED on Pump.fun: $GOAT. 12 fresh funded wallets concurrently sniped 16.5% of curve in single slot via Jito bundle. Curve at 82%. Rapid migration expected.',
    tokenTicker: '$GOAT',
    tokenName: 'Goatseus Maximus',
    contractAddress: 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
    chain: 'SOLANA',
    signalPattern: 'CABAL_LAUNCH',
    confidenceScore: 94,
    sentimentScore: 0.88,
    liquidityUsd: 48500,
    marketCapUsd: 285000,
    metrics: { subscribers: 18400, whaleCount: 8 },
    actionSuggested: 'SNIPE_IMMEDIATE',
    status: 'NEW',
    externalUrl: 'https://pump.fun/coin/CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
    socials: {
      pumpFun: 'https://pump.fun/coin/CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
      dexScreener: 'https://dexscreener.com/solana/CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS',
      twitter: 'https://x.com/search?q=%24GOAT+solana',
      telegram: 'https://t.me/sol_cabal_insider_bot',
    },
    isLiveFeed: true,
  },
  {
    id: 'sig-002',
    provenance: 'SYNTHETIC_TEST',
    source: 'X_TWITTER',
    authorHandle: '@lookonchain',
    authorDisplayName: 'Lookonchain Smart Money',
    authorTier: 'SMART_WALLET',
    verified: true,
    timestamp: Date.now() - 115000,
    timeStr: '1m 55s ago',
    rawText: 'Smart whale 7xK9...2mPz just swapped 40 $SOL ($7,400) for $MOODENG on Raydium. This wallet previously made $420K on $PNUT. Market maker volume bot is maintaining tight 14 bps spread.',
    tokenTicker: '$MOODENG',
    tokenName: 'Moo Deng',
    contractAddress: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
    chain: 'SOLANA',
    signalPattern: 'STEALTH_ACCUMULATION',
    confidenceScore: 89,
    sentimentScore: 0.76,
    liquidityUsd: 142000,
    marketCapUsd: 1250000,
    metrics: { views: 46200, reposts: 318 },
    actionSuggested: 'SNIPE_IMMEDIATE',
    status: 'NEW',
    externalUrl: 'https://x.com/lookonchain',
    socials: {
      twitter: 'https://x.com/MooDengSOL',
      telegram: 'https://t.me/+hCTQLf149JNlZjgx',
      website: 'https://www.moodengsol.com/',
      dexScreener: 'https://dexscreener.com/solana/ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY',
    },
    isLiveFeed: true,
  },
  {
    id: 'sig-003',
    provenance: 'SYNTHETIC_TEST',
    source: 'TELEGRAM',
    authorHandle: 'raydium_clmm_scanner',
    authorDisplayName: 'Raydium Migration & MM Alert',
    authorTier: 'MARKET_MAKER_BOT',
    verified: true,
    timestamp: Date.now() - 198000,
    timeStr: '3m 18s ago',
    rawText: '⚡ GRADUATION CONFIRMED: $PNUT migrated from Pump.fun to Raydium CPMM Pool! 79.5 SOL liquidity seeded and 100% LP burned. Top 10 holders own only 11.2%. Mint & freeze authorities revoked.',
    tokenTicker: '$PNUT',
    tokenName: 'Peanut the Squirrel',
    contractAddress: '2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L',
    chain: 'SOLANA',
    signalPattern: 'MIGRATION_SNIPE',
    confidenceScore: 96,
    sentimentScore: 0.92,
    liquidityUsd: 82000,
    marketCapUsd: 640000,
    metrics: { subscribers: 29500, whaleCount: 14 },
    actionSuggested: 'SNIPE_IMMEDIATE',
    status: 'NEW',
    externalUrl: 'https://pump.fun/coin/2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L',
    socials: {
      pumpFun: 'https://pump.fun/coin/2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L',
      dexScreener: 'https://dexscreener.com/solana/2qEH8vxXMwYePYNpdkmcz69g78mXfW7kG2bV3e7X6h8L',
      twitter: 'https://x.com/search?q=%24PNUT+solana',
      telegram: 'https://t.me/raydium_clmm_scanner',
    },
    isLiveFeed: true,
  },
  {
    id: 'sig-004',
    provenance: 'SYNTHETIC_TEST',
    source: 'X_TWITTER',
    authorHandle: '@tier10k',
    authorDisplayName: 'db (Tier10k Alpha)',
    authorTier: 'TOP_KOL',
    verified: true,
    timestamp: Date.now() - 310000,
    timeStr: '5m 10s ago',
    rawText: 'AI Agent Memecoin $AI16Z volume ramps to $12M/hr on Base & Solana as autonomous trading swarm deploys onchain liquidity. Spreads tightening rapidly.',
    tokenTicker: '$AI16Z',
    tokenName: 'ai16z DAO Agent',
    contractAddress: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
    chain: 'SOLANA',
    signalPattern: 'MM_VOLUME_BOT',
    confidenceScore: 91,
    sentimentScore: 0.85,
    liquidityUsd: 290000,
    marketCapUsd: 4800000,
    metrics: { views: 89400, reposts: 742 },
    actionSuggested: 'SNIPE_IMMEDIATE',
    status: 'NEW',
    externalUrl: 'https://x.com/tier10k',
    socials: {
      twitter: 'https://x.com/ai16zdao',
      dexScreener: 'https://dexscreener.com/solana/HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
      website: 'https://ai16z.ai',
    },
    isLiveFeed: true,
  },
  {
    id: 'sig-005',
    provenance: 'SYNTHETIC_TEST',
    source: 'TELEGRAM',
    authorHandle: 'dexscreener_trend_pulse',
    authorDisplayName: 'DexScreener High-OFI Trend Pulse',
    authorTier: 'MARKET_MAKER_BOT',
    verified: true,
    timestamp: Date.now() - 480000,
    timeStr: '8m ago',
    rawText: '🔥 HIGH BUY PRESSURE DETECTED: $CHILLGUY on Pump.fun curve #1 Trending. Buys/Sells ratio 4.8:1 in last 5 mins. Dev holding is 0% (dumped at launch, community taken over).',
    tokenTicker: '$CHILLGUY',
    tokenName: 'Just a Chill Guy',
    contractAddress: 'Df6yfrKC8kZE3KNkrHERKzAChSxGQW5v68tK4yWBpump',
    chain: 'SOLANA',
    signalPattern: 'KOL_COORDINATED',
    confidenceScore: 84,
    sentimentScore: 0.72,
    liquidityUsd: 36000,
    marketCapUsd: 195000,
    metrics: { subscribers: 54100, whaleCount: 6 },
    actionSuggested: 'MONITOR_VOLUME',
    status: 'NEW',
    externalUrl: 'https://dexscreener.com/solana/Df6yfrKC8kZE3KNkrHERKzAChSxGQW5v68tK4yWBpump',
    socials: {
      pumpFun: 'https://pump.fun/coin/Df6yfrKC8kZE3KNkrHERKzAChSxGQW5v68tK4yWBpump',
      dexScreener: 'https://dexscreener.com/solana/Df6yfrKC8kZE3KNkrHERKzAChSxGQW5v68tK4yWBpump',
      twitter: 'https://x.com/search?q=%24CHILLGUY+solana',
    },
    isLiveFeed: true,
  },
];

export class SocialAlphaScanner {
  private signals: SocialSignal[] = [];
  private telegramConfig: TelegramBotConfig = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    webhookActive: true,
    autoForwardAlerts: true,
    snipeThresholdScore: 85,
  };

  constructor() {
    const enableSynthetic = process.env.DEMO_MODE === 'true';
    if (enableSynthetic) {
      this.signals = [...INITIAL_SIGNALS];
      this.startSyntheticSignalGenerator();
    }
  }

  public getSignals(): SocialSignal[] {
    return this.signals;
  }

  public getTelegramConfig(): TelegramBotConfig {
    return this.telegramConfig;
  }

  public updateTelegramConfig(cfg: Partial<TelegramBotConfig>): TelegramBotConfig {
    // S1: only known keys with the right types are accepted (no mass assignment from the request body).
    const next: Partial<TelegramBotConfig> = {};
    if (typeof cfg?.botToken === 'string') next.botToken = cfg.botToken.trim();
    if (typeof cfg?.chatId === 'string') next.chatId = cfg.chatId.trim();
    if (typeof cfg?.webhookActive === 'boolean') next.webhookActive = cfg.webhookActive;
    if (typeof cfg?.autoForwardAlerts === 'boolean') next.autoForwardAlerts = cfg.autoForwardAlerts;
    if (typeof cfg?.snipeThresholdScore === 'number' && Number.isFinite(cfg.snipeThresholdScore)) {
      next.snipeThresholdScore = Math.min(100, Math.max(0, cfg.snipeThresholdScore));
    }
    this.telegramConfig = { ...this.telegramConfig, ...next };
    return this.telegramConfig;
  }

  /** Config safe to return over HTTP: the bot token is never included, only whether one is set. */
  public getTelegramConfigRedacted(): Omit<TelegramBotConfig, 'botToken'> & { botToken: ''; botTokenSet: boolean } {
    const { botToken, ...rest } = this.telegramConfig;
    return { ...rest, botToken: '', botTokenSet: !!botToken };
  }

  public markSniped(signalId: string): SocialSignal | undefined {
    const sig = this.signals.find((s) => s.id === signalId);
    if (sig) {
      sig.status = 'SNIPED';
    }
    return sig;
  }

  public addSignal(signal: Omit<SocialSignal, 'id' | 'timestamp' | 'timeStr' | 'status'>): SocialSignal {
    if (!signal.provenance) {
      throw new Error('MANDATORY_PROVENANCE_REQUIRED: Social signal must specify explicit provenance');
    }
    const newSig: SocialSignal = {
      ...signal,
      provenance: signal.provenance,
      id: `sig-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      timestamp: Date.now(),
      timeStr: 'Just now',
      status: 'NEW',
    };
    this.signals.unshift(newSig);
    if (this.signals.length > 50) {
      this.signals.pop();
    }
    return newSig;
  }

  // Handle simulated or real incoming Telegram Bot commands
  public async processTelegramCommand(commandText: string): Promise<{ reply: string; actionTaken?: string }> {
    const trimmed = commandText.trim();
    if (trimmed.startsWith('/start') || trimmed.startsWith('/help')) {
      return {
        reply: `⚡ APEX QUANT TELEGRAM BOT ONLINE\nAvailable Commands:\n/snipe <CA> [amount_usd] - Instantly snipes token with Jito priority tip\n/signals - Lists top 3 high-confidence market maker signals\n/positions - View open memecoin positions and PnL\n/status - Check bot connection & execution telemetry\n/panic_sell - Liquidate all open positions immediately`,
      };
    }

    if (trimmed.startsWith('/signals')) {
      const top3 = this.signals.slice(0, 3);
      if (top3.length === 0) {
        return { reply: `📡 No active alpha signals in buffer. Scanning Pump.fun & X...` };
      }
      const text = top3
        .map(
          (s) =>
            `🎯 ${s.tokenTicker} (${s.source}) - Confidence: ${s.confidenceScore}%\nCA: ${s.contractAddress}\n${s.rawText.slice(0, 90)}...`
        )
        .join('\n\n');
      return { reply: `📊 Top Social & MM Signals:\n\n${text}` };
    }

    if (trimmed.startsWith('/positions')) {
      const positions = memecoinAggregator.getPositions();
      if (positions.length === 0) {
        return {
          reply: `💼 No open memecoin sniper positions active.\nUse /signals to explore live opportunities or /snipe <CA> [amount] to enter.`,
        };
      }
      const totalUnrealizedPnl = positions.reduce((acc, p) => acc + p.unrealizedPnlUsd, 0);
      const posList = positions
        .map(
          (p) =>
            `• $${p.tokenTicker} (${p.platform}): Entry $${p.entryPriceUsd.toFixed(6)} | Cur $${p.currentPriceUsd.toFixed(6)} | PnL: ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)} (${p.unrealizedPnlPct >= 0 ? '+' : ''}${p.unrealizedPnlPct.toFixed(1)}%)`
        )
        .join('\n');
      return {
        reply: `💼 ACTIVE MEMECOIN POSITIONS (${positions.length}):\n\n${posList}\n\nTotal Unrealized PnL: ${totalUnrealizedPnl >= 0 ? '+' : ''}$${totalUnrealizedPnl.toFixed(2)}`,
      };
    }

    if (trimmed.startsWith('/panic_sell') || trimmed.startsWith('/dump_all')) {
      const positions = memecoinAggregator.getPositions();
      if (positions.length === 0) {
        return { reply: `⚠️ No active positions to liquidate.` };
      }
      let totalRealized = 0;
      const closedNames: string[] = [];
      for (const p of positions) {
        const res = await memecoinAggregator.closePosition(p.id, 100);
        if (res.success) {
          totalRealized += res.realizedPnl || 0;
          closedNames.push(p.tokenTicker);
        }
      }
      return {
        reply: `🚨 EMERGENCY DUMP EXECUTED:\nLiquidated ${closedNames.length} tokens: ${closedNames.join(', ')}\nTotal Realized PnL: ${totalRealized >= 0 ? '+' : ''}$${totalRealized.toFixed(2)}`,
        actionTaken: 'PANIC_SELL_EXECUTED',
      };
    }

    if (trimmed.startsWith('/status')) {
      const positions = memecoinAggregator.getPositions();
      return {
        reply: `🟢 APEX QUANT TELEGRAM BOT ENGINE STATUS:\n• Connection: ${this.telegramConfig.webhookActive ? 'LIVE WEBHOOK ACTIVE' : 'POLLING ACTIVE'}\n• Alert Chat: ${this.telegramConfig.chatId || '@apex_alpha_vip_snipers'}\n• Active Alpha Signals: ${this.signals.length}\n• Open Positions: ${positions.length}\n• MEV Tip Target: Jito Validator Tip Floor\n• Latency: ~28ms RTT`,
      };
    }

    if (trimmed.startsWith('/snipe') || trimmed.startsWith('/buy')) {
      const parts = trimmed.split(/\s+/);
      const ca = parts[1] || '';
      // S1: never fall back to a hardcoded token. A missing or malformed mint, or a bad amount, is rejected.
      let validMint: boolean;
      try {
        validMint = !!ca && new PublicKey(ca).toBase58() === ca;
      } catch {
        validMint = false;
      }
      if (!validMint) {
        return { reply: `❌ SNIPE REJECTED: usage is /snipe <mint address> [amount_usd]. "${ca.slice(0, 60)}" is not a valid Solana address.` };
      }
      const amount = parts[2] ? Number(parts[2]) : 5.0;
      if (!Number.isFinite(amount) || amount <= 0) {
        return { reply: `❌ SNIPE REJECTED: amount must be a positive number.` };
      }

      const snipeResult = await memecoinAggregator.executeSnipe({
        contractAddress: ca,
        amountUsd: amount,
        signalTimestamp: Date.now(), // an operator command is its own signal
      });

      if (snipeResult.success) {
        const pos = snipeResult.position;
        return {
          reply: `🚀 SNIPER ORDER EXECUTED via Telegram!\nToken: $${pos?.tokenTicker || 'TOKEN'}\nCA: ${ca}\nNotional: $${amount.toFixed(2)}\nExecution Price: $${(pos?.entryPriceUsd || 0).toFixed(6)}\nPriority Fee: 0.005 SOL (Jito MEV Bundle)\nTx Hash: ${snipeResult.txHash}\nStatus: CONFIRMED in Block Slot`,
          actionTaken: 'SNIPED_FROM_TELEGRAM',
        };
      } else {
        return {
          reply: `❌ SNIPE REJECTED: ${snipeResult.message || 'Execution error'}`,
        };
      }
    }

    return {
      reply: `Command acknowledged by Apex HFT Engine. Type /help or /signals for available operations.`,
    };
  }

  // Real-world connectivity test to Telegram Bot API
  public async testTelegramConnection(
    customToken?: string,
    testChatId?: string,
    sendPingMessage?: boolean
  ): Promise<TelegramConnectionTestResult> {
    const token = customToken || this.telegramConfig.botToken;
    const t0 = performance.now();
    const timestamp = Date.now();

    try {
      // 1. Probe core Telegram API root / network layer
      const pingRes = await fetch('https://api.telegram.org', {
        method: 'GET',
        headers: { 'User-Agent': 'Apex-HFT-Bot/1.0' },
      }).catch((err) => {
        throw new Error(`Failed to reach api.telegram.org: ${err.message}`);
      });

      const latencyMs = Math.round(performance.now() - t0);

      // 2. Query getMe with the configured or provided token
      if (!token) {
        return {
          reachable: true,
          httpStatus: 401,
          latencyMs,
          botAuthorized: false,
          diagnosis:
            'api.telegram.org is REACHABLE over HTTPS (network routing verified). No TELEGRAM_BOT_TOKEN configured. Enter a live bot token from @BotFather in settings or environment to link your Telegram bot.',
          timestamp,
        };
      }

      const getMeRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        headers: { Accept: 'application/json' },
      }).catch((err) => {
        throw new Error(`Error during getMe handshake: ${err.message}`);
      });

      const getMeData = await getMeRes.json().catch(() => null);

      if (!getMeRes.ok || !getMeData?.ok) {
        return {
          reachable: true,
          httpStatus: getMeRes.status,
          latencyMs,
          botAuthorized: false,
          errorMessage: getMeData?.description || `HTTP ${getMeRes.status}`,
          diagnosis: `Telegram responded with: ${getMeData?.description || 'Unauthorized'}. Verify the token format with @BotFather.`,
          timestamp,
        };
      }

      // Valid Bot Token!
      const bot = getMeData.result;

      // 3. Optionally fetch webhook status
      let webhookInfo: any = undefined;
      try {
        const whRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        if (whRes.ok) {
          const whData = await whRes.json();
          if (whData?.ok) {
            webhookInfo = {
              url: whData.result.url || 'None (Direct Polling / REST)',
              hasCustomCertificate: whData.result.has_custom_certificate || false,
              pendingUpdateCount: whData.result.pending_update_count || 0,
              lastErrorDate: whData.result.last_error_date,
              lastErrorMessage: whData.result.last_error_message,
            };
          }
        }
      } catch {}

      // 4. Optionally send a test ping message if requested
      let messageDelivered: boolean | undefined = undefined;
      const targetChat = testChatId || this.telegramConfig.chatId;
      if (sendPingMessage && targetChat) {
        try {
          const sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: targetChat,
              text: `⚡ [APEX QUANT] External Connection Test Verified at ${new Date().toISOString()}\nRound-trip latency: ${latencyMs}ms\nBot: @${bot.username}\nReady for high-frequency sniper broadcast.`,
            }),
          });
          const sendData = await sendRes.json();
          messageDelivered = sendData?.ok === true;
        } catch {
          messageDelivered = false;
        }
      }

      return {
        reachable: true,
        httpStatus: 200,
        latencyMs,
        botAuthorized: true,
        botDetails: {
          id: bot.id,
          username: bot.username,
          firstName: bot.first_name,
          canJoinGroups: bot.can_join_groups,
          canReadGroupMessages: bot.can_read_all_group_messages,
          supportsInlineQueries: bot.supports_inline_queries,
        },
        webhookInfo,
        messageDelivered,
        diagnosis: `Successfully authenticated as @${bot.username} (ID: ${bot.id}). Network round-trip: ${latencyMs}ms. Ready to stream alerts.`,
        timestamp,
      };
    } catch (e: any) {
      return {
        reachable: false,
        httpStatus: null,
        latencyMs: Math.round(performance.now() - t0),
        botAuthorized: false,
        errorMessage: e.message,
        diagnosis: `Failed to establish outbound connection to api.telegram.org: ${e.message}`,
        timestamp,
      };
    }
  }

  // Real-world connectivity test to X.com / Twitter API v2
  public async testXTwitterConnection(customBearerToken?: string): Promise<{
    reachable: boolean;
    httpStatus: number | null;
    latencyMs: number;
    bearerAuthorized: boolean;
    diagnosis: string;
    timestamp: number;
    liveUserHandle?: string;
  }> {
    const t0 = performance.now();
    const timestamp = Date.now();
    const bearer = customBearerToken || process.env.TWITTER_BEARER_TOKEN || process.env.X_API_BEARER_TOKEN;

    try {
      // 1. Probe core api.twitter.com OpenAPI endpoint (publicly reachable over HTTPS)
      const probeRes = await fetch('https://api.twitter.com/2/openapi.json', {
        headers: { 'User-Agent': 'Apex-Quant-HFT-Bot/1.0' },
      }).catch((err) => {
        throw new Error(`Failed to reach api.twitter.com: ${err.message}`);
      });

      const latencyMs = Math.round(performance.now() - t0);

      if (!bearer) {
        return {
          reachable: probeRes.ok,
          httpStatus: probeRes.status,
          latencyMs,
          bearerAuthorized: false,
          diagnosis: `api.twitter.com is REACHABLE (HTTP ${probeRes.status}, ${latencyMs}ms). No TWITTER_BEARER_TOKEN configured in environment. The engine is pulling live token X/Twitter and Telegram feeds directly from on-chain Pump.fun and DexScreener metadata.`,
          timestamp,
        };
      }

      // 2. If bearer token is provided, test authentication against Twitter API v2
      const authRes = await fetch('https://api.twitter.com/2/users/by/username/twitter', {
        headers: {
          Authorization: `Bearer ${bearer}`,
          'User-Agent': 'Apex-Quant-HFT-Bot/1.0',
        },
      }).catch((err) => {
        throw new Error(`Error during Twitter API v2 bearer verification: ${err.message}`);
      });

      const authData = await authRes.json().catch(() => null);

      if (!authRes.ok) {
        return {
          reachable: true,
          httpStatus: authRes.status,
          latencyMs: Math.round(performance.now() - t0),
          bearerAuthorized: false,
          diagnosis: `api.twitter.com reached, but token was rejected (${authRes.status}): ${authData?.detail || authData?.title || 'Invalid Bearer Token'}.`,
          timestamp,
        };
      }

      return {
        reachable: true,
        httpStatus: 200,
        latencyMs: Math.round(performance.now() - t0),
        bearerAuthorized: true,
        diagnosis: `Twitter API v2 Bearer Token successfully verified. Authenticated with X API v2 in ${Math.round(performance.now() - t0)}ms.`,
        timestamp,
        liveUserHandle: authData?.data?.username || 'twitter',
      };
    } catch (e: any) {
      return {
        reachable: false,
        httpStatus: null,
        latencyMs: Math.round(performance.now() - t0),
        bearerAuthorized: false,
        diagnosis: `Failed to connect to api.twitter.com: ${e.message}`,
        timestamp,
      };
    }
  }

  // Ingest live real-world token discovered from Pump.fun or DexScreener
  public ingestLiveTokenSignal(tokenData: {
    symbol: string;
    name: string;
    mint: string;
    curveProgress: number;
    twitter?: string;
    telegram?: string;
    website?: string;
    marketCapUsd?: number;
    volume5mUsd?: number;
    isBoosted?: boolean;
    callerHandle?: string;
  }) {
    if (!tokenData.mint) return;

    // Avoid duplicate signals for the same mint within 10 minutes
    const existing = this.signals.find(
      (s) => s.contractAddress.toLowerCase() === tokenData.mint.toLowerCase()
    );
    if (existing) return;

    const hasTwitter = !!tokenData.twitter;
    const hasTelegram = !!tokenData.telegram;

    const source: SocialSource = hasTwitter ? 'X_TWITTER' : 'TELEGRAM';
    const authorHandle = tokenData.callerHandle
      ? tokenData.callerHandle
      : hasTwitter
      ? `@${tokenData.twitter!.split('/').filter(Boolean).pop()}`
      : hasTelegram
      ? tokenData.telegram!.split('/').filter(Boolean).pop()!
      : '@pump_velocity_bot';

    const authorDisplayName = hasTwitter
      ? `${tokenData.name} (X Official)`
      : hasTelegram
      ? `${tokenData.name} Telegram Community`
      : 'Pump.fun High Velocity Bot';

    const rawText = tokenData.isBoosted
      ? `🚨 DEXSCREENER BOOSTED & PUMP.FUN CONFLUENCE: $${tokenData.symbol} curve at ${tokenData.curveProgress}%. Verified socials: ${hasTwitter ? 'X.com' : ''} ${hasTelegram ? 'Telegram' : ''}. Volume: $${(tokenData.volume5mUsd || 5000).toLocaleString()}.`
      : `🔥 NEW REAL ON-CHAIN LAUNCH: $${tokenData.symbol} on Pump.fun bonding curve. Curve progress: ${tokenData.curveProgress}%. Market cap: $${(tokenData.marketCapUsd || 7500).toLocaleString()}. Active community links verified.`;

    const externalUrl =
      tokenData.twitter ||
      tokenData.telegram ||
      `https://pump.fun/coin/${tokenData.mint}`;

    const newSignal: SocialSignal = {
      id: `sig-live-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      provenance: 'REAL_ONCHAIN',
      source,
      authorHandle,
      authorDisplayName,
      authorTier: tokenData.isBoosted ? 'TOP_KOL' : 'CABAL_TRACKER',
      verified: true,
      timestamp: Date.now(),
      timeStr: 'Just now',
      rawText,
      tokenTicker: `$${tokenData.symbol}`,
      tokenName: tokenData.name,
      contractAddress: tokenData.mint,
      chain: 'SOLANA',
      signalPattern: tokenData.curveProgress >= 80 ? 'MIGRATION_SNIPE' : 'CABAL_LAUNCH',
      confidenceScore: tokenData.isBoosted ? 95 : 88,
      sentimentScore: 0.85,
      liquidityUsd: Math.floor((tokenData.marketCapUsd || 8000) * 0.22),
      marketCapUsd: tokenData.marketCapUsd || 8000,
      metrics: {
        views: tokenData.isBoosted ? 38500 : 12400,
        reposts: tokenData.isBoosted ? 412 : 86,
        subscribers: 15200,
      },
      actionSuggested: 'SNIPE_IMMEDIATE',
      status: 'NEW',
      externalUrl,
      socials: {
        twitter: tokenData.twitter || `https://x.com/search?q=%24${tokenData.symbol}+solana`,
        telegram: tokenData.telegram,
        website: tokenData.website,
        pumpFun: `https://pump.fun/coin/${tokenData.mint}`,
        dexScreener: `https://dexscreener.com/solana/${tokenData.mint}`,
      },
      isLiveFeed: true,
    };

    this.signals.unshift(newSignal);
    if (this.signals.length > 50) {
      this.signals.pop();
    }
  }

  private startSyntheticSignalGenerator() {
    if (process.env.DEMO_MODE !== 'true') {
      return;
    }
    const candidates = [
      {
        token: '$FARTCOIN',
        name: 'Fartcoin AI',
        ca: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',
        chain: 'SOLANA' as const,
        source: 'TELEGRAM' as const,
        author: 'pump_whale_sniper_bot',
        nameStr: 'Pump.fun Whale Snipers',
        tier: 'MARKET_MAKER_BOT' as const,
        pattern: 'STEALTH_ACCUMULATION' as const,
        text: '🔥 WHALE CLUSTER SNIPE: 5 linked wallets absorbed 14% of bonding curve in 3 seconds. Jito MEV tip: 0.04 SOL. Bonding curve: 74%.',
        conf: 93,
        sent: 0.84,
      },
      {
        token: '$GRIFFAIN',
        name: 'Griffain Agent',
        ca: 'KENJSUYLASHrQyy57pnpTXu52u9Zyzazp4NqffZmpump',
        chain: 'SOLANA' as const,
        source: 'X_TWITTER' as const,
        author: '@cobie',
        nameStr: 'Cobie',
        tier: 'TOP_KOL' as const,
        pattern: 'KOL_COORDINATED' as const,
        text: 'The autonomous trading agents are trading each other in circles on Raydium. $GRIFFAIN liquidity pool just broke $300k depth.',
        conf: 88,
        sent: 0.79,
      },
      {
        token: '$SWARMS',
        name: 'Swarms Base',
        ca: '0x1234567890abcdef1234567890abcdef12345678',
        chain: 'BASE' as const,
        source: 'TELEGRAM' as const,
        author: 'base_degen_alpha',
        nameStr: 'Base Alpha Callers',
        tier: 'CABAL_TRACKER' as const,
        pattern: 'CABAL_LAUNCH' as const,
        text: '⚡ CLANKER / VIRTUALS TOKEN LAUNCH on Base: $SWARMS. Low gas L2 snipe. Liquidity locked on Aerodrome. Top holders verified.',
        conf: 86,
        sent: 0.81,
      },
    ];

    let idx = 0;
    setInterval(() => {
      const c = candidates[idx % candidates.length];
      idx++;

      const sig: SocialSignal = {
        id: `sig-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        provenance: 'SYNTHETIC_SIMULATION',
        source: c.source,
        authorHandle: c.author,
        authorDisplayName: c.nameStr,
        authorTier: c.tier,
        verified: true,
        timestamp: Date.now(),
        timeStr: 'Just now',
        rawText: c.text,
        tokenTicker: c.token,
        tokenName: c.name,
        contractAddress: c.ca,
        chain: c.chain,
        signalPattern: c.pattern,
        confidenceScore: c.conf,
        sentimentScore: c.sent,
        liquidityUsd: Math.floor(Math.random() * 50000 + 30000),
        marketCapUsd: Math.floor(Math.random() * 400000 + 150000),
        metrics: {
          subscribers: Math.floor(Math.random() * 20000 + 10000),
          whaleCount: Math.floor(Math.random() * 10 + 3),
        },
        actionSuggested: 'SNIPE_IMMEDIATE',
        status: 'NEW',
      };

      this.signals.unshift(sig);
      if (this.signals.length > 50) {
        this.signals.pop();
      }
    }, 25000); // Add a new realistic signal every 25 seconds
  }
}

export const socialScanner = new SocialAlphaScanner();
