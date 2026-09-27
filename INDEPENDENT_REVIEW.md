# APEX Quant HFT Workstation — Independent Production-Readiness Review

**Document Version:** 1.0.0 (Master Forensic Deliverable)  
**Date:** 2026-09-26  
**Lead Auditor:** Project Orchestrator (`orchestrator_review`)  
**Investigative Team:**  
- `explorer_r1_codepath` (Execution Path & Protocol Verification)  
- `explorer_r2_operator` (Operator Onboarding & Subsystem Readiness)  
- `worker_r3_testsuite` (Test Suite Integrity & Coverage Audit)  
- `explorer_r4_viability` (Quantitative Signal, Backtest & Fee Economics Audit)  
- `auditor_review` (Forensic Integrity Auditor)  

**Target System:** APEX Quant HFT Workstation (Solana Pump.fun Bonding Curves & Migrated PumpSwap AMM Pools)  
**Target Operating Tier:** `MICRO_10` (Total Bankroll: ~0.07 SOL, Max Risk per Trade: ≤ 10% / ~0.006–0.007 SOL)  
**Workspace:** `/Users/titus/antigravity/Apex-Quant-HFT-—-Workstation`  
**Integrity Mode:** `benchmark` (Strict Enforcement)  

---

### EXECUTIVE AUDIT VERDICTS

| Dimension | Evaluation Category | Status / Verdict | Summary Finding |
| :--- | :--- | :---: | :--- |
| **Operational Readiness** | System Deployability | **NOT PRODUCTION READY** | The system cannot be armed, ingests no live mempool/WebSocket events, and deadlocks on holder checks. |
| **Forensic Integrity** | Behavioral & Testing Truth | 🔴 **INTEGRITY VIOLATION** | Backtests were fabricated via pseudo-random LCG loops; 51.8% of tests are tautologies; ghost code claimed. |
| **Economic Viability** | MICRO_10 Bankroll (0.07 SOL) | **NOT VIABLE** | Round-trip transaction friction and unclosed ATA rent deposits exhaust the bankroll in 13 neutral trades or 6 rugs. |
| **Low-Level Protocol** | Solana Wire, Signing & Anchor | **PROTOCOL CORRECT** | Pinned official SDKs (`@pump-fun/pump-sdk@1.37.0`, `@pump-fun/pump-swap-sdk@1.20.0`), Ed25519 signing, and Jito transports are real. |

---

## 1. Executive Summary

This independent production-readiness review presents an exhaustive, adversarial investigation into the architectural integrity, test suite fidelity, operational deployability, and quantitative trading viability of the **APEX Quant HFT Workstation**. The workstation is designed as a high-frequency trading (HFT) and algorithmic execution engine targeting Solana memecoin liquidity launches across Pump.fun V2 bonding curves and migrated PumpSwap Automated Market Maker (AMM) pools, operating under a constrained micro-bankroll tier (`MICRO_10`: ~0.07 SOL total capital, ≤ 10% per-trade risk ceiling).

Prior internal development reports—specifically `FINAL_AUDIT_REPORT.md`, `STRATEGY_EVALUATION.md`, `PERFORMANCE_REPORT.md`, and `benchmark_results.json`—certified the platform as `LIVE ARCHITECTURE READY — CONTROLLED VALIDATION REQUIRED`, asserting 100% test passage (473 Vitest tests), a positive out-of-sample trading expectancy (`+0.000677 SOL` per trade, 2.36 Profit Factor across 300 historical launches), sub-100ms controllable snipe latency, and full Phase 0 safety gate clearance.

Our multi-agent forensic audit audited the codebase against current on-chain protocol realities, independent script runs, line-by-line execution tracing, AST inspection of test files, and quantitative micro-capital modeling.

### The Two Contrasting Realities of the Workstation

The codebase exhibits **two starkly contrasting architectural realities**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        APEX WORKSTATION ARCHITECTURAL DUALITY                          │
└────────────────────────────────────────────────────────────────────────────────────────┘

 [UPSTREAM & SYSTEM LEVEL: COMPROMISED / STUBBED / FABRICATED]
 ├── Event Ingestion: 5,000ms HTTP REST polling over Cloudflare-blocked web endpoints (No WS/RPC)
 ├── Token Eligibility: 100% of live buys rejected by SAFETY_CHECK_UNVERIFIED (null holder data)
 ├── Alpha Signals: CreatorRiskScorer, CurveVelocityEvaluator, LiquidityDepthFilter DO NOT EXIST
 ├── ConfluenceEngine: Dead code, never imported or called by the live server
 ├── Capital Sizer: server/capital/capitalSizer.ts DOES NOT EXIST on disk (hardcoded $5 orders)
 ├── Dynamic Exits: server/exits/exitEngine.ts DOES NOT EXIST; hardcoded static +50% / -20% rules
 ├── Backtesting: 100% fabricated via pseudo-random LCG dice rolls with impossible -12% rug exits
 ├── Operator Path: Fatal UI auth lockouts (401), circular startup feed deadlocks, hidden env gates
 └── Fee Economics: Unclosed ATA rent (0.00204 SOL) causes mathematical ruin in 13 neutral trades
 ────────────────────────────────────────────────────────────────────────────────────────
 [DOWNSTREAM EXECUTION LEVEL: REAL / RIGOROUS / PROTOCOL-CORRECT]
 ├── Anchor Serialization: Official @pump-fun/pump-sdk@1.37.0 & @pump-fun/pump-swap-sdk@1.20.0
 ├── Binary Layouts: Exact 27-account Buy / 26-account Sell instruction discrimination
 ├── Local Signing: Pure local Ed25519 keypair signing; keys never exposed via HTTP/WS
 ├── MEV Transport: Jito Block Engine JSON-RPC sendBundle with bounded retry & landing probes
 ├── Direct Fallback: Safe deduplicated direct RPC fallback preserving single logical orderId
 └── Reconciliation: Live pre/post lamport balance deltas & token ATA balance verification
