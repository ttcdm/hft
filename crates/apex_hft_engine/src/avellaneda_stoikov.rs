use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub symbol: String,
    pub gamma: f64,        // Risk aversion coefficient (e.g. 0.05 .. 0.5)
    pub sigma: f64,        // Volatility parameter
    pub kappa: f64,        // Order book liquidity density
    pub time_horizon: f64, // Normalization constant T
    pub target_spread_bps: f64,
    pub base_quote_size: f64,
    pub tick_size: f64,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            symbol: "BTCUSDT".to_string(),
            gamma: 0.1,
            sigma: 0.02,
            kappa: 1.5,
            time_horizon: 1.0,
            target_spread_bps: 2.0,
            base_quote_size: 0.05,
            tick_size: 0.1,
        }
    }
}

impl ModelConfig {
    pub fn micro_10_usd() -> Self {
        Self {
            symbol: "BTCUSDT".to_string(),
            gamma: 0.35, // Higher risk aversion for micro account
            sigma: 0.02,
            kappa: 1.8,
            time_horizon: 1.0,
            target_spread_bps: 4.0, // Wider spread to cover retail taker/maker fees
            base_quote_size: 0.0001, // ~6.80 USD on BTC (meets Binance 5 USDT min)
            tick_size: 0.1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotePair {
    pub bid_price: f64,
    pub bid_size: f64,
    pub ask_price: f64,
    pub ask_size: f64,
    pub reservation_price: f64,
    pub half_spread_bps: f64,
}

pub struct AvellanedaStoikovModel {
    pub config: ModelConfig,
}

impl AvellanedaStoikovModel {
    pub fn new(config: ModelConfig) -> Self {
        Self { config }
    }

    #[inline(always)]
    pub fn compute_quotes(&self, mid_price: f64, inventory_q: f64, ofi: f64) -> Option<QuotePair> {
        if mid_price <= 0.0 {
            return None;
        }

        let gamma = self.config.gamma;
        let sigma = self.config.sigma;
        let t = self.config.time_horizon;
        let kappa = self.config.kappa.max(0.01);

        // 1. Reservation Price: r(s, q, t) = s - q * gamma * sigma^2 * T
        let inv_penalty = inventory_q * gamma * sigma.powi(2) * t;
        // Skew reservation price using Order Flow Imbalance
        let ofi_bias = ofi * (self.config.target_spread_bps / 10_000.0) * mid_price * 0.25;
        let reservation_price = mid_price - inv_penalty + ofi_bias;

        // 2. Optimal Spread: delta_a + delta_b = gamma * sigma^2 * T + (2/gamma) * ln(1 + gamma/kappa)
        let as_half_spread = (gamma * sigma.powi(2) * t
            + (2.0 / gamma) * (1.0 + gamma / kappa).ln())
            * mid_price
            * 0.0005;

        let min_half_spread = (self.config.target_spread_bps / 20_000.0) * mid_price;
        let effective_half_spread = as_half_spread.max(min_half_spread);

        let tick = self.config.tick_size;
        let raw_bid = reservation_price - effective_half_spread;
        let raw_ask = reservation_price + effective_half_spread;

        let bid_price = (raw_bid / tick).floor() * tick;
        let ask_price = (raw_ask / tick).ceil() * tick;

        let half_spread_bps = ((effective_half_spread * 2.0) / mid_price) * 10_000.0;

        Some(QuotePair {
            bid_price,
            bid_size: self.config.base_quote_size,
            ask_price,
            ask_size: self.config.base_quote_size,
            reservation_price,
            half_spread_bps,
        })
    }
}
