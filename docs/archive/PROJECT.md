# Project: APEX Quant HFT Workstation Upgrade

## Master Architecture
The APEX Quant HFT Workstation is a low-latency, safety-gated Solana memecoin trading engine operating on Pump.fun V2 bonding curves and migrated PumpSwap AMM markets.

### Canonical Execution Flow
Every trade intent in the system MUST flow strictly through the single canonical execution path:
```
Candidate (On-Chain, Social, Copy)
  │
  ▼
Authoritative Token Eligibility (Fail-Closed tri-state, exact mint match)
  │
  ▼
Multi-Factor Signal Scoring (ConfluenceEngine)
  │
  ▼
Capital Sizing (Spendable Bankroll, Fractional Kelly with shrinkage, MICRO_10 10% hard cap)
  │
  ▼
Hardened Risk Engine (Pre-Trade Limits, Drawdown States, Fee Economics)
  │
  ▼
ExecutionCoordinator (PAPER or LIVE with strict executionMode propagation)
  │
  ├── Dynamic Jito Tip Resolution (Live floor, bounded escalation, notional cap)
  ├── Fast-Path Transaction Assembly & Local Ed25519 Signing
  └── Jito Block Engine Transport (probe-verified health, idempotent retry, safe RPC fallback)
  │
  ▼
Reconciliation & Position Management (On-chain balance deltas, SQLite WAL persistence)
  │
  ▼
Dynamic Exit Engine (Monotonic Trailing Stop, Fee-Aware Partial Take-Profit Ladder, Re-entry Guards)
```

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | R0.1 Execution Mode Propagation | Non-optional `executionMode: 'PAPER' \| 'LIVE'` across all quoting, execution, marking, and instruction builders. Zero optional boolean fallbacks in LIVE. | M1 | ORIGINAL_REQUEST §R0.1 |
| 2 | R0.2 Pump.fun V2 Correctness | Pinned `@pump-fun/pump-sdk@1.37.0`, 27-account buy / 26-account sell instructions, distinction of normal vs Mayhem vs buyback fee recipients, integer quote math cross-checks. | M1 | ORIGINAL_REQUEST §R0.2 |
| 3 | R0.3 PumpSwap Correctness | Pinned `@pump-fun/pump-swap-sdk@1.20.0`, effective quote reserves (`actual + virtual`), dynamic fee schedule, full buy/sell quoting and instruction building, SOL/WSOL restricted for LIVE. | M1 | ORIGINAL_REQUEST §R0.3 |
| 4 | R0.4 Migration Safety | Position transition `PUMP_BONDING_CURVE -> MIGRATION DETECTED -> canonical pool resolved -> PUMPSWAP`. Fail-closed UNKNOWN route. Persist `venue`, `poolAddress`, `migrationTimestamp` in SQLite. | M1 | ORIGINAL_REQUEST §R0.4 |
| 5 | R0.5 Jito Correctness | Distinct tx signature vs bundle ID, bundle lifecycle tracking, startup and periodic `probe()`, Jito health gating (`NOT_CONFIGURED` denies LIVE arming). | M1 | ORIGINAL_REQUEST §R0.5 |
| 6 | R0.6 Safe Jito Retry & RPC Fallback | Bounded idempotent retries with pre-checks, single `clientOrderId` deduplication, zero double fills on RPC fallback. | M1 | ORIGINAL_REQUEST §R0.6 |
| 7 | R0.7 Authoritative Token Eligibility | `ExecutionCoordinator` LIVE enforcement, exact mint match assertion, tri-state `PASS`/`FAIL`/`UNKNOWN` with critical `UNKNOWN -> REJECT`. | M1 | ORIGINAL_REQUEST §R0.7 |
| 8 | R0.8 Token-2022 Policy | Fail-closed extension inspection; unsupported/unmodeled extensions reject with `UNSUPPORTED_TOKEN_EXTENSION`. | M1 | ORIGINAL_REQUEST §R0.8 |
| 9 | R0.9 Mandatory Signal Provenance | `SignalProvenance` enum with `COPY_TRADE` & `MANUAL_OPERATOR`. Remove silent default to `REAL_ONCHAIN` in `server.ts`. | M1 | ORIGINAL_REQUEST §R0.9 |
| 10 | R0.10 Synthetic Data Isolation | Explicit `DEMO_MODE=true` required; simulation engines and mock pools default OFF. Isolated from LIVE metrics. | M1 | ORIGINAL_REQUEST §R0.10 |
| 11 | R0.11 Authenticated WebSocket Telemetry | `CONNECT -> AUTH_REQUIRED -> authenticate -> AUTHENTICATED -> snapshots`. Origin allowlist. Remove bearer credentials from URL query strings. | M1 | ORIGINAL_REQUEST §R0.11 |
| 12 | R0.12 Real Health Model | Explicit `LiveReadiness` object. Independent tracking of RPC, Pump feed, mark feed, Jito, DB, and signer health. | M1 | ORIGINAL_REQUEST §R0.12 |
| 13 | R0.13 Crash Recovery | SQLite `PRAGMA journal_mode = WAL`. Recovery of interrupted BUY, full SELL, partial SELL (remaining token/basis/PnL). No `RECONCILED` without verified accounting. | M1 | ORIGINAL_REQUEST §R0.13 |
| 14 | R0.14 Real-Money Prohibition | No funded mainnet transactions during development or CI without explicit user authorization. | M1 | ORIGINAL_REQUEST §R0.14 |
| 15 | R1 Snipe Speed & Latency Profiling | Instrument timestamps for event-receipt to submission dispatch. Measure and report p50/p90/p95/p99. Cache PDAs, accounts, blockhashes. Target p95 <= 100ms controllable benchmark. | M2 | ORIGINAL_REQUEST §R1 |
| 16 | R4 Jito / MEV Dynamic Tip & Fallback | Dynamic tip policy with live floor, bounded escalation on retry, leader-slot awareness, duplicate-safe RPC fallback. | M2 | ORIGINAL_REQUEST §R4 |
| 17 | R5 Copy Trading | Tracked Solana wallets, transaction decoding, candidate extraction with `COPY_TRADE` provenance, full risk/sizing integration, deduplication. | M2 | ORIGINAL_REQUEST §R5 |
| 18 | R6 Social Signals | Ingestion feed, contract address regex extraction, candidate extraction with `REAL_SOCIAL` provenance, ticker-only gate, rate limiting. | M2 | ORIGINAL_REQUEST §R6 |
| 19 | R2 Signal Quality & Replay | Confluence engine activation, >= 3 independent on-chain signals, >= 200 launch out-of-sample evaluation, net expectancy reporting. | M3 | ORIGINAL_REQUEST §R2 |
| 20 | R3 Dynamic Exit Optimization | Monotonic trailing stop, fee-aware partial take-profit ladder, max hold time, reversal exits, re-entry guards, SQLite state persistence. | M3 | ORIGINAL_REQUEST §R3 |
| 21 | R7 MICRO_10 Capital Efficiency | Spendable bankroll calculation (~0.07 SOL), fractional Kelly sizing with sample shrinkage ($N < 30$), hard <= 10% (0.007 SOL) cap in RiskEngine, fee economics, drawdown states. | M3 | ORIGINAL_REQUEST §R7 |
| 22 | Final E2E Test Pass (Tiers 1-4) | 100% pass across Feature Coverage, Boundary, Combination, and Real-World Workload test suites. | M4 | ORIGINAL_REQUEST §Dual Track |
| 23 | Adversarial Coverage Hardening | Tier 5 white-box challenger coverage audit and defect remediation. | M4 | ORIGINAL_REQUEST §Dual Track |
| 24 | Build, Typecheck, Lint & Rust Gates | Pass `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `cargo fmt`, `cargo clippy`, `cargo test`, `cargo build --release`. | M4 | ORIGINAL_REQUEST §BUILD GATE |
| 25 | Deliverables & Release Package | Produce `FINAL_AUDIT_REPORT.md`, `AUDIT_EVIDENCE.md`, `KNOWN_RISKS.md`, `PERFORMANCE_REPORT.md`, `STRATEGY_EVALUATION.md`, and clean release packaging. | M4 | ORIGINAL_REQUEST §DELIVERABLES |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Phase 0 Live Correctness & Safety Gate | R0.1 - R0.14 (Teams A & B): Protocol execution correctness, Pump V2, PumpSwap, Jito, migration safety, token eligibility, Token-2022, provenance, isolation, WS auth, health model, WAL crash recovery. Forensic audit must pass clean. | none | PLANNED |
| 2 | Alpha & Execution Infrastructure | R1 Snipe Speed & Latency Profiling (Team D), R4 Jito / MEV Optimization (Teams A/D), R5 Copy Trading (Team E), R6 Social Signals (Team E). | M1 | PLANNED |
| 3 | Strategy, Exits & Capital Economics | R2 Signal Quality & Out-of-sample Replay (Team C), R3 Dynamic Exit Optimization (Team C), R7 MICRO_10 Capital Efficiency & Fractional Kelly (Team F). | M1, M2 | PLANNED |
| 4 | Final Verification, Hardening & Release | 100% E2E test pass (Tiers 1-4), Tier 5 adversarial coverage hardening, clean build gates (Node + Rust), 5 final report deliverables, release packaging. | M1, M2, M3, E2E Track | PLANNED |

---

## Interface Contracts

### 1. `ExecutionCoordinator` ↔ `Protocol Services (PumpCurve, PumpSwap, Jito)`
- All quoting and execution methods MUST accept non-optional `executionMode: 'PAPER' | 'LIVE'`.
- In `LIVE`, errors in SDK decoding, fee recipient resolution, quote math, or pool discovery MUST throw immediately (fail-closed); silent fallbacks are strictly prohibited.
- `PumpSwapVenueService`:
  ```typescript
  getPoolState(connection: Connection, mint: PublicKey, executionMode: ExecutionMode): Promise<PumpSwapExecutionState>
  buildPumpSwapSellInstructions(connection: Connection, userPubkey: PublicKey, mint: PublicKey, tokenAmountRaw: bigint, slippageBps: number, executionMode: ExecutionMode): Promise<TransactionInstruction[]>
  buildPumpSwapBuyInstructions(connection: Connection, userPubkey: PublicKey, mint: PublicKey, solAmountLamports: bigint, slippageBps: number, executionMode: ExecutionMode): Promise<TransactionInstruction[]>
  ```

### 2. `ExecutionCoordinator` ↔ `EligibilityFilter`
- `req.eligibilityReport` MUST match `req.mint`.
- Authority statuses MUST use tri-state: `'PASS' | 'FAIL' | 'UNKNOWN'` (or `'REVOKED' | 'ACTIVE' | 'UNKNOWN'`).
- In `LIVE` mode, any critical field returning `UNKNOWN` results in immediate rejection.

### 3. `ExecutionCoordinator` ↔ `CapitalSizer & RiskEngine`
- Sizing equation:
  ```
  spendableBankroll = walletBalanceSol - requiredReserveSol (0.015) - inFlightReservedSol
  orderSizeSol = min(spendableBankroll * 0.10, fractionalKellySizeSol)
  ```
- RiskEngine MUST enforce `orderSizeSol <= spendableBankroll * 0.10` (hard ceiling ~0.007 SOL for 0.07 SOL bankroll).

### 4. `ExecutionCoordinator` ↔ `Database & Persistence`
- SQLite connection MUST execute `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`.
- Positions table schema MUST include `venue`, `pool_address`, `migration_timestamp`, `high_water_mark_sol`, `trailing_stop_sol`, `exit_stage`.
- Transactions can only be marked `'RECONCILED'` once post-trade balance deltas and position records are successfully confirmed and written.

---

## Code Layout

- `server/execution/coordinator.ts` — Central ExecutionCoordinator and trade execution engine
- `server/execution/reconciliation.ts` — On-chain fill reconciliation and crash recovery
- `server/solana/pumpCurve.ts` — Pump.fun V2 bonding curve quoting, fee calculation, and account resolution
- `server/solana/pumpSwapService.ts` — PumpSwap AMM pool discovery, pricing, quoting, and instruction builders
- `server/solana/transactionBuilder.ts` — Versioned transaction builders (Compute Budget, ATA, Pump/PumpSwap, Jito Tip)
- `server/solana/transports.ts` — Jito Block Engine transport, bundle lifecycle, and fallback RPC transport
- `server/solana/executionConfig.ts` — Authoritative execution config and dynamic tip policies
- `server/signals/confluenceEngine.ts` — Multi-factor on-chain signal generation and scoring
- `server/signals/eligibilityFilter.ts` — Authoritative token safety and eligibility screening
- `server/risk/riskEngine.ts` — Pre-trade risk enforcement, capital caps, and drawdown state machine
- `server/capital/capitalSizer.ts` — Fractional Kelly sizing with sample shrinkage and spendable bankroll calculation
- `server/exits/exitEngine.ts` — Monotonic trailing stops, fee-aware take-profit ladders, and re-entry safeguards
- `server/copy/copyTrader.ts` — Public wallet transaction ingestion, decoding, and candidate generation
- `server/social/socialScanner.ts` — Social message ingestion and contract address regex extraction
- `server/db/database.ts` — SQLite database connection (WAL mode) and schema migrations
- `server/middleware/auth.ts` — WebSocket authentication handshake and origin allowlists
- `tests/` — Comprehensive Vitest and E2E test suites
