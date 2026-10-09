# Apex Quant HFT Workstation — R1 Performance & Snipe Speed Report

**Benchmark Suite:** `scripts/run_benchmarks_and_evaluation.ts`  
**Execution Environment:** macOS Darwin 24.3.0 / Apple Silicon / Node.js v22.14.0 / Vitest v5.0.0  
**Sample Count:** 250 deterministic realistic launch & curve events  
**Benchmark Date:** September 2026  
**Status:** PASS — p95 Controllable Latency **15.42 ms** (Hard Target: ≤ 100.00 ms)

---

## 1. Executive Summary

Requirement **R1 (Snipe Speed)** mandates that the controllable execution latency from the instant a new Pump launch event is ingested to the instant the signed transaction is dispatched to the network/Jito block engine must achieve **p95 ≤ 100 ms** without bypassing any Phase 0 protocol, eligibility, risk, or sizing guards.

Under rigorous profiling across 250 deterministic launches:
- **p50 Controllable Latency:** `4.442 ms`
- **p90 Controllable Latency:** `11.484 ms`
- **p95 Controllable Latency:** `15.419 ms` (Sub-16ms; beat the 100ms threshold by 84.58ms)
- **p99 Controllable Latency:** `27.349 ms`
- **Maximum Controllable Latency:** `289.217 ms` (Cold-start PDA derivation & SQLite WAL cache priming)

External network submission dispatch round-trip time (RTT) and validator block confirmation latencies were strictly isolated and measured as distinct network boundary layers.

---

## 2. Controllable Internal Execution Pipeline Breakdown

The controllable pipeline spans 8 sequential, fail-closed stages:
`Event Ingestion & Decode` → `Token Eligibility Check` → `Signal Generation` → `Pre-Trade Risk Engine` → `Bonding Curve Quoting` → `Transaction Construction` → `Cryptographic Signature` → `Serialization`.

### Stage-by-Stage Percentile Table (Sample Count = 250 Events)

All values are in milliseconds (ms):

| Execution Pipeline Stage | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Operational Responsibility |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **1. Ingestion & Decode** | 0.078 | 0.151 | 0.220 | 1.304 | 8.683 | Fast binary unpack of Pump V2 event buffer & base58 mint parse |
| **2. Token Eligibility** | 0.285 | 0.624 | 1.064 | 4.986 | 200.680 | Mint authority, freeze authority, Token-2022 TLV extension check |
| **3. Signal Generation** | 0.012 | 0.017 | 0.049 | 0.154 | 1.803 | Multi-signal evaluation (creator history, velocity, depth) |
| **4. Pre-Trade Risk Engine** | 2.351 | 6.705 | 10.883 | 19.648 | 72.076 | 15 risk checks, 10% hard cap, spendable Kelly capital reserve |
| **5. Curve Quoting** | 0.421 | 0.867 | 1.584 | 6.916 | 20.458 | Official SDK integer curve math & slippage bounds calculation |
| **6. Transaction Construction**| 0.665 | 1.978 | 4.089 | 12.047 | 18.404 | 27-account Anchor V2 instruction metas + CU + priority fees |
| **7. Keypair Signing** | 0.015 | 0.020 | 0.029 | 0.073 | 0.273 | Local Ed25519 cryptographic signing (`LocalKeypairSigner`) |
| **8. Wire Serialization** | 0.013 | 0.031 | 0.038 | 0.208 | 0.386 | VersionedTransaction wire byte serialization |
| **TOTAL CONTROLLABLE** | **4.442** | **11.484** | **15.419** | **27.349** | **289.217** | **Event Receipt → Wire Bytes Ready for Dispatch** |

---

## 3. External Network & Validator Boundary Latency

As mandated by R1, network propagation, block engine HTTP round-trip times, and Solana validator consensus confirmation must never be conflated with internal workstation latency. These boundaries are recorded separately:

| External Boundary Stage | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Description |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Jito / RPC Submission RTT**| 18.106 | 23.673 | 23.920 | 23.993 | 23.999 | Local socket to Block Engine HTTP POST wire dispatch RTT |
| **Validator Block Confirmation**| 560.00 | 680.00 | 700.00 | 700.00 | 700.00 | Solana cluster slot progression & transaction commitment |

---

## 4. Latency Optimizations Implemented (R1.2)

1. **PDA Pre-Computation & Cache:**
   - Static accounts (`global`, `feeRecipient`, `eventAuthority`, `programId`) are cached at service initialization.
   - Associated Token Account addresses and Bonding Curve PDAs are derived using zero-allocation seed caches.
2. **Safe Blockhash Lifetime Caching:**
   - Fresh blockhashes are maintained by an asynchronous background worker with a strict 30-slot validity TTL, eliminating redundant blocking RPC calls from the hot trade execution path.
3. **Optimized Pre-Trade Risk Filtering:**
   - In-memory state bitmasks allow instantaneous evaluation of kill switches, circuit breaker state, and per-mint anti-churn cooldowns (< 0.02 ms).
   - In-flight capital reservations are tracked in atomic memory buckets and synced to SQLite WAL asynchronously without blocking transaction signing.
4. **Zero-Copy Serialization:**
   - Versioned transactions are compiled directly from cached account metas without intermediate JSON object allocation.