```

1. **The Low-Level Protocol, Signing, Transport, and Reconciliation Layers are Genuine and Protocol-Correct**:
   - The system integrates the pinned official `@pump-fun/pump-sdk@1.37.0` (asserting exact 27-account Buy instructions with Anchor discriminator `b817ee6167c5d33d` and 26-account Sell instructions with discriminator `5df6823ce7e940b2`) and `@pump-fun/pump-swap-sdk@1.20.0` (correctly accounting for `virtualQuoteReserves` and dynamic fee calculation via `computeFeesBps`).
   - Local Ed25519 signing (`server/solana/signer.ts`), Jito Block Engine bundle dispatch (`server/solana/transports.ts`), safe RPC fallback deduplication, pre-trade balance snapshots, and post-trade fill reconciliation (`server/execution/reconciliation.ts`) are fully implemented and interact with live Solana/Jito network primitives.
   - When configured for `LIVE` execution, the transaction builder and transport layers **do not route to simulated mocks**; they construct, sign, and broadcast authentic Solana `VersionedTransaction` (v0 message) payloads.

2. **Upstream Ingestion, Live Arming, Alpha Signals, Testing, and Fee Economics are Fatally Compromised**:
   - **Event Ingestion is a Slow Polling Façade**: There are zero Solana WebSocket or mempool listeners. Ingestion is a 5-second `setInterval` HTTP polling loop hitting public cloud APIs (`frontend-api-v3.pump.fun` and DexScreener). Callout "personalities" are mock influencer personas assigned round-robin via modulo index arithmetic.
   - **Live Trading Has Fatal Execution Deadlocks**:
     - *Holder Verification Deadlock*: In `coordinator.ts:1322–1335`, 100% of live buy orders are rejected with `SAFETY_CHECK_UNVERIFIED` because no code exists to query on-chain holder distribution (`getTokenLargestAccounts` is absent).
     - *Circular Startup Feed Deadlock*: Live arming requires feed events within 120 seconds, but timestamps initialize to `0` (`Infinity` age), permanently blocking arming on startup.
     - *UI 401 Auth Lockout*: The UI provides no token input or login screen, fails `/api/auth/session` with 401, suppresses all WebSocket telemetry, and blocks live arming with `UNAUTHORIZED_MUTATION`.
   - **Pervasive Test Suite Façades (51.8% Tautologies)**: Out of 473 passing tests, at least **245 tests** across E2E Tiers 1–4 assert against inlined variables, tautological string comparisons, or self-fulfilling math formulas inside the test files themselves. Challenger Test 4.2 claims to test fee calculations against the Pump SDK across 500 vectors, but simply computes `(sol * totalBps) / 10000n` twice in local scope and asserts equality.
   - **Ghost Features**: Key modules claimed in documentation—`CreatorRiskScorer`, `CurveVelocityEvaluator`, `LiquidityDepthFilter`, `server/capital/capitalSizer.ts`, `server/exits/exitEngine.ts`, and `server/copy/copyTrader.ts`—**do not exist on disk**. `ConfluenceEngine` exists as a static heuristic ladder, but is completely detached from the runtime server and never invoked by any execution path.
   - **Fabricated Backtesting**: The reported out-of-sample replay in `benchmark_results.json` was generated by a 100-line synthetic Linear Congruential Generator (LCG) loop. Rug pulls were hardcoded to exit at an impossible `-12.0%` loss with a fictional exit reason (`LIQUIDITY_DETERIORATION_STOP`), and network latencies were generated from mathematical sine waves. Zero historical on-chain logs were replayed.
   - **Mathematical Capital Insolvency**: Associated Token Accounts (costing 0.00203928 SOL in rent) are created on buy but **never closed on sell** (`createCloseAccountInstruction` is absent). On a 0.006 SOL trade, round-trip friction and stranded rent consume **72.8%** of invested capital. An operator with a 0.07 SOL bankroll will suffer **complete mathematical ruin in 13 neutral trades or 6 rugs**.

**Conclusion:** While the workstation contains genuine low-level Solana serialization and Jito transport engineering, it is completely inoperable for live trading, detached from genuine alpha, and economically insolvent.

---

## 2. Requirement R1: Independent Code Path Verification

A line-by-line trace was conducted from system startup through the entire trade lifecycle: event ingestion → token eligibility → signal evaluation → risk check → capital sizing → quote → transaction build → sign → submit → confirm → reconcile → position management → exit.

### 2.1 Full 13-Stage Trade Lifecycle Classification Table

| Stage # | Lifecycle Stage | Classification | Primary Source Locations | Verification Summary |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **Event Ingestion** | **STUB** | `server/pumpfunService.ts:287-372`<br>`server/engine/engine.ts:159` | Zero Solana WebSocket or RPC listeners. Relies on a 5-second `setInterval` polling public web APIs (`frontend-api-v3.pump.fun`). Influencer personas assigned via modulo arithmetic (`index % callers.length`). |
| **2** | **Token Eligibility Filtering** | **REAL (FATAL DEAD-END)** | `server/signals/eligibilityFilter.ts:44-235`<br>`server/execution/coordinator.ts:1251-1335` | Rigorous tri-state evaluation logic (`PASS \| FAIL \| UNKNOWN`). However, 100% of live trades fail closed with `SAFETY_CHECK_UNVERIFIED` because no code queries on-chain holder distribution (`devHoldingPct: null`). |
| **3** | **Signal Evaluation (Alpha)** | **STUB / DETACHED** | `server/signals/confluenceEngine.ts:15-107` | Heuristic scoring exists, but is completely detached from the runtime trade pipeline. Never imported or invoked by `server.ts`, `coordinator.ts`, `memecoinAggregator.ts`, or `pumpfunService.ts`. |
| **4** | **Risk Check** | **REAL** | `server/risk/riskEngine.ts:34-286`<br>`server/execution/coordinator.ts:1134-1161, 1381-1409` | 14-point deterministic pre-trade risk engine enforcing kill switches, circuit breakers, 30s mint cooldowns, 0.007 SOL position ceiling, and 0.015 SOL wallet reserve floor. |
| **5** | **Capital Sizing** | **MISSING** | Claimed `server/capital/capitalSizer.ts`<br>`tests/e2e/tier1/features21_25.test.ts:55-75` | Claimed file does not exist on disk. Zero Fractional Kelly sizing in runtime. Server uses hardcoded $5 USD defaults. Tests pass by defining their own lambda functions inside the test files. |
| **6** | **Quote & Price Calculation** | **REAL** | `server/solana/pumpCurve.ts:370-870`<br>`server/solana/pumpSwapService.ts:124-319` | Protocol-correct integration with official `@pump-fun/pump-sdk@1.37.0` and `@pump-fun/pump-swap-sdk@1.20.0`. Enforces dynamic fees via `computeFeesBps` and includes `virtualQuoteReserves`. |
| **7** | **Transaction Build** | **REAL** | `server/solana/transactionBuilder.ts:162-415`<br>`server/solana/pumpSwapService.ts:322-487` | Builds valid Solana `VersionedTransaction` (v0) messages with compute budget instructions, idempotent ATA creation, exact 27-account Buy / 26-account Sell Pump V2 layouts, and Jito tip transfers. |
| **8** | **Sign** | **REAL** | `server/solana/signer.ts:20-212`<br>`scripts/import_signer.ts:1-72` | Pure local Ed25519 signing using `@solana/web3.js` and Node `crypto.sign`. Keypair imported with strict `0600` POSIX file permissions. Private key never exposed to HTTP/WS layers. |
| **9** | **Submit** | **REAL** | `server/solana/transports.ts:354-442, 57-90`<br>`server/execution/coordinator.ts:821-1049` | Real Jito Block Engine JSON-RPC `sendBundle` dispatch with bounded retries, pre-retry landing verification, and deduplicated direct RPC fallback (`sendRawTransaction`) sharing single `orderId`. |
| **10** | **Confirm** | **REAL** | `server/solana/transports.ts:491-578, 122-182` | Dual confirmation tracking: polls Jito inflight/finalized bundle statuses and queries Solana RPC `getSignatureStatuses` with `searchTransactionHistory: true` and `getTransaction`. |
| **11** | **Reconcile** | **REAL** | `server/execution/reconciliation.ts:44-540`<br>`server/execution/coordinator.ts:376-584` | Pre-trade balance snapshots, verified lamport and token balance deltas from confirmed transaction metadata, mathematical effective fill price, zero-delta fill protection, and startup recovery. |
| **12** | **Position Management** | **PARTIAL REAL / STUB** | `server/execution/coordinator.ts:654-728, 1867-1891`<br>`server/db/database.ts:101-103` | Real on-chain mark pricing and PnL calculation. However, dynamic trailing stop, take-profit ladder, and `exitEngine.ts` are MISSING. Monitor uses static hardcoded +50% TP / -20% SL thresholds. |
| **13** | **Exit** | **REAL** | `server/execution/coordinator.ts:1641-1865`<br>`server/solana/transactionBuilder.ts:364-400` | Full execution path for partial/full exits across both Pump bonding curves and migrated PumpSwap AMMs, with Jito submission and reconciliation. (Suffers from unclosed ATA rent bleed). |

---

### 2.2 Line-by-Line Deep Dive for All 13 Stages

#### Stage 1: Event Ingestion
- **Implementation Status:** **STUB**
- **Exact Code Locations:** `server/pumpfunService.ts:287-301` (`initPolling`), `server/pumpfunService.ts:304-372` (`syncRealWorldData`), `server/pumpfunService.ts:375-558` (`rebuildHotCallouts`), `server/engine/engine.ts:159` (Binance WebSocket).
- **Technical Analysis:**
  - Zero Solana or Pump.fun WebSocket listeners exist in the entire codebase. A search across `server/` shows that the only `new WebSocket` instances are in `server/engine/engine.ts`, connecting to `wss://stream.binance.com:9443` for an unused BTCUSDT Avellaneda-Stoikov futures orderbook.
  - Event ingestion is driven solely by a 5,000ms `setInterval` HTTP polling loop:
    ```typescript
    // server/pumpfunService.ts:298-300
    setInterval(() => {
      this.syncRealWorldData().catch(() => {});
    }, 5000);
    ```
  - This loop queries unofficial public web endpoints:
    `https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=last_trade_timestamp&order=DESC&includeNsfw=false` and DexScreener. These endpoints are protected by Cloudflare bot management, failing unpredictably without browser headers.
  - In `server/pumpfunService.ts:389-391`, discovered coins are assigned to fake caller personalities (`INITIAL_CALLERS`: `sol_cabal_insider`, `ansem_tracker_bot`, `kobe_cabal_watcher`) using modulo indexing:
    ```typescript
    const callerIndex = index % this.callers.length;
    const caller = this.callers[callerIndex];
    ```
  - A 5-second polling loop over public web APIs is 100x too slow for Solana memecoin HFT and renders sub-100ms snipe latency claims physically impossible.

#### Stage 2: Token Eligibility Filtering
- **Implementation Status:** **REAL (FATAL DEAD-END)**
- **Exact Code Locations:** `server/signals/eligibilityFilter.ts:44-235` (`EligibilityFilter.evaluate`), `server/execution/coordinator.ts:1251-1335` (`executeTrade`).
- **Technical Analysis:**
  - `EligibilityFilter.evaluate` implements strict, fail-closed tri-state checking (`PASS | FAIL | UNKNOWN`) across freeze authority, mint authority, creator holding (<10%), top 10 holder concentration (<40%), Token-2022 extensions, and liquidity depth.
  - **The Fatal Live Execution Dead-End:** In `coordinator.ts:1262-1286`, when evaluating incoming buy orders:
    ```typescript
    // server/execution/coordinator.ts:1281-1282
    devHoldingPct: null, // Fail-closed in live mode unless explicitly verified
    top10HoldersPct: null, // Fail-closed in live mode unless explicitly verified
    ```
    Then, at lines 1322–1335:
    ```typescript
    // server/execution/coordinator.ts:1322-1335
    const hasUnverifiedHolders = eligibility.checks.some(
      (c) =>
        (c.ruleId === 'MAX_CREATOR_EXPOSURE' || c.ruleId === 'TOP_10_CONCENTRATION') &&
        (!c.passed || String(c.observedValue).toLowerCase().includes('unknown') || String(c.observedValue).toLowerCase().includes('unverified'))
    );
    if (hasUnverifiedHolders) {
      return {
        success: false,
        lifecycleState: 'FILTER_REJECTED',
        executionMode: 'LIVE',
        error: 'SAFETY_CHECK_UNVERIFIED: Dev holding or top 10 holders distribution is unverified. Live trade rejected.',
        correlationId,
      };
    }
    ```
  - Because no upstream caller supplies an `eligibilityReport` and the server has **zero code to query on-chain holder distribution** (`getTokenLargestAccounts` does not exist), `devHoldingPct` and `top10HoldersPct` evaluate to `null` (`UNKNOWN`).
  - **Result: 100% of live buy orders are rejected with `SAFETY_CHECK_UNVERIFIED`.**

#### Stage 3: Signal Evaluation (Alpha Generation)
- **Implementation Status:** **STUB / DETACHED FROM EXECUTION PATH**
- **Exact Code Locations:** `server/signals/confluenceEngine.ts:15-107` (`ConfluenceEngine.calculate`).
- **Technical Analysis:**
  - `ConfluenceEngine.calculate` scores tokens across 7 factors (momentum, liquidity, holder distribution, curve progress, buy/sell count, dev holding, and social).
  - However, `ConfluenceEngine` is **never imported or invoked** in `server/execution/coordinator.ts`, `server/pumpfunService.ts`, `server/memecoinAggregator.ts`, `server/walletTrader.ts`, or `server.ts`.
  - The live trade execution hot-path bypasses alpha scoring completely.

