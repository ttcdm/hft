# APEX Quant HFT Workstation — E2E Test Infrastructure

## Overview

The APEX Quant HFT Workstation E2E test suite provides opaque-box, requirement-driven end-to-end verification across the entire quantitative trading system. It operates completely in-process without requiring live Solana mainnet connectivity, funded private keys, external RPC servers, or external network dependencies.

All tests adhere strictly to the architectural specifications and safety invariants defined in `PROJECT.md` and `ORIGINAL_REQUEST.md`.

---

## Test Suite Architecture & Tiers

The test suite is structured into four progressive tiers located in `tests/e2e/`:

| Tier | Directory | Test Files | Tests | Description |
|------|-----------|------------|-------|-------------|
| **Tier 1** | `tests/e2e/tier1/` | 5 | 125 | **Feature Coverage**: >= 5 comprehensive test cases per feature across all Features 1–25. |
| **Tier 2** | `tests/e2e/tier2/` | 5 | 125 | **Boundary & Corner Cases**: >= 5 boundary/corner test cases per feature (zero/negative values, extreme caps, fail-closed assertions, injection defenses). |
| **Tier 3** | `tests/e2e/tier3/` | 1 | 22 | **Cross-Feature Combinations**: Pairwise interactions between features (e.g. Token-2022 + PumpSwap, Jito retry + RPC fallback, WS auth + snapshot gating). |
| **Tier 4** | `tests/e2e/tier4/` | 1 | 10 | **Real-World Workload Scenarios**: Complete multi-step trade lifecycles (snipe-to-exit, migration graduation, take-profit ladders, WAL crash recovery replay, copy-trading decoupling). |
| **Total** | | **12** | **282** | **100% Passing** |

---

## Shared Test Infrastructure & Helpers (`tests/e2e/helpers/`)

### 1. `testDb.ts` — Isolated SQLite WAL Test Database Generator
- **Purpose**: Instantiates isolated temporary SQLite database files inside OS scratch directories (`os.tmpdir()`), executes schema creation (`positions`, `orders`, `transactions`, `risk_decisions`, `system_journal`), and enables `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`.
- **Cleanup**: Implements `.close()`, which flushes WAL logs, closes handles, and unlinks all `.db`, `.db-wal`, and `.db-shm` files to guarantee zero state bleed or cross-test file locks.
- **Key Methods**: `savePosition()`, `loadPositions()`, `saveOrder()`, `getOrder()`, `saveTransaction()`, `saveRiskDecision()`.

### 2. `mockRpc.ts` — In-Process Solana RPC Simulator
- **Purpose**: Creates duck-typed `@solana/web3.js` `Connection` instances that run entirely in-process without binding network sockets.
- **Capabilities**:
  - Programmable slot tracking (`getSlot()`, `setSlot()`, `advanceSlot()`).
  - Mock account data storage (`setAccount()`, `getAccountInfo()`, `getMultipleAccountsInfo()`).
  - Transaction dispatch and signature status resolution (`sendRawTransaction()`, `getSignatureStatuses()`).
  - Simulated transaction execution with custom compute units and error injection (`simulateTransaction()`).

### 3. `mockJito.ts` — In-Process Jito Block Engine Interceptor
- **Purpose**: Intercepts `globalThis.fetch` to simulate Jito Block Engine endpoints (`/api/v1/bundles`, `/tip_floor`) with deterministic millisecond response times.
- **Capabilities**:
  - Tip floor calculation (`landed_tips_50th_percentile`, `ema_landed_tips_50th_percentile`).
  - Bundle submission simulation (`sendBundle`) with synthetic `bundleId` issuance.
  - Bundle status query inspection (`getBundleStatuses`, `getInflightBundleStatuses`) with `Pending`, `Landed`, `Failed`, and `Dropped` transitions.
  - Error simulation flags for network timeouts and cluster drops.

### 4. `simulatedStates.ts` — Canonical Test Data & Fixtures
- **Canonical Mints**:
  - `VALID_PUMP_MINT_1`: Canonical active Pump.fun bonding curve mint.
  - `VALID_PUMP_MINT_2`: Secondary active Pump.fun bonding curve mint.
  - `GRADUATED_PUMP_MINT`: Completed bonding curve mint migrated to PumpSwap.
  - `TOKEN_2022_MINT`: SPL Token-2022 mint with extension metadata.
  - `SOL_NATIVE_MINT`: Native SOL mint address.
  - `NON_SOL_QUOTE_MINT`: Non-SOL quote token (USDC) for rejection tests.
- **Simulated States**:
  - `createSimulatedBondingCurveState()`: Generates full bonding curve reserve states with virtual and real token/SOL balances.
  - `createSimulatedPumpSwapPoolState()`: Generates canonical PumpSwap AMM pool reserve states.
  - `SIMULATED_PASSING_ELIGIBILITY`: Pre-computed passing `TokenEligibilityReport`.

### 5. `testServer.ts` — Test Express Application Harness
- **Purpose**: Provides an Express testing harness with mounted API routes and WebSocket telemetry endpoints for testing authentication handshakes, origin allowlists, and snapshot streaming.

---

## Execution Instructions

### Run the Full E2E Test Suite (All Tiers)
```bash
npx vitest run tests/e2e --no-file-parallelism
```

### Run by Tier
```bash
# Tier 1: Feature Coverage (Features 1–25)
npx vitest run tests/e2e/tier1 --no-file-parallelism

# Tier 2: Boundary & Corner Cases (Features 1–25)
npx vitest run tests/e2e/tier2 --no-file-parallelism

# Tier 3: Cross-Feature Combinations
npx vitest run tests/e2e/tier3 --no-file-parallelism

# Tier 4: Real-World Workload Scenarios
npx vitest run tests/e2e/tier4 --no-file-parallelism
```

### Run Specific Test Files
```bash
npx vitest run tests/e2e/tier1/features01_05.test.ts
npx vitest run tests/e2e/tier2/boundaries21_25.test.ts
npx vitest run tests/e2e/tier3/crossFeatureCombinations.test.ts
npx vitest run tests/e2e/tier4/realWorldWorkloads.test.ts
```

---

## Safety & Invariance Guarantees
1. **Zero External Network Calls**: Mock RPC and Jito fixtures operate entirely in memory.
2. **Zero Mainnet Funds at Risk**: Live arming requires explicit configuration and confirmation codes; defaults strictly to `PAPER` mode.
3. **Sequential Execution**: Configured with `--no-file-parallelism` to prevent SQLite WAL locks and ensure deterministic test isolation.
4. **Clean Ephemeral Cleanup**: Every test database automatically unlinks temporary files on teardown.
