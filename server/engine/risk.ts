import { EngineOrder, PreTradeRiskLimits, OrderSide } from './types';

export interface RiskCheckResult {
  passed: boolean;
  code?: string;
  reason?: string;
}

export class PreTradeRiskEngine {
  private limits: PreTradeRiskLimits;
  private currentGrossInventory: number = 0;
  private currentDailyLossUsd: number = 0;
  private isCircuitBreakerTripped: boolean = false;
  private orderTimestampBuffer: number[] = [];
  private totalRejections: number = 0;

  constructor(customLimits?: Partial<PreTradeRiskLimits>) {
    this.limits = {
      maxOrderNotionalUsd: 50000,
      maxSingleOrderQty: 5.0,
      maxGrossInventoryQty: 10.0,
      maxShortInventoryQty: -10.0,
      maxOrdersPerSecond: 60,
      fatFingerPriceBandPct: 2.5,
      maxDailyLossUsd: 5000,
      selfTradePrevention: true,
      ...customLimits,
    };
  }

  public updateLimits(newLimits: Partial<PreTradeRiskLimits>) {
    this.limits = { ...this.limits, ...newLimits };
  }

  public getLimits(): PreTradeRiskLimits {
    return { ...this.limits };
  }

  public updateInventory(inventoryQty: number) {
    this.currentGrossInventory = inventoryQty;
  }

  public recordPnl(deltaPnl: number) {
    if (deltaPnl < 0) {
      this.currentDailyLossUsd += Math.abs(deltaPnl);
      if (this.currentDailyLossUsd >= this.limits.maxDailyLossUsd) {
        this.isCircuitBreakerTripped = true;
      }
    }
  }

  public resetCircuitBreaker() {
    this.isCircuitBreakerTripped = false;
    this.currentDailyLossUsd = 0;
  }

  public isTripped(): boolean {
    return this.isCircuitBreakerTripped;
  }

  public getRejectionsCount(): number {
    return this.totalRejections;
  }

  public validateOrder(
    order: {
      symbol: string;
      side: OrderSide;
      price: number;
      quantity: number;
    },
    currentMidPrice: number,
    existingOppositeOrders: { price: number; side: OrderSide }[] = []
  ): RiskCheckResult {
    // 1. Circuit Breaker check
    if (this.isCircuitBreakerTripped) {
      this.totalRejections++;
      return {
        passed: false,
        code: 'CIRCUIT_BREAKER_ACTIVE',
        reason: `Daily loss limit ($${this.limits.maxDailyLossUsd}) breached. Engine circuit breaker is TRIPPED.`,
      };
    }

    // 2. Leaky Bucket Rate Limiter
    const now = Date.now();
    this.orderTimestampBuffer = this.orderTimestampBuffer.filter((t) => now - t < 1000);
    if (this.orderTimestampBuffer.length >= this.limits.maxOrdersPerSecond) {
      this.totalRejections++;
      return {
        passed: false,
        code: 'RATE_LIMIT_EXCEEDED',
        reason: `Exceeded max orders per second threshold (${this.limits.maxOrdersPerSecond}/sec).`,
      };
    }

    // 3. Max Single Order Size Check
    if (order.quantity > this.limits.maxSingleOrderQty) {
      this.totalRejections++;
      return {
        passed: false,
        code: 'MAX_SIZE_EXCEEDED',
        reason: `Order qty (${order.quantity}) exceeds single order limit (${this.limits.maxSingleOrderQty}).`,
      };
    }

    // 4. Max Order Notional Check
    const notional = order.price * order.quantity;
    if (notional > this.limits.maxOrderNotionalUsd) {
      this.totalRejections++;
      return {
        passed: false,
        code: 'MAX_NOTIONAL_EXCEEDED',
        reason: `Order notional ($${notional.toFixed(2)}) exceeds max threshold ($${this.limits.maxOrderNotionalUsd.toFixed(2)}).`,
      };
    }

    // 5. Fat-Finger Price Band Deviation Check
    if (currentMidPrice > 0 && order.price > 0) {
      const devPct = (Math.abs(order.price - currentMidPrice) / currentMidPrice) * 100;
      if (devPct > this.limits.fatFingerPriceBandPct) {
        this.totalRejections++;
        return {
          passed: false,
          code: 'FAT_FINGER_DEVIATION',
          reason: `Order price ($${order.price}) deviates ${devPct.toFixed(2)}% from mid ($${currentMidPrice.toFixed(2)}), exceeding ${this.limits.fatFingerPriceBandPct}% limit band.`,
        };
      }
    }

    // 6. Max Inventory / Position Limit Check
    const projectedInventory =
      order.side === 'BUY'
        ? this.currentGrossInventory + order.quantity
        : this.currentGrossInventory - order.quantity;

    if (
      projectedInventory > this.limits.maxGrossInventoryQty ||
      projectedInventory < this.limits.maxShortInventoryQty
    ) {
      this.totalRejections++;
      return {
        passed: false,
        code: 'INVENTORY_LIMIT_BREACH',
        reason: `Projected inventory (${projectedInventory.toFixed(3)}) would breach bounds [${this.limits.maxShortInventoryQty}, ${this.limits.maxGrossInventoryQty}].`,
      };
    }

    // 7. Self-Trade Prevention (STP)
    if (this.limits.selfTradePrevention && existingOppositeOrders.length > 0) {
      if (order.side === 'BUY') {
        const crossingAsk = existingOppositeOrders.find(
          (o) => o.side === 'SELL' && o.price <= order.price
        );
        if (crossingAsk) {
          this.totalRejections++;
          return {
            passed: false,
            code: 'SELF_TRADE_PREVENTION',
            reason: `Crossing internal resting sell order at $${crossingAsk.price}. STP triggered.`,
          };
        }
      } else {
        const crossingBid = existingOppositeOrders.find(
          (o) => o.side === 'BUY' && o.price >= order.price
        );
        if (crossingBid) {
          this.totalRejections++;
          return {
            passed: false,
            code: 'SELF_TRADE_PREVENTION',
            reason: `Crossing internal resting buy order at $${crossingBid.price}. STP triggered.`,
          };
        }
      }
    }

    // Record order in timestamp rate buffer
    this.orderTimestampBuffer.push(now);

    return { passed: true };
  }
}