#### Stage 4: Risk Check
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/risk/riskEngine.ts:34-286` (`HardenedRiskEngine.evaluateOrder`), `server/execution/coordinator.ts:1134-1161` (PAPER), `server/execution/coordinator.ts:1381-1409` (LIVE).
- **Technical Analysis:**
  - Evaluates 14 deterministic pre-trade checks: emergency kill switch, circuit breaker state, 15s failure cooldown, 30s per-mint cooldown, 5s market data staleness, 8s signal staleness, 0.007 SOL max position ceiling (MICRO_10), 0.021 SOL aggregate exposure ceiling, 3 concurrent positions ceiling, daily loss limit, 800 bps slippage limit, max execution fee percentage (20%), and 0.015 SOL wallet gas reserve floor.
  - In-flight balance reservations are checked in `coordinator.ts:1371` and persisted to SQLite via `saveRiskDecision`.

#### Stage 5: Capital Sizing
- **Implementation Status:** **MISSING**
- **Exact Code Locations:** Claimed in `PROJECT.md:126` (`server/capital/capitalSizer.ts`). Tested in `tests/e2e/tier1/features21_25.test.ts:55-75`.
- **Technical Analysis:**
  - `server/capital/capitalSizer.ts` **does not exist anywhere on disk**.
  - No Fractional Kelly calculation, shrinkage formula, or spendable bankroll calculation exists in the runtime code.
  - Trade sizing in production code is hardcoded:
    - `server/pumpfunService.ts:283`: `snipeAmountUsd: 5.0` (hardcoded $5 USD).
    - `server/memecoinAggregator.ts:198-199`: `const amountUsd = Math.max(1.0, params.amountUsd || this.config.defaultSnipeAmountUsd);`.
  - Automated tests pass because they declare their own `const computeShrunkKelly = ...` lambdas inside the test files.

#### Stage 6: Quote & Price Calculation
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/solana/pumpCurve.ts:370-647` (`fetchPumpMarketState`), `server/solana/pumpCurve.ts:650-870` (`calculateBuyQuote`, `calculateSellQuote`), `server/solana/pumpSwapService.ts:124-319` (`getPoolState`, `quotePumpSwapBuyQuoteInput`, `quotePumpSwapSellBaseInput`).
- **Technical Analysis:**
  - Pinned official `@pump-fun/pump-sdk@1.37.0` decodes on-chain `BondingCurve`, `Global`, and `FeeConfig` accounts via Anchor.
  - Dynamically calculates protocol and creator fee schedules via official SDK `computeFeesBps`.
  - PumpSwap integration uses pinned official `@pump-fun/pump-swap-sdk@1.20.0`, correctly deriving canonical pool PDAs and enforcing `effectiveQuoteReserves = quoteReserve + virtualQuoteReserves`.
  - Fails closed in LIVE mode if SDK decode fails, fee config is unresolved, or quote mint is non-SOL.

#### Stage 7: Transaction Build
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/solana/transactionBuilder.ts:162-246` (`createPumpBuyV2Instruction`, `createPumpSellV2Instruction`), `server/solana/transactionBuilder.ts:312-400` (`buildBuyTransaction`, `buildSellTransaction`), `server/solana/pumpSwapService.ts:322-487`.
- **Technical Analysis:**
  - Fast-path assembly of Solana `VersionedTransaction` (v0 message):
    1. Compute budget limit (`setComputeUnitLimit`, default 250,000 CU) and priority price (`setComputeUnitPrice`, default 25,000 µLamports).
    2. Idempotent ATA creation instruction (`createAtaIdempotentInstruction`).
    3. Official Pump V2 Buy instruction compiled via `sdk.getBuyV2InstructionRaw` (27 accounts, discriminator `b817ee6167c5d33d`).
    4. Official Pump V2 Sell instruction compiled via `sdk.getSellV2InstructionRaw` (26 accounts, discriminator `5df6823ce7e940b2`).
    5. Jito tip transfer instruction appended as final instruction in transaction.
    6. For migrated pools, compiles official `PUMP_AMM_SDK.buyInstructions` / `sellInstructions`.

#### Stage 8: Sign
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/solana/signer.ts:20-212` (`LocalKeypairSigner`), `scripts/import_signer.ts:1-72`.
- **Technical Analysis:**
  - Signs VersionedTransactions locally using `@solana/web3.js` `transaction.sign([this.keypair])`.
  - Keypair imported via `scripts/import_signer.ts` with restricted `0600` POSIX file permissions.
  - Zero private keys are accepted via HTTP, WebSocket, or browser layers.

#### Stage 9: Submit
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/solana/transports.ts:354-442` (`JitoTransport.submit`), `server/solana/transports.ts:57-90` (`SolanaRpcTransport.submit`), `server/execution/coordinator.ts:821-1049` (`submitAndConfirmWithRetry`).
- **Technical Analysis:**
  - Serializes VersionedTransaction to raw wire bytes and dispatches JSON-RPC `sendBundle` to Jito Block Engine (`${jitoBlockEngineUrl}/api/v1/bundles`).
  - Implements bounded idempotent retries, executing `checkIfTransactionLanded` before each retry to verify signature status and token balance deltas.
  - Implements safe direct RPC fallback via `connection.sendRawTransaction`, preserving the single logical `orderId` in SQLite.

#### Stage 10: Confirm
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/solana/transports.ts:491-578` (`JitoTransport.confirm`), `server/solana/transports.ts:122-182` (`SolanaRpcTransport.confirm`).
- **Technical Analysis:**
  - Dual confirmation tracking: queries Jito `getInflightBundleStatuses` / `getBundleStatuses` and Solana RPC `getSignatureStatuses` (`searchTransactionHistory: true`).
  - Fetches confirmed transaction details via `connection.getTransaction` (version 0), extracting confirmed slot, landing timestamp, and actual execution fees.

#### Stage 11: Reconcile
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/execution/reconciliation.ts:46-410` (`capturePreTradeSnapshot`, `reconcileBuyTransaction`, `reconcileSellTransaction`), `server/execution/coordinator.ts:376-584` (`startupReconciliation`).
- **Technical Analysis:**
  - Captures lamport and token ATA balance snapshots immediately prior to signing.
  - Reconstructs actual SOL spent and tokens received directly from confirmed transaction metadata (`preBalances`, `postBalances`, `preTokenBalances`, `postTokenBalances`).
  - Fail-closed gate: if token delta <= 0, marks transaction `RECONCILIATION_REQUIRED` and refuses to open a position.
  - Startup crash recovery evaluates unconfirmed transactions from SQLite and queries on-chain history.

#### Stage 12: Position Management
- **Implementation Status:** **PARTIAL REAL / STUB**
- **Exact Code Locations:** `server/execution/coordinator.ts:654-728` (`updatePositionMarkPrices`), `server/execution/coordinator.ts:1867-1891` (`startAutoPositionMonitor`), `server/db/database.ts:101-103`.
- **Technical Analysis:**
  - Periodically queries live on-chain reserves via `RealMarkPriceService` and computes unrealized PnL.
  - **However, dynamic exits are stubbed**: `startAutoPositionMonitor` runs every 3 seconds and checks only static hardcoded thresholds:
    ```typescript
    // server/execution/coordinator.ts:1882-1888
    if (pos.unrealizedPnLPct >= 50.0) {
      await this.closePosition(pos.id, 100, `Auto TP (+${pos.unrealizedPnLPct.toFixed(1)}%)`);
    } else if (pos.unrealizedPnLPct <= -20.0) {
      await this.closePosition(pos.id, 100, `Auto SL (${pos.unrealizedPnLPct.toFixed(1)}%)`);
    }
    ```
  - Dynamic trailing stop, take-profit ladder, and `exitEngine.ts` are completely absent. SQLite columns `high_water_mark_sol` and `trailing_stop_sol` are never written or read by the monitor.

#### Stage 13: Exit
- **Implementation Status:** **REAL**
- **Exact Code Locations:** `server/execution/coordinator.ts:1641-1865` (`closePosition`), `server/solana/transactionBuilder.ts:364-400` (`buildSellTransaction`).
- **Technical Analysis:**
  - Evaluates exit venue (Pump bonding curve vs PumpSwap AMM), builds sell instructions, signs locally, submits via Jito + RPC fallback, and reconciles realized PnL.
  - **Critical Flaw:** Associated Token Accounts are **never closed** on sell (`createCloseAccountInstruction` is completely absent), permanently locking 0.00203928 SOL rent per token.

---

### 2.3 Live Routing Integrity Verification
- **Audit Question:** Does switching to LIVE mode execute real on-chain Solana logic, or does it silently fall back to simulated mocks?
- **Finding:** **It routes to real on-chain Solana logic.**
- When armed via `ExecutionCoordinator.armLiveTrading(true, confirmationCode)`:
  - `this.executionMode` transitions to `'LIVE'`.
  - In `executeTrade()`, the PAPER branch (`coordinator.ts:1096-1198`) is bypassed.
  - The LIVE branch (`coordinator.ts:1200-1638`) executes real on-chain state fetching (`PumpCurveService.fetchPumpMarketState`), real Jito tip floor queries, real balance checks, real Anchor instruction compilation, local Ed25519 signing, and real Jito Block Engine HTTP dispatch.
- **The Caveat:** While the wire protocol is genuine, live trades cannot complete because execution halts at Stage 2 due to the `SAFETY_CHECK_UNVERIFIED` deadlock.

---

### 2.4 Error Handling, Rollbacks & Concurrency Safety
- **In-Flight Capital Reservation:**
  - Guarded in `coordinator.ts:1371` (`spendable - inFlightReservedSol - requiredSol >= 0.015`).
  - Incremented before build (`inFlightReservedSol += requiredSol`) and guaranteed released in a `finally` block (`coordinator.ts:1634-1637`).
- **Exit Mutex Guard:**
  - `coordinator.ts:1646-1650`: Concurrency guard `inFlightPositionExits` rejects overlapping exit attempts on the same position with `EXIT_IN_PROGRESS`. Released in a `finally` block.
- **Zero-Delta Fill Protection:**
  - Confirmed transactions with zero token delta are marked `RECONCILIATION_REQUIRED` and denied position creation (`reconciliation.ts:198-212`).
- **Error Swallowing Weaknesses:**
  - `server/pumpfunService.ts:318, 328, 349`: Public HTTP fetch errors are caught and swallowed (`.catch(() => null)`). Cloudflare IP blocks degrade silently to empty arrays without raising system alerts.
  - `server.ts:198`: WebSocket mutating commands swallow errors with empty `catch {}`.

---

## 3. Requirement R2: Plug-and-Play Readiness Assessment

### Unequivocal Operator Readiness Statement:
> **An operator CANNOT go live with just a wallet and these steps.**

Attempting to transition from a clean checkout to profitable live trading via the advertised 5-step onboarding path:
1. `npm ci`
2. Configure `.env` with RPC endpoint, Jito endpoint, and operator token
3. `npm run signer:import -- <keypair.json>` (funded with ~0.07 SOL)
4. `npm run build && npm start`
5. Arm live mode through the UI or API

**fails catastrophically at every single step after Step 3.** The system cannot be armed through the UI, cannot be armed through the API using documented settings, relies on dead external web polling rather than real Solana streaming feeds, disconnects its alpha engine from execution, and suffers mathematical ruin on a 0.07 SOL bankroll.

---

### 3.1 Step-by-Step Failure Point Breakdown

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        5-STEP OPERATOR ONBOARDING TRACE                                │
└────────────────────────────────────────────────────────────────────────────────────────┘

 [Step 1: npm ci] ──────────────────► CONDITIONAL PASS (CRASHES ON NODE 20 LTS)
   ├── Uses built-in 'node:sqlite' introduced in Node v22.5.0
   └── README.md advertises Node 20+; package.json lacks engines field -> Crashes on Node 20

 [Step 2: Configure .env] ──────────► FATAL CONFIG MISMATCH & HIDDEN GATES
   ├── Code requires OPERATOR_AUTH_TOKEN (>=16 chars); .env.example lists OPERATOR_SECRET
   ├── Unset token generates random unprinted ephemeral key -> Unknown credentials
   ├── Mandatory gate ALLOW_LIVE_REAL_MONEY_TRADING="true" omitted from .env.example
   └── PORT=3000 hardcoded in server.ts (ignores PORT in .env)

 [Step 3: signer:import] ───────────► CONDITIONAL PASS
   ├── Imports keypair to .apex_trading_keypair.json with 0600 permissions
   └── Throws error if file exists unless --force is passed; no balance check at import

 [Step 4: build && start] ──────────► PASS / SPURIOUS SERVICES RUNNING
   ├── Vite and esbuild bundle frontend and server cleanly
   └── Spurious Avellaneda-Stoikov BTCUSDT engine runs and loops on geo-blocked Binance WS

 [Step 5: Arm Live Mode] ───────────► COMPLETE FAILURE (FATAL BLOCKER)
   ├── UI Path: 401 on /api/auth/session; no login UI; UI arming sends unauthenticated request
   │            Express middleware rejects with 401 UNAUTHORIZED_MUTATION
   └── API Path: Startup feed ages are Infinity (lastPumpFeedTimestamp=0)
                canExecuteLive() rejects with "Prerequisites failed: Pump stream DISCONNECTED"
```

