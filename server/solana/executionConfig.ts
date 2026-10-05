import { PublicKey } from '@solana/web3.js';
import { getRandomJitoTipAccount } from './programs';

export interface AuthoritativeExecutionConfig {
  jitoBlockEngineUrl: string;
  jitoTipAccount: string;
  defaultJitoTipSol: number;
  maxJitoTipSol: number;
  minJitoTipSol: number;
  priorityFeeMicrolamports: number;
  maxSlippageBps: number;
  capitalTier: 'MICRO_10' | 'INSTITUTIONAL' | 'CUSTOM';
  maxDailyLossUsd: number;
  maxPositionSizeSol: number;
  demoMode: boolean;
  enableSyntheticSocial: boolean;
  // R0.5 & R0.6 Authoritative Execution, Retry & Fallback Configuration
  jitoMaxRetries: number;
  jitoRetryIntervalMs: number;
  enableRpcFallback: boolean;
  rpcFallbackTimeoutMs: number;
  bundleConfirmTimeoutMs: number;
  jitoProbeIntervalMs: number;
}

/**
 * Dynamic Jito Tip Sizing (B07, B24):
 * Scale tips dynamically at 3.0% of trade notional, bounded between 150,000 lamports floor and 1,000,000 lamports ceiling:
 * TipLamports = Math.max(150_000, Math.min(1_000_000, Math.floor(tradeNotionalSol * 1e9 * 0.03)))
 * Default for 0.006 SOL trade is 180,000 lamports (0.00018 SOL).
 */
export function calculateDynamicJitoTip(tradeNotionalSol: number): number {
  if (!Number.isFinite(tradeNotionalSol) || tradeNotionalSol <= 0) {
    return 180_000;
  }
  return Math.max(150_000, Math.min(1_000_000, Math.floor(tradeNotionalSol * 1e9 * 0.03)));
}

export function calculateDynamicJitoTipSol(tradeNotionalSol: number): number {
  return calculateDynamicJitoTip(tradeNotionalSol) / 1e9;
}

// Single source of truth configuration parsed from environment with strict production defaults
class ExecutionConfigManager {
  private config: AuthoritativeExecutionConfig;

