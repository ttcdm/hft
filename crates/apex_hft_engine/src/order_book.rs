use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct BookLevel {
    pub price: f64,
    pub quantity: f64,
}

#[repr(align(64))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookL2 {
    pub symbol: String,
    pub bids: [BookLevel; 20],
    pub asks: [BookLevel; 20],
    pub best_bid: f64,
    pub best_ask: f64,
    pub mid_price: f64,
    pub micro_price: f64,
    pub spread_bps: f64,
    pub ofi: f64,
    pub last_update_ns: u64,
}

impl OrderBookL2 {
    pub fn new(symbol: &str) -> Self {
        Self {
            symbol: symbol.to_string(),
            bids: [BookLevel::default(); 20],
            asks: [BookLevel::default(); 20],
            best_bid: 0.0,
            best_ask: 0.0,
            mid_price: 0.0,
            micro_price: 0.0,
            spread_bps: 0.0,
            ofi: 0.0,
            last_update_ns: 0,
        }
    }

    #[inline(always)]
    pub fn update_levels(
        &mut self,
        bids_in: &[(f64, f64)],
        asks_in: &[(f64, f64)],
        timestamp_ns: u64,
    ) {
        let bid_count = bids_in.len().min(20);
        let ask_count = asks_in.len().min(20);

        for (i, &(price, quantity)) in bids_in.iter().take(bid_count).enumerate() {
            self.bids[i] = BookLevel { price, quantity };
        }
        for (i, &(price, quantity)) in asks_in.iter().take(ask_count).enumerate() {
            self.asks[i] = BookLevel { price, quantity };
        }

        if bid_count > 0 && ask_count > 0 {
            let b0_px = self.bids[0].price;
            let b0_qty = self.bids[0].quantity;
            let a0_px = self.asks[0].price;
            let a0_qty = self.asks[0].quantity;

            self.best_bid = b0_px;
            self.best_ask = a0_px;
            self.mid_price = (b0_px + a0_px) * 0.5;

            if self.mid_price > 0.0 {
                self.spread_bps = ((a0_px - b0_px) / self.mid_price) * 10_000.0;
            }

            let total_top_qty = b0_qty + a0_qty;
            if total_top_qty > 0.0 {
                // Micro-price (Volume-weighted mid price)
                self.micro_price = (b0_qty * a0_px + a0_qty * b0_px) / total_top_qty;
                // Order Flow Imbalance (OFI) proxy: normalized between -1.0 and +1.0
                self.ofi = (b0_qty - a0_qty) / total_top_qty;
            }
        }

        self.last_update_ns = timestamp_ns;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_order_book_levels_and_microprice() {
        let mut ob = OrderBookL2::new("SOL/USDC");
        let bids = [(140.0, 10.0), (139.5, 20.0)];
        let asks = [(140.5, 10.0), (141.0, 25.0)];

        ob.update_levels(&bids, &asks, 1_000_000);

        assert_eq!(ob.best_bid, 140.0);
        assert_eq!(ob.best_ask, 140.5);
        assert_eq!(ob.mid_price, 140.25);
        assert_eq!(ob.micro_price, 140.25); // Equal top weights -> exactly mid price
        assert_eq!(ob.ofi, 0.0); // 10.0 - 10.0 = 0
        assert!(ob.spread_bps > 0.0);
    }

    #[test]
    fn test_order_book_ofi_imbalance() {
        let mut ob = OrderBookL2::new("SOL/USDC");
        let bids = [(140.0, 30.0)]; // Heavy buy pressure
        let asks = [(140.5, 10.0)];

        ob.update_levels(&bids, &asks, 2_000_000);

        assert_eq!(ob.best_bid, 140.0);
        assert_eq!(ob.best_ask, 140.5);
        // micro_price = (30 * 140.5 + 10 * 140.0) / 40 = (4215 + 1400) / 40 = 5615 / 40 = 140.375
        assert_eq!(ob.micro_price, 140.375);
        // OFI = (30 - 10) / 40 = +0.5
        assert_eq!(ob.ofi, 0.5);
    }
}