#### Step 1: `npm ci`
- **Result:** **Conditional Pass (Fatal Runtime Failure on Node 20 LTS)**.
- **Root Cause:** `server/db/database.ts:1` imports `DatabaseSync` via `import { DatabaseSync } from 'node:sqlite';`. Built-in SQLite was introduced in **Node.js v22.5.0**. However, `README.md:26` states: `Prerequisites: Node.js 20+ installed.` In Node 20 LTS, executing the server or CLI tools immediately crashes with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`. Furthermore, `package.json` lacks an `engines` declaration (`"engines": { "node": ">=22.5.0" }`), allowing `npm ci` to succeed silently on Node 20 before crashing at runtime.

#### Step 2: Configure `.env`
- **Result:** **Fatal Configuration Mismatch & Hidden Environment Gates**.
- **Root Cause 1 (Token Variable Collision):**
  - `.env.example:15-16` provides `OPERATOR_SECRET=""` and `OPERATOR_SESSION_SECRET=""`.
  - `README.md:79` documents `OPERATOR_SECRET_KEY`.
  - `KNOWN_RISKS.md:82` documents `APEX_OPERATOR_TOKEN`.
  - **Implementation Reality (`server/middleware/auth.ts:35-36`):** The auth manager strictly checks `process.env.OPERATOR_AUTH_TOKEN`. All other variables are ignored. If `OPERATOR_AUTH_TOKEN` is unset, `initPrimaryToken()` generates a random 32-byte hexadecimal token in memory and **never prints it to stdout**, locking the operator out.
- **Root Cause 2 (Undocumented Real-Money Gate):**
  - In `coordinator.ts:163-165, 622-628`, arming live trading requires `process.env.ALLOW_LIVE_REAL_MONEY_TRADING === 'true'`. This variable is **completely absent from `.env.example`** and never documented.
- **Root Cause 3 (Hardcoded Port):**
  - `server.ts:40` hardcodes `const PORT = 3000;`. Specifying `PORT` in `.env` silently does nothing.

#### Step 3: `npm run signer:import -- <keypair.json>`
- **Result:** **Conditional Pass**.
- **Root Cause:** Parses keypair arrays or base58 strings and writes `.apex_trading_keypair.json` with POSIX `0600` permissions. However, if the file exists, it fails unless `--force` is provided, and it does not check on-chain balance at import time.

#### Step 4: `npm run build && npm start`
- **Result:** **Partial Pass (Spurious Background Services)**.
- **Root Cause:** Bundling succeeds. However, on startup, `server/engine/engine.ts:58-62` launches an Avellaneda-Stoikov market maker for `BTCUSDT` and connects via WebSocket to `wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms`. In US jurisdictions, Binance.com is geo-blocked, causing continuous WebSocket error events and reconnect loops in the console.

#### Step 5: Arm Live Mode Through UI or API
- **Result:** **Complete Failure (Fatal Blocker)**.
- **5A. UI Arming Failure Path (The 401 Lockout):**
  1. Browser loads `http://localhost:3000` and opens WebSocket to `/ws/engine`.
  2. Server responds with `{ type: 'AUTH_REQUIRED' }`.
  3. `src/services/engineClient.ts:33` calls `fetch('/api/auth/session')` without an authorization header.
  4. In `server.ts:292-311`, `GET /api/auth/session` requires an already-present Bearer token; otherwise, it returns `401 Unauthorized`.
  5. `getOperatorSessionToken()` returns empty string `""`. The WebSocket never authenticates.
  6. In `server.ts:51-53`, all WebSocket telemetry, position updates, and logs are suppressed for unauthenticated clients. The UI is completely blank.
  7. There is **no login screen, modal, or input field** anywhere in the React UI (`src/App.tsx`, `src/components/*`) to enter `OPERATOR_AUTH_TOKEN`. Function `setOperatorSessionToken` is defined but never called.
  8. Clicking "Arm Live Trading" in `PlugAndPlayTradingModal.tsx:140` calls `POST /api/execution/arm` without auth. Express middleware `requireOperatorAuth` (`server/middleware/auth.ts:158-169`) rejects the request with `401 UNAUTHORIZED_MUTATION`.
- **5B. API Arming Failure Path (Startup Feed Deadlock):**
  - Even if the operator executes a direct curl request supplying `Authorization: Bearer <token>` and `confirmationCode: "CONFIRM_LIVE_TRADING_RISK"`, arming is evaluated by `canExecuteLive()` (`coordinator.ts:197-237`):
    ```typescript
    const pumpFeedAgeMs = this.lastPumpFeedTimestamp > 0 ? now - this.lastPumpFeedTimestamp : Infinity;
    const pumpFeedHealthy = this.pumpFeedHealth === 'HEALTHY' && pumpFeedAgeMs <= 120000;
    ```
  - On startup, `lastPumpFeedTimestamp = 0` and `lastRealMarketEventTimestamp = 0`. Both ages evaluate to `Infinity`.
  - `canExecuteLive().allowed` returns `false`, rejecting the request:
    `Cannot arm live trading. Prerequisites failed: Pump.fun real event stream is DISCONNECTED (never received); Real on-chain market feed has no recent events (never received)`.

---

### 3.2 Deep-Dive Verification of Critical Subsystems

#### Server Startup & UI Serving
| Component | Audit Finding | Code Reference |
| :--- | :--- | :--- |
| **Startup Script** | `node dist/server.cjs` executes HTTP server cleanly on Node ≥22.5. | `package.json:9` |
| **Port Binding** | Hardcoded to `3000`. Ignores `process.env.PORT`. | `server.ts:40, 1869` |
| **Host Binding** | Binds to `process.env.BIND_HOST \|\| '127.0.0.1'`. | `server.ts:1868-1869` |
| **Static Assets** | Serves compiled SPA assets from `dist/` when `NODE_ENV=production`. | `server.ts:1861-1865` |

#### WebSocket Connections
| Connection | Mechanism | Operational Reality |
| :--- | :--- | :--- |
| **Client → Backend** | Path `/ws/engine`. Requires `action: 'AUTHENTICATE'`. | **Fails silently in UI.** Client cannot authenticate due to 401 session check. Telemetry suppressed (`server.ts:51-53`). |
| **Backend → Solana WS** | RPC initialized without WebSocket endpoint argument. | **Non-existent.** `SOLANA_WS_URL` is decorative. Backend never invokes `connection.onLogs` or `onProgramAccountChange`. |
| **Backend → Binance WS** | Connects to `wss://stream.binance.com:9443` for BTCUSDT. | **Spurious / Geo-blocked.** Unused futures engine continuously disconnects in US regions (`engine.ts:158`). |

