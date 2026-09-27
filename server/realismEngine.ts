import { MicrostructureRealismConfig, CoLocationRegion, ExchangeFeeTier } from '../src/types';

export class MicrostructureRealismEngine {
  private config: MicrostructureRealismConfig = {
    region: 'AWS_TOKYO_AP_NORTHEAST_1',
    networkLatencyMs: 1.15,
    queuePositionModeling: true,
    toxicFlowAdverseSelection: true,
    feeTier: 'VIP_0',
    makerFeeBps: 8.0, // 0.08% maker fee on VIP0
    takerFeeBps: 10.0, // 0.10% taker fee on VIP0
    slippageModelEnabled: true,
    jitoMevProtection: true,
  };

  private regionLatencyMap: Record<CoLocationRegion, { rtt: number; jitter: number; packetLoss: number; description: string }> = {
    AWS_TOKYO_AP_NORTHEAST_1: {
      rtt: 1.15,
      jitter: 0.04,
      packetLoss: 0.0,
      description: 'Equinix TY2 / AWS Tokyo ap-northeast-1 Direct Cross-Connect (Sub-millisecond direct dark fiber to Binance & Bybit matching engines)',
    },
    TOKYO_RETAIL_FIBER: {
      rtt: 18.5,
      jitter: 2.4,
      packetLoss: 0.02,
      description: 'Tokyo Domestic Fiber (NTT/KDDI broadband to exchange public gateway)',
    },
    AWS_OREGON_US_WEST_2: {
      rtt: 94.8,
      jitter: 7.2,
      packetLoss: 0.15,
      description: 'US West / Oregon (Trans-Pacific Subsea Cable FASTER/Unity with Pacific transit hop)',
    },
    AWS_FRANKFURT_EU_CENTRAL_1: {
      rtt: 184.2,
      jitter: 12.8,
      packetLoss: 0.35,
      description: 'Europe / Frankfurt eu-central-1 (Eurasian fiber route via Suez / Middle East transit)',
    },
  };

  private feeSchedule: Record<ExchangeFeeTier, { maker: number; taker: number; name: string }> = {
    VIP_0: { maker: 8.0, taker: 10.0, name: 'VIP 0 Standard Retail (<$1M 30d Vol)' },
    VIP_1: { maker: 6.0, taker: 8.0, name: 'VIP 1 Active Trader (>$1M 30d Vol)' },
    VIP_4: { maker: 2.5, taker: 4.5, name: 'VIP 4 Semi-Pro (>$25M 30d Vol)' },
    VIP_9_NEGATIVE_MAKER: { maker: -0.5, taker: 1.8, name: 'VIP 9 Institutional MM (-0.5 bps maker rebate)' },
  };

  public getConfig(): MicrostructureRealismConfig {
    return this.config;
  }

  public getRegionDetails() {
    return this.regionLatencyMap;
  }

  public getFeeSchedule() {
    return this.feeSchedule;
  }

  public updateConfig(partial: Partial<MicrostructureRealismConfig>): MicrostructureRealismConfig {
    this.config = { ...this.config, ...partial };
    if (partial.region && this.regionLatencyMap[partial.region]) {
      this.config.networkLatencyMs = this.regionLatencyMap[partial.region].rtt;
    }
    if (partial.feeTier && this.feeSchedule[partial.feeTier]) {
      this.config.makerFeeBps = this.feeSchedule[partial.feeTier].maker;
      this.config.takerFeeBps = this.feeSchedule[partial.feeTier].taker;
    }
    return this.config;
  }

  // Calculate realistic fill probability given queue depth and order side
  public calculateQueueFillProbability(queueRank: number, totalVolumeAtLevel: number, incomingTakerVolume: number): number {
    if (!this.config.queuePositionModeling) return 1.0;
    // Standard price-time priority (FIFO matching)
    const queueDepleted = incomingTakerVolume / Math.max(1, totalVolumeAtLevel);
    const rankFraction = queueRank / Math.max(1, totalVolumeAtLevel);
    if (queueDepleted >= rankFraction) return 1.0;
    return Math.max(0.05, queueDepleted / Math.max(0.01, rankFraction));
  }

  // Calculate market impact and slippage using Square-Root Law: Impact = Y * sigma * sqrt(OrderSize / DailyVolume)
  public calculateMarketImpactSlippageBps(orderNotionalUsd: number, dailyVolumeUsd: number, volatility: number = 0.02): number {
    if (!this.config.slippageModelEnabled) return 0.5;
    const participationRate = orderNotionalUsd / Math.max(1000, dailyVolumeUsd);
    const impact = 0.6 * volatility * Math.sqrt(participationRate) * 10000;
    return Number(Math.max(0.2, impact).toFixed(2));
  }
}

export const realismEngine = new MicrostructureRealismEngine();