  constructor() {
    const rawTier = (process.env.CAPITAL_TIER || 'MICRO_10').toUpperCase();
    const capitalTier = (rawTier === 'INSTITUTIONAL' || rawTier === 'CUSTOM' ? rawTier : 'MICRO_10') as 'MICRO_10' | 'INSTITUTIONAL' | 'CUSTOM';

    const defaultTipSol = parseFloat(
      process.env.DEFAULT_JITO_TIP_SOL ||
      process.env.JITO_TIP_SOL ||
      (process.env.JITO_DEFAULT_TIP_LAMPORTS ? (parseInt(process.env.JITO_DEFAULT_TIP_LAMPORTS, 10) / 1e9).toString() : '0.00018')
    );
    const maxTipSol = parseFloat(process.env.MAX_JITO_TIP_SOL || '0.05');
    const minTipSol = parseFloat(process.env.MIN_JITO_TIP_SOL || '0.00015');

    this.config = {
      jitoBlockEngineUrl: (process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf').replace(/\/$/, ''),
      jitoTipAccount: process.env.JITO_TIP_ACCOUNT || '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
      defaultJitoTipSol: Number.isFinite(defaultTipSol) && defaultTipSol > 0 ? defaultTipSol : 0.00018,
      maxJitoTipSol: Number.isFinite(maxTipSol) && maxTipSol > 0 ? maxTipSol : 0.05,
      minJitoTipSol: Number.isFinite(minTipSol) && minTipSol > 0 ? minTipSol : 0.00015,
      priorityFeeMicrolamports: parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || '25000', 10) || 25000,
      maxSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '800', 10) || 800,
      capitalTier,
      maxDailyLossUsd: parseFloat(process.env.MAX_DAILY_LOSS_USD || (capitalTier === 'MICRO_10' ? '2.50' : '250.00')),
      maxPositionSizeSol: parseFloat(process.env.MAX_POSITION_SIZE_SOL || (capitalTier === 'MICRO_10' ? '0.02' : '1.50')),
      demoMode: process.env.DEMO_MODE === 'true',
      enableSyntheticSocial: process.env.ENABLE_SYNTHETIC_SOCIAL === 'true',
      jitoMaxRetries: parseInt(process.env.JITO_MAX_RETRIES || '2', 10) || 2,
      jitoRetryIntervalMs: parseInt(process.env.JITO_RETRY_INTERVAL_MS || '1000', 10) || 1000,
      enableRpcFallback: process.env.ENABLE_RPC_FALLBACK === 'true',
      rpcFallbackTimeoutMs: parseInt(process.env.RPC_FALLBACK_TIMEOUT_MS || '15000', 10) || 15000,
      bundleConfirmTimeoutMs: parseInt(process.env.BUNDLE_CONFIRM_TIMEOUT_MS || '15000', 10) || 15000,
      jitoProbeIntervalMs: parseInt(process.env.JITO_PROBE_INTERVAL_MS || '15000', 10) || 15000,
    };
  }

  public getConfig(): Readonly<AuthoritativeExecutionConfig> {
    return { ...this.config };
  }

  public updateConfig(partial: Partial<AuthoritativeExecutionConfig>): AuthoritativeExecutionConfig {
    this.config = {
      ...this.config,
      ...partial,
    };
    return { ...this.config };
  }

  public getJitoTipAccountPublicKey(): PublicKey {
    try {
      return new PublicKey(this.config.jitoTipAccount);
    } catch {
      return getRandomJitoTipAccount();
    }
  }

  public calculateDynamicTipLamports(tradeNotionalSol: number): number {
    return calculateDynamicJitoTip(tradeNotionalSol);
  }

  public calculateDynamicTipSol(tradeNotionalSol: number): number {
    return calculateDynamicJitoTipSol(tradeNotionalSol);
  }

  /**
   * Authoritative Bounded Jito Tip Policy:
   * 1. Current Live Tip Floor (from Jito telemetry)
   * 2. Urgency Multiplier (e.g., 1.25x for competitive alpha snipes)
   * 3. Operator Maximum Cap (hard ceiling)
   * 4. Economic Sanity Check (fees should not exceed 25% of trade notional)
   * 5. Dynamic Notional Scaling: 3.0% of trade notional, bounded [150k, 1M] lamports
   * 6. Selected Tip used across: Quote, Risk, Transaction, and Accounting
   */
  public resolveDynamicJitoTip(params: {
    tipFloorLamports?: number | null;
    urgencyMultiplier?: number;
    operatorMaxSol?: number;
    tradeAmountSol?: number;
    tradeNotionalSol?: number;
    explicitTipSol?: number;
  }): {
    tipLamports: number;
    tipSol: number;
    policyReason: string;
    isDynamic: boolean;
  } {
    const {
      tipFloorLamports,
      urgencyMultiplier = 1.25,
      operatorMaxSol,
      tradeAmountSol,
      tradeNotionalSol,
      explicitTipSol,
    } = params;

    const notionalSol = tradeNotionalSol ?? tradeAmountSol;
    const minFloorLamports = Math.round(this.config.minJitoTipSol * 1e9);
    const maxCeilingLamports = Math.round((operatorMaxSol ?? this.config.maxJitoTipSol) * 1e9);

    // 1. Explicit override if provided and within operator bounds
    if (explicitTipSol !== undefined && explicitTipSol !== null && explicitTipSol > 0) {
      const explicitLamports = Math.round(explicitTipSol * 1e9);
      let boundedLamports = Math.min(Math.max(explicitLamports, minFloorLamports), maxCeilingLamports);
      // Scale tip for micro-trades so execution cost stays strictly below risk threshold
      if (notionalSol && notionalSol > 0) {
        const maxMicroTipLamports = Math.round(notionalSol * 0.15 * 1e9);
        if (maxMicroTipLamports >= 10_000 && boundedLamports > maxMicroTipLamports) {
          boundedLamports = maxMicroTipLamports;
        }
      }
      return {
        tipLamports: boundedLamports,
        tipSol: boundedLamports / 1e9,
        policyReason: `EXPLICIT_OVERRIDE (Bounded between ${this.config.minJitoTipSol} and ${operatorMaxSol ?? this.config.maxJitoTipSol} SOL, scaled for order size)`,
        isDynamic: false,
      };
    }

    // 2. Dynamic tip calculation: live tip floor or dynamic notional scaling (3% bounded [150k, 1M])
    let baseLamports: number;
    let isDynamic = false;
    let reason: string;

    if (tipFloorLamports !== null && tipFloorLamports !== undefined && tipFloorLamports > 0) {
      baseLamports = Math.round(tipFloorLamports * urgencyMultiplier);
      isDynamic = true;
      reason = `JITO_LIVE_FLOOR (${tipFloorLamports} lamports) x ${urgencyMultiplier} urgency`;
    } else if (notionalSol !== undefined && Number.isFinite(notionalSol) && notionalSol > 0) {
      baseLamports = calculateDynamicJitoTip(notionalSol);
      isDynamic = true;
      reason = `DYNAMIC_NOTIONAL_SCALING (3% of ${notionalSol} SOL bounded [150k, 1M] -> ${baseLamports} lamports)`;
    } else {
      baseLamports = Math.round(this.config.defaultJitoTipSol * 1e9);
      reason = `DEFAULT_CONFIGURED_TIP (${this.config.defaultJitoTipSol} SOL fallback)`;
    }

    // Apply urgency multiplier if explicit urgency given on notional/fallback
    let calculatedLamports = (params.urgencyMultiplier !== undefined && !tipFloorLamports)
      ? Math.round(baseLamports * urgencyMultiplier)
      : baseLamports;

    // Enforce floor
    calculatedLamports = Math.max(calculatedLamports, minFloorLamports);

    // Enforce operator ceiling
    if (calculatedLamports > maxCeilingLamports) {
      calculatedLamports = maxCeilingLamports;
      reason += ` -> CAPPED by operator maximum (${(maxCeilingLamports / 1e9).toFixed(4)} SOL)`;
    }

    // 4. Economic sanity check: tip should not exceed 15% of trade value (if tradeAmountSol provided)
    if (notionalSol && notionalSol > 0) {
      const maxEconomicTipLamports = Math.round(notionalSol * 0.15 * 1e9);
      if (maxEconomicTipLamports >= 10_000 && calculatedLamports > maxEconomicTipLamports) {
        calculatedLamports = maxEconomicTipLamports;
        reason += ` -> CAPPED by economic sanity rule (15% of ${notionalSol.toFixed(4)} SOL trade)`;
      }
    }

    // Absolute minimum for Jito bundle inclusion
    const finalLamports = Math.max(calculatedLamports, 10_000); // 0.00001 SOL absolute minimum

    return {
      tipLamports: finalLamports,
      tipSol: finalLamports / 1e9,
      policyReason: reason,
      isDynamic,
    };
  }
}

export const executionConfig = new ExecutionConfigManager();