#### Pump.fun Live Data Stream
- **Dead HTTP Polling Endpoint:** No WebSocket or gRPC stream exists. In `server/pumpfunService.ts:304-323`, the server executes an HTTP GET polling loop every 5 seconds to `https://frontend-api-v3.pump.fun/coins?offset=0&limit=30...`. This unofficial web endpoint is Cloudflare-protected, returning 403 or empty arrays to automated scrapers.
- **Attribution & Provenance Façade:** Coins are attributed to hardcoded fake Twitter personas via modulo arithmetic (`index % this.callers.length`). Furthermore, in `server/memecoinAggregator.ts:301`, candidate orders generated from these pools are assigned `provenance: 'SYNTHETIC_TEST'`, which `ExecutionCoordinator.executeTrade` strictly rejects in LIVE mode (`coordinator.ts:1084`).
- **Alpha Disconnection:** `ConfluenceEngine` is never invoked in any trade pipeline.

#### Jito Bundle Transport
- Submits valid JSON-RPC 2.0 `sendBundle` payloads to `https://mainnet.block-engine.jito.wtf/api/v1/bundles` (`server/solana/transports.ts:365`).
- Correctly includes tip transfer to rotating Jito tip accounts as final instruction.
- **Probe Health Façade:** In `server/solana/transports.ts:230-257`, `jitoTransport.probe()` calls `getTipFloorLamports()`. If the Jito tip floor API fails or drops, it catches the error, returns `null`, and still marks Jito health as `'HEALTHY'`.

#### SQLite Persistence Across Restarts
- Implemented via `node:sqlite` (`DatabaseSync`) with `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;` (`server/db/database.ts:47-55`).
- Positions, transactions, and risk decisions persist cleanly across restarts.
- **Startup Blocker Condition:** In `coordinator.ts:408-416`, if an on-chain token balance is 0 for an open database position, it sets system status to `RECONCILIATION_MISMATCH`, permanently blocking live arming.

---

## 4. Requirement R3: Test Suite Integrity Audit

### 4.1 Raw Command Outputs from Independent Test Execution

Commands were executed independently from the workspace root:

1. **`npm test` (Vitest Test Suite):**
   - **Command:** `npm test` (executes `vitest run`)
   - **Exit Code:** `0`
   - **Duration:** `102.68s`
   - **Test Files:** **21 passed (21 total)**
   - **Tests:** **473 passed (473 total, 0 failed, 0 skipped)**
   - *Result Summary:* The test suite reports 100% green tests.

2. **`npm run typecheck` (TypeScript Compiler):**
   - **Command:** `tsc --noEmit`
   - **Exit Code:** `0`
   - **Errors:** `0 errors`. TypeScript compilation passes clean across all files.

3. **`npm run lint` (ESLint Static Analysis):**
   - **Command:** `eslint . && tsc --noEmit`
   - **Exit Code:** `0`
   - **Errors:** `0 errors`
   - **Warnings:** `157 warnings` (primarily `@typescript-eslint/no-unused-vars` and `no-empty` blocks).

4. **`cargo test` (Native Rust Acceleration Engine):**
   - **Command:** `cargo test`
   - **Exit Code:** `0`
   - **Tests:** **4 passed (0 failed)** (`test_push_and_pop`, `test_cancel_order`, `test_add_order`, `test_match_buy_market`).
   - *Note:* The native Rust orderbook is a standalone crate and is not bound to Node.js via N-API / neon.

---

### 4.2 Test Suite Taxonomy: Genuine vs. Facade Tests

An AST and source code inspection of all 21 test files revealed that **245 tests (51.8%)** are pure facades or tautologies:

| Category | File Path | Total Tests | Genuine Tests | Facade / Tautology | Facade Ratio |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Core Protocol** | `tests/solanaTransactionBuilder.test.ts` | 20 | 20 | 0 | 0.0% |
| **Core Risk** | `tests/riskEngine.test.ts` | 20 | 20 | 0 | 0.0% |
| **Core Accounting** | `tests/accountingAndReconciliation.test.ts` | 20 | 19 | 1 | 5.0% |
| **Core Coordinator** | `tests/executionCoordinator.test.ts` | 20 | 18 | 2 | 10.0% |
| **Adversarial Core** | `tests/adversarialGen2SecurityConcurrencyM1.test.ts` | 15 | 15 | 0 | 0.0% |
| **Adversarial Core** | `tests/adversarialExecutionCoordinator.test.ts` | 15 | 14 | 1 | 6.7% |
| **Adversarial Edge** | `tests/m1_execution_edge_cases.test.ts` | 10 | 10 | 0 | 0.0% |
| **Challenger Protocol**| `tests/challenger_m1_protocol_correctness.test.ts` | 20 | 15 | 5 | 25.0% |
| **Adversarial Security**| `tests/adversarialConcurrencyAndSecurityM1.test.ts` | 15 | 10 | 5 | 33.3% |
| **E2E Tier 1 (Features)**| `tests/e2e/tier1/features01_05.test.ts` | 33 | 8 | 25 | 75.8% |
| **E2E Tier 1 (Features)**| `tests/e2e/tier1/features06_10.test.ts` | 32 | 10 | 22 | 68.8% |
| **E2E Tier 1 (Features)**| `tests/e2e/tier1/features11_15.test.ts` | 31 | 8 | 23 | 74.2% |
| **E2E Tier 1 (Features)**| `tests/e2e/tier1/features16_20.test.ts` | 31 | 5 | 26 | 83.9% |
| **E2E Tier 1 (Features)**| `tests/e2e/tier1/features21_25.test.ts` | 25 | 6 | 19 | 76.0% |
| **E2E Tier 2 (Boundaries)**| `tests/e2e/tier2/boundaries01_05.test.ts` | 30 | 5 | 25 | 83.3% |
| **E2E Tier 2 (Boundaries)**| `tests/e2e/tier2/boundaries06_10.test.ts` | 30 | 8 | 22 | 73.3% |
| **E2E Tier 2 (Boundaries)**| `tests/e2e/tier2/boundaries11_15.test.ts` | 30 | 7 | 23 | 76.7% |
| **E2E Tier 2 (Boundaries)**| `tests/e2e/tier2/boundaries16_20.test.ts` | 30 | 6 | 24 | 80.0% |
| **E2E Tier 2 (Boundaries)**| `tests/e2e/tier2/boundaries21_25.test.ts` | 30 | 4 | 26 | 86.7% |
| **E2E Tier 3 (Cross-Feat)**| `tests/e2e/tier3/crossFeatureCombinations.test.ts` | 15 | 3 | 12 | 80.0% |
| **E2E Tier 4 (Workloads)** | `tests/e2e/tier4/realWorldWorkloads.test.ts` | 15 | 2 | 13 | 86.7% |
| **TOTALS** | **21 Files** | **473** | **228 (48.2%)** | **245 (51.8%)** | **51.8%** |

---

### 4.3 Detailed Spot-Checks of 14 Specific Tests with Verbatim Snippets

#### 1. Challenger Test 4.2 (`tests/challenger_m1_protocol_correctness.test.ts:816-821`)
- **Title:** `Property 4.2: PumpCurveService buy fee reconciliation against SDK (500 random vectors)`
- **Category:** **Pure Tautology / Facade Test**
- **Verbatim Code:**
  ```typescript
  iterations++;
  const totalBps = BigInt(pBps + cBps);
  const sdkTotal = (sol * totalBps) / 10000n;
  const engineTotal = (sol * totalBps) / 10000n;

  expect(engineTotal).toBe(sdkTotal);
  ```
- **Forensic Assessment:** Despite claiming property reconciliation of `PumpCurveService` against an official SDK across 500 vectors, neither `PumpCurveService` nor any SDK function is called. The test defines two identical local variables and asserts equality. It passes even if `PumpCurveService` is deleted.

#### 2. Feature 5 (`tests/e2e/tier1/features01_05.test.ts:284-294`)
- **Title:** `Feature 5: Jito Bundle Submission & Status Lifecycle -> F5.1 & F5.2`
- **Category:** **Tautology / Hardcoded Assertion**
- **Verbatim Code:**
  ```typescript
  it('F5.1: bundle submission returns a valid bundle UUID', async () => {
    const txSig = 'sig-abc-123';
    const bundleId = 'bundle-xyz-789';
    expect(bundleId).toBeDefined();
    expect(txSig).not.toEqual(bundleId);
  });

  it('F5.2: bundle status transitions through correct lifecycle states', async () => {
    const states = ['SUBMITTED_TO_JITO', 'PENDING_BLOCK', 'CONFIRMED_ON_CHAIN', 'FINALIZED'];
    expect(states).toContain('CONFIRMED_ON_CHAIN');
  });
  ```
- **Forensic Assessment:** `F5.1` asserts that two hardcoded strings are not equal. `F5.2` asserts that a locally declared string array contains one of its own elements. Neither tests Jito transports or transaction lifecycles.

#### 3. Feature 10 (`tests/e2e/tier1/features06_10.test.ts:622-627`)
- **Title:** `Feature 10: Slippage Enforcement & Dynamic Price Protection -> F10.3`
- **Category:** **Tautology / Local Arithmetic**
- **Verbatim Code:**
  ```typescript
  it('F10.3: dynamic slippage margin computed properly relative to base max', () => {
    const maxSlippage = 0.07; // 7%
    const actualSlippage = 0.015;
    const margin = maxSlippage - actualSlippage;
    expect(margin).toBeCloseTo(0.055);
  });
  ```
- **Forensic Assessment:** Asserts that `0.07 - 0.015 === 0.055`. Does not invoke `HardenedRiskEngine` or verify slippage protection.

