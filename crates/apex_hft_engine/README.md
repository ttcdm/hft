# Apex HFT Execution Engine (Rust)

> **STATUS: not used.** Nothing in the app builds, links, spawns or calls this crate (no `npm` script, no `server/` import). The CI workflow does format, lint, test and build it on its own, and nothing uses the result. Latency figures quoted elsewhere for it were never measured by this project.

> **ARCHITECTURAL BOUNDARY & ROLE NOTICE (B21):**
> `crates/apex_hft_engine` is a standalone, ultra-low-latency reference benchmark and simulation harness for centralized exchange (CEX) L2 order book matching and Avellaneda-Stoikov market making.
> **Production Solana DEX execution** (Pump.fun V2 bonding curves, PumpSwap AMM pools, Jito bundle transport, on-chain position monitoring, and wallet signing) is driven entirely by the TypeScript engine located in `server/`. The Rust crate serves as an independent quantitative benchmark and does NOT broadcast Solana blockchain transactions.

Ultra-low latency autonomous execution and Avellaneda-Stoikov market-making engine written in modern, memory-safe, zero-allocation Rust.

## Architecture Highlights
- **Zero-Allocation L2 Order Book (`order_book.rs`)**: Cache-line aligned (`#[repr(align(64))]`) arrays eliminating heap allocations in the hot tick-to-trade path.
- **Lock-Free Ring Buffer (`ring_buffer.rs`)**: SPSC circular buffer with atomic acquire/release semantics.
- **Micro-Account ($10 USD) & Institutional Modes (`risk.rs`)**:
  - Enforces exchange minimum notional requirements (Binance 5 USDT rule) so small accounts don't get rejected.
  - Pre-trade risk checks (speed never measured by this project): leaky bucket rate limiter, fat-finger band, circuit breaker.
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

## Latency

No latency figure is given here. Earlier versions of this file quoted microsecond and nanosecond numbers; this project never measured them, so they were removed.
