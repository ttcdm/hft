/**
 * CurveVelocityEvaluator - Alpha Pipeline Integration (B14)
 *
 * Tracks bonding curve reserve transitions across Solana slots and measures
 * short-window trade flow volume (10-second and 30-second sliding windows).
 *
 * Computes slot acceleration v = Delta SOL / Delta slots and calculates
 * real trading flow momentum, acceleration, and buy volume surge.
 *
 * P4.3 (R1-58): acceleration decays. It is measured only between transitions seen in the last ACCELERATION_WINDOW_MS (10 s) of `now`, only between
 * two different slots (a same-slot pair, deltaSlots 0, says nothing about speed), and never from the create pseudo-transition (the curve's state at
 * the create event, recorded with `{ create: true }`). A dev buy in the create slot used to score the full 6 acceleration points for as long as the
 * mint was kept. A mint the watch window still holds is pinned against the 1,000-mint eviction (setPinned, wired by wireWatchPins).
 *
 * Not changed here: the trade flow (volume and buy-surge points) still counts every trade, the creator cluster's included. The pump feed records it
 * without the wallet, so the creator cluster cannot be told apart in this class (the watch window's own signals leave the cluster out, P4.1).
 */

/** P4.3: only transitions this recent count for slot acceleration. */
export const ACCELERATION_WINDOW_MS = 10_000;

export interface ReserveTransition {
  slot: number;
  realSolReservesSol: number;
  timestampMs: number;
  /** P4.3: the curve's state at the create event, not a trade. Never one end of an acceleration pair. */
  create?: boolean;
}

export interface TradeFlowEntry {
  solAmount: number;
  isBuy: boolean;
  timestampMs: number;
  slot?: number;
}

export interface CurveVelocityMetrics {
  mint: string;
  slotAcceleration: number;        // v = Delta SOL / Delta slots
  windowVelocitySolPerSec: number; // Delta SOL / Delta t (seconds)
  volume10sSol: number;            // 10s sliding window volume in SOL
  volume30sSol: number;            // 30s sliding window volume in SOL
  buyVolume10sSol: number;         // 10s buy volume in SOL
  buyVolume30sSol: number;         // 30s buy volume in SOL
  buyRatio10s: number;             // buyVolume10s / (volume10s || 1)
  velocityScore: number;           // Factor score: 0 - 15 (for ConfluenceEngine)
  normalizedScore: number;         // Normalized score: 0 - 100
  isSurging: boolean;              // Volume surge or high acceleration flag
  transitionCount: number;         // Total transitions tracked
  lastSlot: number;
}

export class CurveVelocityEvaluator {
  private transitionsByMint: Map<string, ReserveTransition[]> = new Map();
  private tradeFlowsByMint: Map<string, TradeFlowEntry[]> = new Map();

  private readonly maxTransitionsPerMint = 120;
  private readonly maxTradeFlowsPerMint = 600;
  /** S14: the number of mints kept, oldest first out. Per-mint lists were bounded; the maps themselves grew for as long as the feed ran. */
  private readonly maxMints = 1_000;
  private isPinned: (mint: string) => boolean = () => false;

  /** P4.3 (R1-58): a mint the watch window is still scoring is never evicted to make room (see wireWatchPins). */
  public setPinned(fn: (mint: string) => boolean): void {
    this.isPinned = fn;
  }

  private trimMints(): void {
    for (const m of [this.transitionsByMint, this.tradeFlowsByMint]) {
      if (m.size <= this.maxMints) continue;
      // oldest first, skipping pinned mints (the window holds at most a few dozen, so unpinned victims exist)
      for (const k of [...m.keys()]) {
        if (m.size <= this.maxMints) break;
        if (!this.isPinned(k)) m.delete(k);
      }
    }
  }

  /**
   * Record a bonding curve reserve transition at a specific Solana slot.
   */
  public recordTransition(
    mint: string,
    slot: number,
    realSolReservesSol: number,
    timestampMs?: number,
    opts: { create?: boolean } = {}
  ): void {
    const cleanMint = mint.trim();
    const now = timestampMs ?? Date.now();

    let list = this.transitionsByMint.get(cleanMint);
    if (!list) {
      list = [];
      this.transitionsByMint.set(cleanMint, list);
      this.trimMints();
    }

    list.push({
      slot,
      realSolReservesSol,
      timestampMs: now,
      ...(opts.create ? { create: true } : {}),
    });

    // Keep sorted by slot ascending (a stable sort: within one slot the arrival order is kept, so the last entry is the slot's closing state)
    list.sort((a, b) => a.slot - b.slot);

    if (list.length > this.maxTransitionsPerMint) {
      list.splice(0, list.length - this.maxTransitionsPerMint);
    }
  }