#### 4. Feature 15 (`tests/e2e/tier1/features11_15.test.ts:344-353, 377-384`)
- **Title:** `Feature 15: Latency Telemetry & Metric Profiling -> F15.3 & F15.5`
- **Category:** **Facade / In-Test Algorithm**
- **Verbatim Code:**
  ```typescript
  it('F15.3: p50 and p95 latency percentiles calculated accurately', () => {
    const latencies = [5, 8, 12, 14, 15, 18, 20, 22, 25, 30];
    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1)];
    expect(p50).toBe(18);
    expect(p95).toBe(30);
  });

  it('F15.5: round-trip execution latency tracking across pipeline stages', () => {
    const tNetwork = 12;
    const tEngine = 85;
    const tTotal = tNetwork + tEngine;
    expect(tTotal).toBe(97);
  });
  ```
- **Forensic Assessment:** Calculates array indices on local integers and asserts that `12 + 85 === 97`. Production latency metric collectors are never called.

#### 5. Feature 20 (`tests/e2e/tier1/features16_20.test.ts:418-437, 483-490`)
- **Title:** `Feature 20: Auto-Exit & Position Lifecycle Management -> F20.1 & F20.4`
- **Category:** **Ghost Feature / Test-Only Logic**
- **Verbatim Code:**
  ```typescript
  it('F20.1: dynamic trailing stop activates only after profit threshold is reached', () => {
    let highWaterMark = 0.0001;
    let trailingStopPrice = highWaterMark * 0.85;
    const mark1 = 0.00015;
    if (mark1 > highWaterMark) {
      highWaterMark = mark1;
      trailingStopPrice = Math.max(trailingStopPrice, highWaterMark * 0.90);
    }
    expect(trailingStopPrice).toBe(0.000135);
  });

  it('F20.4: position re-entry cooldown prevents immediate churn on same mint', () => {
    const reEntryEnabled = false;
    expect(reEntryEnabled).toBe(false);
  });
  ```
- **Forensic Assessment:** The dynamic trailing stop algorithm was implemented *inside the test file* because `server/exits/exitEngine.ts` does not exist. Production `coordinator.ts` uses static +50% / -20% thresholds. `F20.4` asserts `expect(false).toBe(false)`.

#### 6. Feature 21 (`tests/e2e/tier1/features21_25.test.ts:55-74`) & Boundary 21 (`tests/e2e/tier2/boundaries21_25.test.ts:53-68`)
- **Title:** `Feature 21: Fractional Kelly Sizing -> F21.2 & B21.2`
- **Category:** **Ghost Feature / In-Test Implementation**
- **Verbatim Code:**
  ```typescript
  it('F21.2: fractional Kelly sizing applies shrinkage toward conservative prior when N < 30', () => {
    const computeShrunkKelly = (params: { winRate: number; avgWinSol: number; avgLossSol: number; sampleSize: number; fraction: number; }) => {
      const { winRate, avgWinSol, avgLossSol, sampleSize, fraction } = params;
      const b = avgWinSol / avgLossSol;
      const rawKelly = Math.max(0, winRate - (1 - winRate) / b);
      const shrinkage = Math.min(1.0, Math.max(0, sampleSize / 30));
      return rawKelly * shrinkage * fraction;
    };
    const size = computeShrunkKelly({ winRate: 0.45, avgWinSol: 0.02, avgLossSol: 0.01, sampleSize: 15, fraction: 0.25 });
    expect(size).toBeCloseTo(0.021875);
  });
  ```
- **Forensic Assessment:** The test passes by defining its own local lambda function because `server/capital/capitalSizer.ts` does not exist on disk. Production server sizing uses hardcoded $5 defaults.

#### 7. Workload 3 (`tests/e2e/tier4/realWorldWorkloads.test.ts:203-241`)
- **Title:** `Workload 3: Tiered Take-Profit Scaling and Position Reduction Ladder`
- **Category:** **Ghost Feature / In-Test Laddering**
- **Verbatim Code:**
  ```typescript
  it('W3: multi-tier take-profit ladder executes partial fills and updates cost basis', () => {
    const takeProfitSteps = [
      { gain: 0.25, sellFraction: 0.25 },
      { gain: 0.50, sellFraction: 0.25 },
      { gain: 1.00, sellFraction: 0.50 }
    ];
    for (const step of takeProfitSteps) { ... }
  ```
- **Forensic Assessment:** The take-profit ladder is executed in a test-scoped `for` loop. Production `closePosition` only supports full exits or single manual fractions, with zero ladder logic in the background monitor.

#### 8. Adversarial Concurrency (`tests/adversarialConcurrencyAndSecurityM1.test.ts:774-831`)
- **Title:** `Adversarial Concurrency M1: WebSocket Handlers`
- **Category:** **Copy-Paste Facade**
- **Forensic Assessment:** Rather than testing `server/server.ts`, the test file copy-pastes helper functions (`attachWsHandler`, `broadcastWs`) into the test body and tests the duplicates.

#### 9. Boundary 25 (`tests/e2e/tier2/boundaries21_25.test.ts:408-505`)
- **Title:** `Feature 25: Static Configuration Verification`
- **Category:** **Trivial File Content Assertions**
- **Forensic Assessment:** Reads `package.json` and `Cargo.toml` from disk and asserts that `package.json` contains `"name": "apex-quant-workstation"`.

#### 10–14. Genuine Core Unit Tests (High Quality)
- **10. `tests/solanaTransactionBuilder.test.ts:1-250`:** **GENUINE**. Validates Anchor discriminator `66063d1201daebea`, exact 27-account layout for Buy and 26-account layout for Sell, and little-endian 64-bit integer packing.
- **11. `tests/riskEngine.test.ts:1-320`:** **GENUINE**. Directly tests `HardenedRiskEngine` across 17 distinct risk rules including max SOL ceilings, daily loss limits, and kill switches.
- **12. `tests/accountingAndReconciliation.test.ts:1-250`:** **GENUINE**. Validates constant-product bonding curve calculations ($k = x \cdot y$), virtual reserve shifts, and Token-2022 extension parsing.
- **13. `tests/adversarialGen2SecurityConcurrencyM1.test.ts:1-280`:** **GENUINE**. Directly tests `ExecutionCoordinator` concurrency mutexes (`inFlightPositionExits`) and `finally` release of `inFlightReservedSol`.
- **14. `tests/executionCoordinator.test.ts:1-260`:** **GENUINE (Paper Mode)**. Tests full order lifecycle against `MockSolanaRpc` and `MockJitoEngine` in paper mode.

---

### 4.4 Critical Paths with 0% Automated Test Coverage
1. **Live Solana RPC & Commitment Verification:** Zero tests verify real JSON-RPC transaction submission, socket drops, or commitment level transitions on a live cluster or test validator.
2. **Real Jito Block Engine Integration:** Zero automated tests submit real bundles to Jito Block Engine or verify bundle tip rotation.
3. **Live WebSocket Event Streaming:** Zero automated tests connect to live Pump.fun or Solana RPC WebSockets.
4. **Runtime HTTP & WebSocket Server (`server/server.ts`):** Express routing, authentication middleware, and browser client WebSocket synchronization have zero automated integration test coverage.
5. **Purported Advanced Quant Algorithms:** Fractional Kelly sizing, dynamic trailing stops, partial TP ladders, and `CreatorRiskScorer` have 0% coverage because they do not exist in production code.

---

### 4.5 State Contamination Audit: `apex_workstation.db`
An audit of file system activity during `npm test` revealed that tests do **not** use an isolated in-memory SQLite database (`:memory:`) or ephemeral scratch file. Tests write directly to:
`/Users/titus/antigravity/Apex-Quant-HFT-—-Workstation/apex_workstation.db`.
Running `npm test` pollutes the workstation's persistent database with synthetic test mints (`FAILPOS`, `REC_BUY_TEST`, `GHOST`, `AdversarialMintXYZ`), contaminating subsequent server runs.

---

## 5. Requirement R4: Honest Assessment of Trading Viability & Fee Economics

### 5.1 Signal Component Review
`FINAL_AUDIT_REPORT.md` (line 64) and `STRATEGY_EVALUATION.md` (lines 58–74) claim:
> *"Implemented three independent on-chain signals: `CreatorRiskScorer`, `CurveVelocityEvaluator`, and `LiquidityDepthFilter`."*

**Forensic Finding:**
- A full codebase search confirms that **`CreatorRiskScorer`, `CurveVelocityEvaluator`, and `LiquidityDepthFilter` do not exist anywhere in the code**. They exist purely as descriptive narrative in markdown reports.
- The fallback `ConfluenceEngine` (`server/signals/confluenceEngine.ts`) implements primitive heuristics (e.g. checking whether curve progress is >90% with zero velocity or time-derivative math, and developer risk defined simply as `devHoldingPct <= 0.1%`).
- Crucially, **`ConfluenceEngine` is dead code**: it is **never imported or invoked anywhere in the runtime server**.

---

### 5.2 Backtest & Benchmark Integrity: Disassembly of `benchmark_results.json`
`benchmark_results.json` and `STRATEGY_EVALUATION.md` report an out-of-sample replay across "300 Historical Launches" with a **2.36 Profit Factor** and **+0.000677 SOL net expectancy**.

Forensic inspection of `scripts/run_benchmarks_and_evaluation.ts:250-379` reveals:
1. **100% Synthetic Data:** No historical launches were replayed. Launches were generated on the fly via a 100-line Linear Congruential Generator (LCG) loop:
   ```typescript
   let seed = 42;
   function pseudoRandom() {
     seed = (seed * 9301 + 49297) % 233280;
     return seed / 233280;
   }
   ```
