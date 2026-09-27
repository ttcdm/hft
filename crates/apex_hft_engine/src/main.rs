use apex_hft_engine::{
    AvellanedaStoikovModel, EngineWAL, ModelConfig, OrderBookL2, PreTradeRiskEngine, RiskLimits,
};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Instant;
use tokio_tungstenite::connect_async;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("============================================================");
    println!(" [APEX QUANT HFT] Standalone High-Performance Engine in RUST");
    println!(" Built for Sub-Microsecond Tick-to-Trade Execution");
    println!("============================================================");

    let is_micro_mode = std::env::var("MICRO_10_USD")
        .map(|v| v == "1" || v.to_lowercase() == "true")
        .unwrap_or(true); // Default to micro mode for safety

    let symbol = std::env::var("SYMBOL").unwrap_or_else(|_| "btcusdt".to_string());

    println!(">>> Configuration:");
    println!("    Symbol:             {}", symbol.to_uppercase());
    println!(
        "    Capital Allocation: {}",
        if is_micro_mode {
            "$10.00 Micro Account (Binance Min-Notional Compatible)"
        } else {
            "Institutional $500k Tier"
        }
    );

    // Initialize Rust Components
    let model_config = if is_micro_mode {
        ModelConfig::micro_10_usd()
    } else {
        ModelConfig::default()
    };

    let risk_limits = if is_micro_mode {
        RiskLimits::micro_10_usd()
    } else {
        RiskLimits::default()
    };

    let model = AvellanedaStoikovModel::new(model_config);
    let mut risk = PreTradeRiskEngine::new(risk_limits);
    let mut order_book = OrderBookL2::new(&symbol);
    let wal = EngineWAL::new(Some("apex_engine_rust.wal"));

    wal.record(
        "ENGINE_START_RUST",
        &format!("{{\"micro_mode\": {}}}", is_micro_mode),
    );

    // Connect to Binance Depth Stream
    let ws_url = format!(
        "wss://stream.binance.com:9443/ws/{}@depth20@100ms",
        symbol.to_lowercase()
    );

    println!(">>> Connecting to Exchange Stream: {}", ws_url);
    let (ws_stream, _) = connect_async(ws_url.as_str())
        .await
        .expect("Failed to connect to Binance WebSocket");
    println!(">>> Connected to Market Data feed. Listening for Level 2 orderbook ticks...");

    let (_write, mut read) = ws_stream.split();
    let mut tick_counter = 0u64;
    let inventory_q = 0.0f64;

    while let Some(msg) = read.next().await {
        if let Ok(tokio_tungstenite::tungstenite::Message::Text(text)) = msg {
            let start_bench = Instant::now();

            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let (Some(bids), Some(asks)) = (v.get("bids"), v.get("asks")) {
                    let mut parsed_bids = Vec::with_capacity(20);
                    let mut parsed_asks = Vec::with_capacity(20);

                    if let Some(b_arr) = bids.as_array() {
                        for item in b_arr.iter().take(20) {
                            if let (Some(px_s), Some(qty_s)) = (item[0].as_str(), item[1].as_str())
                            {
                                if let (Ok(px), Ok(qty)) =
                                    (px_s.parse::<f64>(), qty_s.parse::<f64>())
                                {
                                    parsed_bids.push((px, qty));
                                }
                            }
                        }
                    }

                    if let Some(a_arr) = asks.as_array() {
                        for item in a_arr.iter().take(20) {
                            if let (Some(px_s), Some(qty_s)) = (item[0].as_str(), item[1].as_str())
                            {
                                if let (Ok(px), Ok(qty)) =
                                    (px_s.parse::<f64>(), qty_s.parse::<f64>())
                                {
                                    parsed_asks.push((px, qty));
                                }
                            }
                        }
                    }

                    // 1. Update Zero-Allocation Order Book
                    order_book.update_levels(&parsed_bids, &parsed_asks, tick_counter);

                    // 2. Avellaneda-Stoikov Solver
                    if let Some(quotes) =
                        model.compute_quotes(order_book.mid_price, inventory_q, order_book.ofi)
                    {
                        // 3. Pre-Trade Risk Invariant Checks (Sub-microsecond)
                        let buy_check = risk.validate_order(
                            true,
                            quotes.bid_price,
                            quotes.bid_size,
                            order_book.mid_price,
                        );

                        let sell_check = risk.validate_order(
                            false,
                            quotes.ask_price,
                            quotes.ask_size,
                            order_book.mid_price,
                        );

                        let elapsed_micros = start_bench.elapsed().as_nanos() as f64 / 1_000.0;
                        tick_counter += 1;

                        if tick_counter.is_multiple_of(10) {
                            println!(
                                "[TICK #{:06}] Latency: {:.2}µs | Mid: ${:.2} | Res: ${:.2} | Bid: ${:.2} (Risk: {}) | Ask: ${:.2} (Risk: {}) | OFI: {:+.3}",
                                tick_counter,
                                elapsed_micros,
                                order_book.mid_price,
                                quotes.reservation_price,
                                quotes.bid_price,
                                buy_check.code,
                                quotes.ask_price,
                                sell_check.code,
                                order_book.ofi
                            );

                            wal.record(
                                "QUOTES_EVALUATED_RUST",
                                &format!(
                                    "{{\"mid\": {:.2}, \"bid\": {:.2}, \"ask\": {:.2}, \"latency_us\": {:.2}}}",
                                    order_book.mid_price, quotes.bid_price, quotes.ask_price, elapsed_micros
                                ),
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(())
}