  /**
   * Record trade flow (buy/sell amount in SOL) for sliding window volume analysis.
   */
  public recordTradeFlow(
    mint: string,
    solAmount: number,
    isBuy: boolean,
    timestampMs?: number,
    slot?: number
  ): void {
    const cleanMint = mint.trim();
    const now = timestampMs ?? Date.now();

    let flows = this.tradeFlowsByMint.get(cleanMint);
    if (!flows) {
      flows = [];
      this.tradeFlowsByMint.set(cleanMint, flows);
      this.trimMints();
    }

    flows.push({
      solAmount: Math.max(0, solAmount),
      isBuy,
      timestampMs: now,
      slot,
    });

    if (flows.length > this.maxTradeFlowsPerMint) {
      flows.splice(0, flows.length - this.maxTradeFlowsPerMint);
    }
  }

  /**
   * Check if any transitions or trade flows have been recorded for a mint.
   */
  public hasData(mint: string): boolean {
    const cleanMint = mint.trim();
    const hasTransitions = (this.transitionsByMint.get(cleanMint)?.length ?? 0) > 0;
    const hasFlows = (this.tradeFlowsByMint.get(cleanMint)?.length ?? 0) > 0;
    return hasTransitions || hasFlows;
  }

  /**
   * Evaluate the curve velocity and trade flow metrics for a given mint.
   */
  public getMetrics(mint: string, nowMs?: number): CurveVelocityMetrics {
    const cleanMint = mint.trim();
    const now = nowMs ?? Date.now();

    const transitions = this.transitionsByMint.get(cleanMint) ?? [];
    const tradeFlows = this.tradeFlowsByMint.get(cleanMint) ?? [];

    return CurveVelocityEvaluator.calculateMetricsFromData(cleanMint, transitions, tradeFlows, now);
  }

  /**
   * Pure calculation engine for velocity metrics given snapshots and trade flows.
   */
  public static calculateMetricsFromData(
    mint: string,
    transitions: ReserveTransition[],
    tradeFlows: TradeFlowEntry[],
    nowMs: number = Date.now()
  ): CurveVelocityMetrics {
    let slotAcceleration = 0;
    let windowVelocitySolPerSec = 0;
    let lastSlot = 0;

    // 1. Calculate slot acceleration: v = Delta SOL / Delta slots, between the newest trade transition and the newest one of an earlier slot,
    //    both inside the last ACCELERATION_WINDOW_MS (P4.3: 0 when there is no such pair; never a same-slot pair or the create pseudo-transition)
    const recent = transitions.filter((t) => !t.create && t.timestampMs >= nowMs - ACCELERATION_WINDOW_MS && t.timestampMs <= nowMs);
    if (recent.length >= 2) {
      const latest = recent[recent.length - 1];
      let previous: ReserveTransition | undefined;
      for (let i = recent.length - 2; i >= 0; i--) if (recent[i].slot < latest.slot) { previous = recent[i]; break; }
      if (previous) {
        slotAcceleration = Number(((latest.realSolReservesSol - previous.realSolReservesSol) / (latest.slot - previous.slot)).toFixed(6));
      }
    }

    if (transitions.length >= 2) {
      const latest = transitions[transitions.length - 1];
      lastSlot = latest.slot;

      // Time derivative over window (Delta SOL / Delta t)
      const earliestInWindow = transitions[0];
      const deltaTSeconds = Math.max(0.001, (latest.timestampMs - earliestInWindow.timestampMs) / 1000);
      const totalDeltaSol = latest.realSolReservesSol - earliestInWindow.realSolReservesSol;
      windowVelocitySolPerSec = Number((totalDeltaSol / deltaTSeconds).toFixed(6));
    } else if (transitions.length === 1) {
      lastSlot = transitions[0].slot;
    }

    // 2. Sliding window trade flow volume: 10-second and 30-second windows
    const window10sStart = nowMs - 10_000;
    const window30sStart = nowMs - 30_000;

    let volume10sSol = 0;
    let volume30sSol = 0;
    let buyVolume10sSol = 0;
    let buyVolume30sSol = 0;

    for (const flow of tradeFlows) {
      if (flow.timestampMs >= window30sStart) {
        volume30sSol += flow.solAmount;
        if (flow.isBuy) {
          buyVolume30sSol += flow.solAmount;
        }

        if (flow.timestampMs >= window10sStart) {
          volume10sSol += flow.solAmount;
          if (flow.isBuy) {
            buyVolume10sSol += flow.solAmount;
          }
        }
      }
    }

    volume10sSol = Number(volume10sSol.toFixed(6));
    volume30sSol = Number(volume30sSol.toFixed(6));
    buyVolume10sSol = Number(buyVolume10sSol.toFixed(6));
    buyVolume30sSol = Number(buyVolume30sSol.toFixed(6));

    const buyRatio10s = volume10sSol > 0 ? Number((buyVolume10sSol / volume10sSol).toFixed(4)) : 0;

    // 3. Compute Curve Velocity Factor Score (0 - 15)
    // - Acceleration Component (up to 6 points)
    let accelPoints: number;
    if (slotAcceleration >= 0.5) {
      accelPoints = 6;
    } else if (slotAcceleration >= 0.2) {
      accelPoints = 5;
    } else if (slotAcceleration >= 0.05) {
      accelPoints = 4;
    } else if (slotAcceleration >= 0.01) {
      accelPoints = 2;
    } else if (slotAcceleration > 0) {
      accelPoints = 1;
    } else {
      accelPoints = 0;
    }

    // - Flow Volume Component (up to 5 points)
    let volumePoints: number;
    if (volume10sSol >= 2.0 || volume30sSol >= 5.0) {
      volumePoints = 5;
    } else if (volume10sSol >= 1.0 || volume30sSol >= 2.5) {
      volumePoints = 4;
    } else if (volume10sSol >= 0.4 || volume30sSol >= 1.0) {
      volumePoints = 3;
    } else if (volume10sSol >= 0.1 || volume30sSol >= 0.3) {
      volumePoints = 2;
    } else if (volume30sSol > 0) {
      volumePoints = 1;
    } else {
      volumePoints = 0;
    }

    // - Buy Volume Surge Component (up to 4 points)
    let surgePoints: number;
    if (buyRatio10s >= 0.8 && buyVolume10sSol >= 0.5) {
      surgePoints = 4;
    } else if (buyRatio10s >= 0.65 && buyVolume10sSol >= 0.2) {
      surgePoints = 3;
    } else if (buyRatio10s >= 0.5 && buyVolume10sSol > 0) {
      surgePoints = 2;
    } else if (buyVolume30sSol > 0 && buyVolume30sSol / Math.max(0.001, volume30sSol) >= 0.5) {
      surgePoints = 1;
    } else {
      surgePoints = 0;
    }

    const velocityScore = Math.min(15, Math.max(0, accelPoints + volumePoints + surgePoints));
    const normalizedScore = Math.min(100, Math.round((velocityScore / 15) * 100));

    const isSurging =
      (slotAcceleration >= 0.1 && volume10sSol >= 0.5) ||
      (volume10sSol >= 1.5 && buyRatio10s >= 0.7);

    return {
      mint,
      slotAcceleration,
      windowVelocitySolPerSec,
      volume10sSol,
      volume30sSol,
      buyVolume10sSol,
      buyVolume30sSol,
      buyRatio10s,
      velocityScore,
      normalizedScore,
      isSurging,
      transitionCount: transitions.length,
      lastSlot,
    };
  }