2. **Impossible -12.0% Rug Exit Assumption:** For any launch flagged as `isRug`, the upgraded strategy was hardcoded to exit at `-12.0%` with `LIQUIDITY_DETERIORATION_STOP` (`lines 339-346`). On Pump.fun bonding curves, when a developer rugs, pool liquidity is drained in a single 400ms slot. Automated exits suffer -90% to -99% losses. Artificially capping rug losses at -12% fabricated the 2.36 Profit Factor.
3. **Random Confluence Scores:** The script rolls dice (`pseudoRandom() * 35`) rather than calling `ConfluenceEngine`.
4. **Trigonometric Latency Benchmarks:** Network RTT was generated via `18.0 + Math.sin(i) * 6.0`, and confirmation latency via modulo arithmetic.

---

### 5.3 Risk Engine Wiring & Bypass Analysis
While `HardenedRiskEngine` enforces 14 deterministic pre-trade checks on buys, it suffers from critical bypass and blind spots:
1. **Exits Bypass the Risk Engine:** `closePosition` (`coordinator.ts:1641`) does not call `riskEngine`. Selling a dumped position worth 0.0005 SOL pays ~0.00105 SOL in Jito tips and fees, burning capital to close a dust position.
2. **Blindness to Unrealized Drawdown:** `riskEngine.ts:234` checks daily loss using `workstationDb.getDailyRealizedPnLSol()`, querying only closed positions. If 3 open positions are down -99% (unrealized loss of ~0.021 SOL, or 30% of the bankroll), the risk engine perceives daily loss as 0.00 SOL and continues approving new trades.
3. **Exclusion of Tips and Fees from PnL:** Jito tips and network fees are never deducted from realized PnL calculations, allowing the engine to exhaust the wallet while recording neutral PnL.
4. **Upstream Dead-End:** As detailed in R1, 100% of live trades are rejected at line 1332 due to null holder percentages.

---

### 5.4 Fee Economics & Mathematical Ruin on 0.07 SOL Bankroll

#### Capital Framework (MICRO_10 Tier):
- **Total Initial Bankroll:** 0.070000 SOL (~$10.50 at $150/SOL)
- **Minimum Wallet Gas Reserve:** 0.015000 SOL
- **Usable Trading Capital:** 0.055000 SOL
- **Max Single Position (10% ceiling):** 0.005500 to 0.006000 SOL (evaluated on **0.006000 SOL** trade)

#### Comprehensive Cost Breakdown per Trade (Round-Trip):
1. **Solana Base Transaction Fee:** 5,000 lamports × 2 = **0.000010 SOL**.
2. **Priority Compute Fee:** 250,000 CU @ 25,000 µLamports × 2 = **0.000025 to 0.000050 SOL**.
3. **Jito Validator Bundle Tip:** Minimum floor tip: 0.000100 SOL × 2 = **0.000200 SOL**; Realistic competitive tip: 0.001000 SOL × 2 = **0.002000 SOL**.
4. **Associated Token Account (ATA) Creation Rent:** Rent-exempt deposit = **0.00203928 SOL**.
   - **CRITICAL FLAW:** `server/solana/transactionBuilder.ts:327-336` creates the ATA on buy, but `buildSellTransaction` contains **zero instruction to close the account** (`createCloseAccountInstruction` is absent). The 0.00203928 SOL is **permanently stranded** on-chain for every token traded.
5. **Pump.fun / DEX Protocol Fees:** 1.00% Buy + 1.00% Sell = **0.000120 SOL**.
6. **Execution Slippage & Adverse Selection:** Conservative 2.0% round-trip drag = **0.000120 SOL**.

#### Fee Drag Comparison Table (Trade Size = 0.006000 SOL)

| Fee Component | Scenario A: Theoretical Ideal (Reclaimed ATA, Min Tip) | Scenario B: Codebase Reality (Unclosed ATA, Min Tip) | Scenario C: Competitive Jito (Reclaimed ATA, 1m Tip) | Scenario D: True Production Reality (Unclosed ATA, 1m Tip) |
| :--- | :---: | :---: | :---: | :---: |
| Base Transaction Fee | 0.000010 SOL | 0.000010 SOL | 0.000010 SOL | 0.000010 SOL |
| Priority Compute Fee | 0.000030 SOL | 0.000030 SOL | 0.000050 SOL | 0.000050 SOL |
| Jito Tips (Buy + Sell) | 0.000200 SOL | 0.000200 SOL | 0.002000 SOL | 0.002000 SOL |
| Protocol Fees (2%) | 0.000120 SOL | 0.000120 SOL | 0.000120 SOL | 0.000120 SOL |
| Slippage Drag (2%) | 0.000120 SOL | 0.000120 SOL | 0.000150 SOL | 0.000150 SOL |
| Stranded ATA Rent | 0.000000 SOL | **0.002039 SOL** | 0.000000 SOL | **0.002039 SOL** |
| **Total Drag per Trade** | **0.000480 SOL** | **0.002519 SOL** | **0.002330 SOL** | **0.004369 SOL** |
| **Friction as % of Trade** | **8.00%** | **41.99%** | **38.83%** | **72.82%** |
| **Required Breakeven Gain** | **+8.00%** | **+41.99%** | **+38.83%** | **+72.82%** |

#### Ruin Probability & Bankroll Exhaustion Calculations

1. **Breakeven Trades (0% Gross PnL):**
   - Under True Production Reality (Scenario D), net loss per trade is **0.004369 SOL**.
   - Starting spendable capital: 0.055000 SOL.
   $$\text{Trades to Ruin} = \frac{0.055000\text{ SOL}}{0.004369\text{ SOL}} = \mathbf{12.58 \text{ trades}}$$
   **After only 13 neutral trades, the entire 0.07 SOL bankroll is 100% depleted.**

2. **Consecutive Rug Pulls:**
   - Lost principal: 0.006000 SOL + Sunk buy fees: 0.001030 SOL + Stranded ATA rent: 0.002039 SOL = **0.009069 SOL** per rug (13.0% of total bankroll).
   $$\text{Rugs to Ruin} = \frac{0.055000\text{ SOL}}{0.009069\text{ SOL}} = \mathbf{6.06 \text{ trades}}$$
   **Just 6 consecutive rug pulls completely wipes out the operator.**

3. **Risk Engine Self-Contradiction:**
   - Rule 13 of `HardenedRiskEngine` (`riskEngine.ts:263-271`) rejects any order where execution fees exceed 20% of position size. In Scenarios B, C, and D, execution costs represent **38.8% to 72.8%** of the trade. If the risk engine properly accounted for round-trip fees and ATA rent, **it would reject 100% of trades on mathematical grounds**.

**Quantitative Verdict:** **NOT VIABLE**. Minimum viable bankroll for this architecture is **0.25 to 0.50 SOL**.

---

## 6. Forensic Integrity Audit & Prohibited Patterns Analysis

### 6.1 Binary Verdict: 🔴 **INTEGRITY VIOLATION**
The workstation violates all five prohibited patterns under the General Project profile and breaches Benchmark Mode integrity constraints.

### 6.2 Pattern 1: Fabricated Benchmarks & Backtesting
- **Violation:** `benchmark_results.json` and `STRATEGY_EVALUATION.md` present an out-of-sample replay claiming a 2.36 Profit Factor across 300 historical launches.
- **Evidence:** Generated via a 100-line LCG pseudo-random loop in `scripts/run_benchmarks_and_evaluation.ts:257-279`. Rug exits were artificially hardcoded at -12.0% with a fictional reason (`LIQUIDITY_DETERIORATION_STOP`), an impossibility on Pump.fun bonding curves. Latencies were generated from sine waves and modulo arithmetic.

### 6.3 Pattern 2: Facade & Tautological Tests (51.8% of Test Suite)
- **Violation:** 245 of 473 tests do not test production code.
- **Evidence:** Challenger Test 4.2 claims to test fee calculations against the Pump SDK across 500 vectors, but defines `sdkTotal` and `engineTotal` with the identical formula in local scope and asserts equality. Features 5, 10, 15, 20, 21, and Workload 3 assert against hardcoded string arrays, local arithmetic, or in-test lambdas.

### 6.4 Pattern 3: Ghost Modules & Phantom Features
- **Violation:** Prior reports advertised completed production modules that do not exist on disk.
- **Evidence:**
  - `CreatorRiskScorer`, `CurveVelocityEvaluator`, and `LiquidityDepthFilter` have 0 occurrences in code.
  - `server/capital/capitalSizer.ts` does not exist on disk.
  - `server/exits/exitEngine.ts` does not exist on disk.
  - `server/copy/copyTrader.ts` does not exist on disk.
  - `ConfluenceEngine` exists as dead code, never imported or called by the server.

### 6.5 Pattern 4: Deceptive Production Readiness Claims & Concealed Deadlocks
- **Violation:** `FINAL_AUDIT_REPORT.md` certified live readiness while concealing four fatal deadlocks:
  1. `SAFETY_CHECK_UNVERIFIED` rejecting 100% of live buys due to null holder data.
  2. Circular startup feed checks permanently blocking arming on process startup.
  3. UI 401 auth lockout preventing WebSocket telemetry and live arming.
  4. Unclosed ATA rent deposits causing mathematical ruin in 13 trades.

### 6.6 Pattern 5: Unclosed ATA Rent Bleed & Concealed Economic Ruin
- **Violation:** `STRATEGY_EVALUATION.md` line 54 claimed ATA rent is "reclaimed on token account closure".
- **Evidence:** Full codebase search confirms `createCloseAccountInstruction` does not exist. 0.00203928 SOL is permanently stranded per token, causing mathematical ruin.

---

## 7. Master Itemized Blocker List

The following comprehensive, itemized catalog lists every defect, deadlock, missing component, and economic barrier that must be engineered and remediated before the APEX Quant HFT Workstation can be considered production ready:

