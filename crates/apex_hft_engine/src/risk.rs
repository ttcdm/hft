use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskLimits {
    pub min_order_notional_usd: f64, // e.g. 5.0 USD (Binance minimum)
    pub max_order_notional_usd: f64, // e.g. 10.0 USD for Micro mode, or 50,000 USD
    pub max_single_order_qty: f64,
    pub max_gross_inventory_qty: f64,
    pub max_short_inventory_qty: f64,
    pub max_orders_per_second: u32,
    pub fat_finger_band_pct: f64,
    pub max_daily_loss_usd: f64,
    pub is_micro_capital_mode: bool,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            min_order_notional_usd: 5.0,
            max_order_notional_usd: 50_000.0,
            max_single_order_qty: 5.0,
            max_gross_inventory_qty: 10.0,
            max_short_inventory_qty: -10.0,
            max_orders_per_second: 60,
            fat_finger_band_pct: 2.5,
            max_daily_loss_usd: 5000.0,
            is_micro_capital_mode: false,
        }
    }
}

impl RiskLimits {
    pub fn micro_10_usd() -> Self {
        Self {
            min_order_notional_usd: 5.0,  // Must meet Binance 5 USDT min order
            max_order_notional_usd: 10.0, // Cap at total $10 equity
            max_single_order_qty: 0.0002, // ~0.0001 BTC (~$6.80)
            max_gross_inventory_qty: 0.0002,
            max_short_inventory_qty: -0.0002,
            max_orders_per_second: 5,
            fat_finger_band_pct: 1.5,
            max_daily_loss_usd: 2.0, // 20% max daily loss on $10
            is_micro_capital_mode: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskCheckResult {
    pub passed: bool,
    pub code: &'static str,
    pub reason: String,
}

pub struct PreTradeRiskEngine {
    limits: RiskLimits,
    current_inventory: f64,
    current_daily_loss: f64,
    is_circuit_breaker_tripped: bool,
    order_timestamps: Vec<u64>,
    total_rejections: u64,
}

impl PreTradeRiskEngine {
    pub fn new(limits: RiskLimits) -> Self {
        Self {
            limits,
            current_inventory: 0.0,
            current_daily_loss: 0.0,
            is_circuit_breaker_tripped: false,
            order_timestamps: Vec::with_capacity(128),
            total_rejections: 0,
        }
    }

    pub fn update_limits(&mut self, new_limits: RiskLimits) {
        self.limits = new_limits;
    }

    pub fn get_limits(&self) -> &RiskLimits {
        &self.limits
    }

    pub fn update_inventory(&mut self, qty: f64) {
        self.current_inventory = qty;
    }

    pub fn record_pnl(&mut self, delta_pnl: f64) {
        if delta_pnl < 0.0 {
            self.current_daily_loss += delta_pnl.abs();
            if self.current_daily_loss >= self.limits.max_daily_loss_usd {
                self.is_circuit_breaker_tripped = true;
            }
        }
    }

    pub fn reset_circuit_breaker(&mut self) {
        self.is_circuit_breaker_tripped = false;
        self.current_daily_loss = 0.0;
    }

    pub fn validate_order(
        &mut self,
        is_buy: bool,
        price: f64,
        quantity: f64,
        mid_price: f64,
    ) -> RiskCheckResult {
        // 1. Circuit breaker
        if self.is_circuit_breaker_tripped {
            self.total_rejections += 1;
            return RiskCheckResult {
                passed: false,
                code: "CIRCUIT_BREAKER_ACTIVE",
                reason: format!(
                    "Daily loss limit of ${:.2} breached. Trading is HALTED.",
                    self.limits.max_daily_loss_usd
                ),
            };
        }

        // 2. Leaky bucket rate limit
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        self.order_timestamps
            .retain(|&t| now_ms.saturating_sub(t) < 1000);
        if self.order_timestamps.len() >= self.limits.max_orders_per_second as usize {
            self.total_rejections += 1;
            return RiskCheckResult {
                passed: false,
                code: "RATE_LIMIT_EXCEEDED",
                reason: format!(
                    "Exceeded {} orders/sec threshold.",
                    self.limits.max_orders_per_second
                ),
            };
        }

        // 3. Minimum notional check (Critical for $10 account to avoid exchange rejection)
        let notional = price * quantity;
        if notional < self.limits.min_order_notional_usd {
            self.total_rejections += 1;
            return RiskCheckResult {
                passed: false,
                code: "MIN_NOTIONAL_VIOLATION",
                reason: format!(
                    "Order notional ${:.2} is below exchange minimum ${:.2}.",
                    notional, self.limits.min_order_notional_usd
                ),
            };
        }

        // 4. Maximum notional check
        if notional > self.limits.max_order_notional_usd {
            self.total_rejections += 1;
            return RiskCheckResult {
                passed: false,
                code: "MAX_NOTIONAL_EXCEEDED",
                reason: format!(
                    "Order notional ${:.2} exceeds limit ${:.2}.",
                    notional, self.limits.max_order_notional_usd
                ),
            };
        }

        // 5. Fat-finger price band deviation check
        if mid_price > 0.0 {
            let dev_pct = ((price - mid_price).abs() / mid_price) * 100.0;
            if dev_pct > self.limits.fat_finger_band_pct {
                self.total_rejections += 1;
                return RiskCheckResult {
                    passed: false,
                    code: "FAT_FINGER_DEVIATION",
                    reason: format!(
                        "Order price ${:.2} deviates {:.2}% from mid ${:.2} (limit: {:.1}%).",
                        price, dev_pct, mid_price, self.limits.fat_finger_band_pct
                    ),
                };
            }
        }

        // 6. Gross inventory bounds
        let projected = if is_buy {
            self.current_inventory + quantity
        } else {
            self.current_inventory - quantity
        };

        if projected > self.limits.max_gross_inventory_qty
            || projected < self.limits.max_short_inventory_qty
        {
            self.total_rejections += 1;
            return RiskCheckResult {
                passed: false,
                code: "INVENTORY_LIMIT_BREACH",
                reason: format!(
                    "Projected inventory {:.4} would breach [{:.4}, {:.4}].",
                    projected,
                    self.limits.max_short_inventory_qty,
                    self.limits.max_gross_inventory_qty
                ),
            };
        }

        self.order_timestamps.push(now_ms);
        RiskCheckResult {
            passed: true,
            code: "OK",
            reason: "Passed all pre-trade risk checks.".to_string(),
        }
    }
}