  /**
   * Helper to evaluate a velocity score directly from parametric overrides
   */
  public static evaluateFromParams(params: {
    slotAcceleration?: number;
    volume10sSol?: number;
    volume30sSol?: number;
    buyVolume10sSol?: number;
  }): { velocityScore: number; normalizedScore: number; isSurging: boolean } {
    const slotAcceleration = params.slotAcceleration ?? 0;
    const volume10sSol = params.volume10sSol ?? 0;
    const volume30sSol = Math.max(volume10sSol, params.volume30sSol ?? 0);
    const buyVolume10sSol = params.buyVolume10sSol ?? volume10sSol;
    const buyRatio10s = volume10sSol > 0 ? buyVolume10sSol / volume10sSol : 0;

    let accelPoints = 0;
    if (slotAcceleration >= 0.5) accelPoints = 6;
    else if (slotAcceleration >= 0.2) accelPoints = 5;
    else if (slotAcceleration >= 0.05) accelPoints = 4;
    else if (slotAcceleration >= 0.01) accelPoints = 2;
    else if (slotAcceleration > 0) accelPoints = 1;

    let volumePoints = 0;
    if (volume10sSol >= 2.0 || volume30sSol >= 5.0) volumePoints = 5;
    else if (volume10sSol >= 1.0 || volume30sSol >= 2.5) volumePoints = 4;
    else if (volume10sSol >= 0.4 || volume30sSol >= 1.0) volumePoints = 3;
    else if (volume10sSol >= 0.1 || volume30sSol >= 0.3) volumePoints = 2;
    else if (volume30sSol > 0) volumePoints = 1;

    let surgePoints = 0;
    if (buyRatio10s >= 0.8 && buyVolume10sSol >= 0.5) surgePoints = 4;
    else if (buyRatio10s >= 0.65 && buyVolume10sSol >= 0.2) surgePoints = 3;
    else if (buyRatio10s >= 0.5 && buyVolume10sSol > 0) surgePoints = 2;

    const velocityScore = Math.min(15, Math.max(0, accelPoints + volumePoints + surgePoints));
    const normalizedScore = Math.min(100, Math.round((velocityScore / 15) * 100));
    const isSurging =
      (slotAcceleration >= 0.1 && volume10sSol >= 0.5) ||
      (volume10sSol >= 1.5 && buyRatio10s >= 0.7);

    return { velocityScore, normalizedScore, isSurging };
  }

  /**
   * Reset data for a single mint or all mints
   */
  public clear(mint?: string): void {
    if (mint) {
      const clean = mint.trim();
      this.transitionsByMint.delete(clean);
      this.tradeFlowsByMint.delete(clean);
    } else {
      this.transitionsByMint.clear();
      this.tradeFlowsByMint.clear();
    }
  }
}

export const curveVelocityEvaluator = new CurveVelocityEvaluator();