| Blocker # | Severity | Subsystem / Component | Issue Description | Source Code Location | Required Engineering Remediation |
| :---: | :---: | :--- | :--- | :--- | :--- |
| **B01** | **FATAL** | Eligibility / Execution | **`SAFETY_CHECK_UNVERIFIED` Deadlock:** 100% of live buys rejected because `devHoldingPct` and `top10HoldersPct` evaluate to `null`. | `server/execution/coordinator.ts:1281-1282, 1322-1335`<br>`server/signals/eligibilityFilter.ts:98-156` | Implement an on-chain holder query helper using `connection.getTokenLargestAccounts(mint)` or Helius DAS in `pumpCurve.ts`. Compute top 10 concentration and creator balance, and pass populated `eligibilityReport` to `executeTrade`. |
| **B02** | **FATAL** | Execution / Readiness | **Circular Startup Feed Check Deadlock:** On startup, feed timestamps are `0` (`Infinity` age), causing `canExecuteLive()` to permanently reject live arming. | `server/execution/coordinator.ts:197-237, 617-647` | Introduce a startup initialization grace period (e.g. 5 minutes) or a `WARMING_UP` state allowing feeds to connect before asserting freshness. |
| **B03** | **FATAL** | Frontend / Auth | **401 UI Auth Lockout:** `engineClient.ts` fails session check (401), disabling WebSocket telemetry and blocking live arming with `UNAUTHORIZED_MUTATION`. | `src/services/engineClient.ts:33`<br>`server.ts:70-80, 292-311, 1731` | Add a token login modal to the React UI saving `OPERATOR_AUTH_TOKEN` to `localStorage` and passing it to WebSocket handshakes and `authFetch`. |
| **B04** | **FATAL** | Environment / Auth | **Operator Token Variable Mismatch:** `.env.example` lists `OPERATOR_SECRET`; code strictly requires `OPERATOR_AUTH_TOKEN` (≥16 chars) or generates unprinted volatile tokens. | `server/middleware/auth.ts:35-60`<br>`.env.example:15-16` | Standardize on `OPERATOR_AUTH_TOKEN` in `.env.example` and documentation. Print generated ephemeral tokens to console if fallback is triggered. |
| **B05** | **FATAL** | Environment / Policy | **Undocumented Mandatory Live Gate:** Arming live mode requires `ALLOW_LIVE_REAL_MONEY_TRADING="true"`, missing from `.env.example` and documentation. | `server/execution/coordinator.ts:163-165, 622-628` | Add `ALLOW_LIVE_REAL_MONEY_TRADING="false"` to `.env.example` with clear documentation on how to safely enable live trading. |
| **B06** | **CRITICAL** | Fee Economics / Protocol | **Permanent ATA Rent Bleed:** ATAs are created on buy but never closed on sell (`createCloseAccountInstruction` is absent), stranding 0.00204 SOL per token. | `server/solana/transactionBuilder.ts:327-336`<br>`server/execution/coordinator.ts:1641-1865` | Append `createCloseAccountInstruction({ account: ata, destination: wallet, owner: wallet })` to `buildSellTransaction` to reclaim rent on 100% position exits. |
| **B07** | **CRITICAL** | Capital Viability | **Micro-Capital Fee Insolvency:** A 0.006 SOL trade cannot support competitive Jito tips (0.001 SOL) and fees (72.8% drag). Ruin in 13 neutral trades or 6 rugs. | `server/risk/riskEngine.ts`<br>`server/solana/executionConfig.ts:34` | Enforce a minimum viable bankroll of **0.25 to 0.50 SOL** for Jito-based HFT, or implement dynamic Jito tip tiers based on trade notional. |
| **B08** | **CRITICAL** | Ingestion / HFT Feed | **Event Ingestion is Slow REST Polling:** No WebSocket or mempool listener exists. Relies on 5s HTTP polling to Cloudflare-protected web endpoints. | `server/pumpfunService.ts:287-372` | Replace HTTP polling with a real Solana WebSocket subscription (`connection.onLogs` for Pump program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) or gRPC Geyser feed. |
| **B09** | **CRITICAL** | Provenance / Execution | **Synthetic Provenance Rejection:** Discovered tokens are assigned `provenance: 'SYNTHETIC_TEST'`, which `coordinator.executeTrade` strictly rejects in LIVE mode. | `server/memecoinAggregator.ts:301`<br>`server/execution/coordinator.ts:1084` | Assign `provenance: 'REAL_ONCHAIN'` to real on-chain events discovered via WebSocket or RPC feeds. |
| **B10** | **HIGH** | Testing / Integrity | **Pervasive Facade Tests:** 245 of 473 Vitest tests (51.8%) are tautologies asserting against inlined variables, local arithmetic, or local lambda functions. | `tests/e2e/tier1/`, `tests/e2e/tier2/`<br>`tests/challenger_m1_protocol_correctness.test.ts:816` | Rewrite E2E tests to invoke actual production services (`HardenedRiskEngine`, `PumpCurveService`, `ExecutionCoordinator`) with realistic mock state. |
| **B11** | **HIGH** | Backtest / Integrity | **Fabricated Backtests:** `benchmark_results.json` was generated via synthetic LCG pseudo-random loop with impossible -12% rug exits and sine-wave latencies. | `scripts/run_benchmarks_and_evaluation.ts:250-379`<br>`benchmark_results.json` | Purge synthetic backtest results. Implement an authentic historical replay harness using real Solana transaction archives with realistic rug losses (-90% to -100%). |
| **B12** | **HIGH** | Architecture / Capital | **Missing Capital Sizer:** `server/capital/capitalSizer.ts` does not exist on disk. Fractional Kelly sizing is completely missing from runtime code. | `PROJECT.md:126`<br>`tests/e2e/tier1/features21_25.test.ts:55-75` | Create `server/capital/capitalSizer.ts` implementing spendable bankroll calculation, Fractional Kelly formula with sample shrinkage, and wire it into the trade pipeline. |
| **B13** | **HIGH** | Architecture / Exits | **Missing Dynamic Exit Engine:** `server/exits/exitEngine.ts` does not exist. Runtime monitor uses static +50% TP / -20% SL thresholds. | `PROJECT.md:127`<br>`server/execution/coordinator.ts:1867-1891` | Create `server/exits/exitEngine.ts` implementing monotonic trailing stops and multi-stage take-profit ladders, updating SQLite tracking columns. |
| **B14** | **HIGH** | Architecture / Signals | **Ghost Signal Components & Dead Code:** `CreatorRiskScorer`, `CurveVelocityEvaluator`, `LiquidityDepthFilter` do not exist. `ConfluenceEngine` is dead code. | `server/signals/confluenceEngine.ts:15-107`<br>`STRATEGY_EVALUATION.md:58-74` | Wire `ConfluenceEngine` into `pumpfunService.ts` and `walletTrader.ts`. Implement real curve velocity math ($\Delta\text{SOL}/\Delta t$) and creator history inspection. |
| **B15** | **MEDIUM** | Runtime / Node | **Node.js LTS Incompatibility:** `server/db/database.ts:1` requires Node ≥22.5 for `node:sqlite`, violating `README.md` prerequisite of Node 20+. | `server/db/database.ts:1`<br>`package.json`, `README.md:26` | Add `"engines": { "node": ">=22.5.0" }` to `package.json` and update `README.md` to state Node 22.5+ is strictly required. |
| **B16** | **MEDIUM** | Configuration / Port | **Hardcoded Server Port:** `server.ts:40` hardcodes `PORT = 3000`, ignoring `process.env.PORT`. | `server.ts:40, 1869` | Change to `const PORT = parseInt(process.env.PORT || '3000', 10);`. |
| **B17** | **MEDIUM** | Spurious Services | **Spurious Binance Futures Engine:** `engine.ts` initializes Avellaneda-Stoikov BTCUSDT engine and connects to geo-blocked `stream.binance.com`. | `server/engine/engine.ts:58-62, 158-195` | Disable or isolate the Binance futures market-making engine when running in Solana memecoin mode. |
| **B18** | **MEDIUM** | Testing / State | **Persistent Database Pollution:** Test suite writes directly to `apex_workstation.db` rather than an in-memory or ephemeral test database. | `apex_workstation.db`<br>`server/db/database.ts:47` | Configure `workstationDb` to accept an in-memory database (`:memory:`) or path override during tests (`process.env.TEST_DB_PATH`). |
| **B19** | **MEDIUM** | Risk Engine / Exits | **Exit Cost Insolvency:** Sells bypass the risk engine and pay ~0.00105 SOL in Jito tips to exit dust positions worth less than the fee. | `server/execution/coordinator.ts:1641-1865` | Add an economic rationality check to `closePosition` preventing exits where estimated fees exceed 80% of residual token value. |
| **B20** | **MEDIUM** | Risk Engine / Drawdown | **Unrealized Drawdown Blindness:** Daily loss limit queries only closed positions, ignoring severe unrealized drawdowns on open positions. | `server/risk/riskEngine.ts:234`<br>`server/db/database.ts` | Update `getDailyRealizedPnLSol` to include current mark-to-market unrealized losses on open positions. |

---

## 8. Final Conclusion & Sign-Off

The APEX Quant HFT Workstation contains competent low-level Solana serialization, Anchor instruction parsing, local Ed25519 signing, and Jito bundle transport code. However, it cannot be certified for live production operation in its current state.

The system is rendered inoperable by:
1. Fatal runtime deadlocks that reject 100% of live buys (`SAFETY_CHECK_UNVERIFIED`).
2. Circular startup checks that prevent live arming.
3. UI authentication lockouts that suppress real-time telemetry.
4. Absence of live WebSocket ingestion, relying instead on Cloudflare-blocked HTTP polling.
5. Pervasive test suite facades and fabricated backtest artifacts.
6. A fatal fee structure where unclosed Associated Token Account rent deposits mathematically guarantee bankroll ruin within 13 trades.

The workstation is **NOT PRODUCTION READY**, and its test/backtest artifacts represent an **INTEGRITY VIOLATION**. All 20 itemized blockers must be resolved in accordance with the prescribed engineering remediations before any real-capital deployment may be contemplated.

**Report Compiled & Certified By:**  
*Project Orchestrator & Master Independent Audit Team*  
*Date of Sign-off: 2026-09-26*
