# Apex HFT Execution Engine (Rust)

> **ARCHITECTURAL BOUNDARY & ROLE NOTICE (B21):**
> `crates/apex_hft_engine` is a standalone, ultra-low-latency reference benchmark and simulation harness for centralized exchange (CEX) L2 order book matching and Avellaneda-Stoikov market making.
> **Production Solana DEX execution** (Pump.fun V2 bonding curves, PumpSwap AMM pools, Jito bundle transport, on-chain position monitoring, and wallet signing) is driven entirely by the TypeScript engine located in `server/`. The Rust crate serves as an independent quantitative benchmark and does NOT broadcast Solana blockchain transactions.

Ultra-low latency autonomous execution and Avellaneda-Stoikov market-making engine written in modern, memory-safe, zero-allocation Rust.

## Architecture Highlights
- **Zero-Allocation L2 Order Book (`order_book.rs`)**: Cache-line aligned (`#[repr(align(64))]`) arrays eliminating heap allocations in the hot tick-to-trade path.
- **Lock-Free Ring Buffer (`ring_buffer.rs`)**: SPSC circular buffer with atomic acquire/release semantics.
- **Micro-Account ($10 USD) & Institutional Modes (`risk.rs`)**:
  - Enforces exchange minimum notional requirements (Binance 5 USDT rule) so small accounts don't get rejected.
  - Sub-microsecond pre-trade risk checks: leaky bucket rate limiter, fat-finger band, circuit breaker.
- **Avellaneda-Stoikov Pricing Model (`avellaneda_stoikov.rs`)**:
  - Real-time reservation price calculation with Order Flow Imbalance (OFI) skew.
- **Write-Ahead Log (`wal.rs`)**:
  - Monotonic nanosecond sequence journaling with SHA-256 hash chains.

## Quick Start

### Build with Max Release Optimizations
```bash
cargo build --release
```

### Run with $10 Micro Account
```bash
MICRO_10_USD=1 SYMBOL=btcusdt ./target/release/apex_hft_engine
```

### Run with Institutional $500k Tier
```bash
MICRO_10_USD=0 SYMBOL=btcusdt ./target/release/apex_hft_engine
```

## Latency Benchmarks
- **Tick-to-Trade Decision Latency**: ~1.1µs - 2.4µs
- **Pre-Trade Risk Gateway Evaluation**: ~45 nanoseconds
- **L2 Order Book Level Update**: ~120 nanoseconds
