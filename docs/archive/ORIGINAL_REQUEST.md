# Original User Request

## 2026-09-15T19:35:08Z

Perform a safety-gated profitability and low-latency upgrade of the existing APEX Quant HFT Workstation, a full-stack Solana memecoin trading engine targeting current Pump.fun bonding-curve launches and migrated PumpSwap markets.

The system is written primarily in TypeScript with:

- Node.js backend
- Vite / React frontend
- SQLite WAL-mode persistence
- Solana/Jito execution
- Pump.fun SDK integration
- PumpSwap SDK integration
- central ExecutionCoordinator
- risk engine
- paper/replay/live execution modes

The intended deployment tier is:

- MICRO_10
- Total bankroll: ~0.07 SOL
- Hard per-trade capital-at-risk ceiling: ≤ 10% of current bankroll
- Real-money deployment: ONLY after all safety/correctness gates pass

The objective is NOT merely to add more trading features.

The objective is to create a system that is:

- protocol-correct
- fail-closed
- low latency
- risk controlled
- measurably better at trade selection
- crash recoverable
- economically rational for a tiny bankroll

Working directory: /Users/titus/antigravity/Apex-Quant-HFT-—-Workstation
Integrity mode: benchmark

---

## ABSOLUTE PRIORITY RULE

PHASE 0 MUST PASS BEFORE PROFITABILITY FEATURES ARE CONSIDERED COMPLETE

Previous independent audits found that the project architecture is now generally strong, but several execution-critical issues may still remain.

Do NOT optimize strategy profitability, add aggressive entry logic, or enable autonomous LIVE trading before verifying and repairing Phase 0.

Do NOT assume that FINAL_AUDIT_REPORT.md, KNOWN_RISKS.md, SECOND_PASS_REBUILD_REPORT.md, or AUDIT_EVIDENCE.md are correct merely because they exist.

Treat source code and current official protocol behavior as authoritative.

If documentation disagrees with implementation: implementation + current official protocol wins. Update documentation afterward.

---

## PHASE 0 — LIVE CORRECTNESS AND SAFETY GATE

Before R1-R7 may be considered production-ready, independently verify and repair ALL of the following.

### R0.1 — STRICT EXECUTION MODE PROPAGATION

The canonical execution path must explicitly propagate `executionMode: 'PAPER' | 'LIVE'` through all protocol-critical operations.

Do NOT rely on optional booleans such as `isLiveMode = false` because omitted arguments can silently enable fallback behavior.

LIVE Pump execution must fail closed when:
- official SDK state decode fails
- fee configuration cannot be verified
- official quote calculation fails
- venue cannot be determined
- required account cannot be resolved

PAPER may use explicitly documented fallback behavior where useful. LIVE may not.

This applies to: BUY quoting, SELL quoting, market state, mark prices, venue resolution, PumpSwap state, PumpSwap quoting.

### R0.2 — CURRENT PUMP.FUN V2 CORRECTNESS

Use the current official Pump SDK and current official protocol documentation.

Verify: creator, quote mint, base token program, quote token program, Mayhem state, fee recipient, reserved fee recipient, buyback fee recipient, FeeConfig, Global, BondingCurve, current dynamic fee schedule.

Fee-recipient selection must distinguish normal, reserved/Mayhem, and buyback fee recipients. They are not interchangeable. Do not silently substitute one for another. LIVE must reject if authoritative accounts cannot be resolved.

Use current official quote logic where possible. If custom quote math remains for latency reasons, cross-check it against the official SDK on realistic fixtures and require exact integer-semantic agreement.

Manual binary account-layout decoding must NOT silently replace official SDK decoding in LIVE.

### R0.3 — CURRENT PUMPSWAP CORRECTNESS

Migrated positions must remain executable.

Implement/verify one authoritative PumpSwap state model used by: marking, quoting, slippage, risk, and transaction construction.

Pricing must use: `effective_quote_reserves = actual_quote_reserves + virtual_quote_reserves`. Do NOT ignore `virtual_quote_reserves`.

Do NOT use a hard-coded PumpSwap fee such as 25 bps. Use the current dynamic Pump/PumpSwap fee infrastructure through the current official SDK.

Prefer current official SDK quoting functions (current equivalents of `sellBaseInput`, `buyBaseInput`, `sellQuoteInput`, `buyQuoteInput`) and the documented instruction builder for the exact pinned SDK version.

Declare `@pump-fun/pump-swap-sdk` as a direct dependency if imported directly. Pin exact protocol SDK versions that are actually validated. Do not rely on transitive dependency behavior.

Until non-SOL accounting is implemented, explicitly restrict LIVE PumpSwap trading to the supported SOL/WSOL quote path. Unsupported quote mint → LIVE → REJECT.

### R0.4 — MIGRATION SAFETY

A position must transition explicitly:

PUMP_BONDING_CURVE → curve completes → MIGRATION DETECTED → canonical PumpSwap pool resolved → PUMPSWAP

Persist: venue, pool address, migration timestamp, mark source.

If the canonical migrated pool cannot be authoritatively resolved: venue = UNKNOWN, normal autonomous exit = blocked, operator diagnostic = explicit. Do not guess a route.

### R0.5 — JITO EXECUTION CORRECTNESS

Use current official Jito behavior. Maintain distinct: transaction signature, bundle ID, bundle lifecycle, on-chain transaction state.

Support: sendBundle, getInflightBundleStatuses, getBundleStatuses, Solana signature confirmation, on-chain reconciliation.

A bundle ID only proves receipt by the Block Engine. It does NOT prove landing.

If Jito is the configured LIVE transport: Jito health != HEALTHY → LIVE ARM DENIED. NOT_CONFIGURED must NOT count as healthy.

Create one authoritative execution configuration controlling: Jito endpoint, default tip, maximum tip, dynamic-tip policy, RPC fallback, priority fee. No decorative environment variables.

### R0.6 — SAFE JITO RETRY / RPC FALLBACK

Bundle retry must be: idempotent, bounded, blockhash aware, duplicate-fill safe.

Before retrying after a timeout: check bundle status, check transaction status, check wallet/token balance, check existing execution record. Do not assume timeout means failure.

Direct RPC fallback must not create a situation where Jito copy lands + RPC copy lands = double position. Use one logical execution intent/order ID.

### R0.7 — AUTHORITATIVE TOKEN ELIGIBILITY

ExecutionCoordinator itself must enforce token eligibility for LIVE. LIVE must require a fresh authoritative eligibility result matching the exact mint. Do not rely only on upstream scanners.

Critical token-safety fields must support: PASS, FAIL, UNKNOWN. Unknown is NOT equivalent to safe.

Examples:
- top holder concentration unknown → UNKNOWN
- developer holding unknown → UNKNOWN
- mint authority unknown → UNKNOWN
- freeze authority unknown → UNKNOWN

For LIVE: critical UNKNOWN → REJECT. Do not use `unknownValue ?? 0` when zero represents the safest possible result.

### R0.8 — TOKEN-2022 POLICY

Support Token-2022 only to the extent actually verified. Inspect relevant extensions that can materially affect transfers.

If an extension is unsupported or its behavior cannot be safely modeled: LIVE → UNSUPPORTED_TOKEN_EXTENSION → REJECT.

ATA support alone does not constitute full Token-2022 safety.

### R0.9 — MANDATORY SIGNAL PROVENANCE

Replace optional concepts such as `isSynthetic?: boolean` with a mandatory provenance enum. For example:

```typescript
type SignalProvenance =
    | 'REAL_ONCHAIN'
    | 'REAL_SOCIAL'
    | 'COPY_TRADE'
    | 'MANUAL_OPERATOR'
    | 'PAPER_REPLAY'
    | 'SYNTHETIC_TEST';
```

LIVE should allow only explicitly approved real provenance. Synthetic/demo data must never become LIVE simply because a caller forgot a boolean.

### R0.10 — SYNTHETIC DATA ISOLATION

Synthetic social signals, CEX fills, PnL, latency, market pools, holder metrics, and wallet activity must be isolated from production metrics and LIVE eligibility.

Synthetic generators must require explicit `DEMO_MODE=true` or equivalent. They must default OFF.

### R0.11 — AUTHENTICATED WEBSOCKET TELEMETRY

A WebSocket client must authenticate BEFORE receiving: wallet state, positions, WAL, strategy state, private diagnostics, execution telemetry.

Desired flow: CONNECT → AUTH_REQUIRED → authenticate → AUTHENTICATED → private snapshots.

Remove bearer credentials from URL query strings. Use exact configured origin allowlists rather than broad cloud-provider wildcards.

### R0.12 — REAL HEALTH MODEL

Do not treat `Solana getSlot()` success as proof that the Pump strategy feed is healthy.

Track separately: RPC health, Pump feed health, mark feed health, Jito health, database health, signer health.

LIVE readiness must require the actual critical strategy feed to be fresh. Create one explicit `LiveReadiness` object and expose its exact prerequisites.

### R0.13 — CRASH RECOVERY

Verify restart recovery for: interrupted BUY, full SELL, partial SELL, PumpSwap SELL, Jito pending transaction, landed but unreconciled transaction.

A partial SELL that lands immediately before a crash must restore: remaining token quantity, remaining cost basis, realized PnL, PARTIALLY_CLOSED state.

A transaction must not be marked RECONCILED unless its accounting consequence has actually been reconstructed.

### R0.14 — REAL-MONEY PROHIBITION DURING DEVELOPMENT

Do NOT automatically submit a funded mainnet transaction during implementation or CI.

Allowed: read-only mainnet state, recorded mainnet replay, transaction construction, transaction signing in controlled environment, simulateTransaction, mock Jito, dry-run transport validation.

A real-capital test requires explicit user approval AFTER all Phase 0 gates pass.

---

## AFTER PHASE 0 PASSES — PROFITABILITY / PERFORMANCE UPGRADE

Only after Phase 0 is green should the team proceed to R1-R7.

### R1 — SNIPE SPEED

Goal: Minimize the controllable latency between new Pump event received → eligibility → signal → risk → quote → transaction construction → signature → Jito HTTP dispatch.

Target: p95 controllable event-receipt → submission-dispatch latency ≤ 100ms under the benchmark environment.

Do NOT confuse this with bundle landing latency, network propagation, validator processing, or transaction confirmation. Report those separately.

**R1.1 — Profile Before Optimizing**

Instrument timestamps for: event receive, decode, eligibility, signal generation, risk, quote, transaction build, sign, serialization, submission start, submission response, land, confirm, reconcile.

Report: p50, p90, p95, p99, max. Do not publish one flattering minimum.

**R1.2 — Optimization**

Optimize only after measurement. Candidates: cache immutable PDAs, cache static program accounts, cache current blockhash safely, preconstruct reusable instruction templates, avoid repeated JSON serialization, reduce synchronous DB work in hot path, parallelize independent safety/state fetches, use typed compact internal structures, avoid unnecessary frontend involvement.

Correctness and risk checks may NOT be bypassed to achieve the latency target.

**R1 Acceptance:** Use at least 100 deterministic/replayed realistic events for the benchmark where possible. Report both controllable internal latency and external submission RTT. Do not claim "sub-100ms HFT" based on CPU-only calculations.

### R2 — SIGNAL QUALITY

Goal: Improve expected net outcome by rejecting more rugs/dumps and identifying stronger momentum.

Implement at least THREE additional independent on-chain signal components. Good candidates include: creator history/creator risk, bonding-curve velocity, buy/sell imbalance, unique buyer acceleration, liquidity depth, holder concentration, creator/developer exposure, wallet clustering, curve completion velocity, trade-size distribution, repeat-buyer quality, early sell pressure.

Every signal must have: source, timestamp, normalized score, rationale, unit tests. No fabricated inputs.

**R2.1 — Do NOT Optimize to Win Rate Alone**

Do not use win rate >= 40% as the primary gate because it can be gamed and does not prove profitability.

Instead report: net expectancy after modeled fees, profit factor, median trade return, win rate, max drawdown, rug-loss rate, MAE, MFE, fee burden.

**R2.2 — Out-of-Sample Validation**

Do not tune and test on the same launches. Use training/calibration sample → frozen strategy → out-of-sample replay. Prefer at least 200 historical launches. No look-ahead, no future metadata leakage, no survivorship-only token set.

**R2 Acceptance:** The upgraded strategy should produce positive modeled net expectancy out-of-sample AND improve at least two of: profit factor, max drawdown, rug-loss rate, median return — after modeled network fees, priority fees, Jito tips, protocol fees, slippage, and failed transactions. If the strategy has no demonstrated edge, report that.

### R3 — DYNAMIC EXIT OPTIMIZATION

Implement persistent: dynamic trailing stop, partial take-profit ladder, maximum hold time, liquidity deterioration exit, momentum reversal exit, optional re-entry.

**R3.1 — Trailing Stop:** Tightens monotonically as unrealized profit increases. Persist high-water mark, current trailing level, last mark, exit stage in SQLite.

**R3.2 — Partial Take Profit:** Support configurable ladders. For MICRO_10, partial sells must be fee-aware — do not create dust-size exits whose fees dominate expected proceeds.

**R3.3 — Re-entry:** Defaults OFF. Requires renewed safety/market confirmation. Every re-entry must go through ExecutionCoordinator → Eligibility → RiskEngine → CapitalSizer. No bypass.

**R3 Acceptance:** Test trailing stop only tightens, partial TP accounting, multiple TP rungs, restart preserves exit state, partial fill preserves remaining ladder, migrated PumpSwap position retains exit state, re-entry cooldown, re-entry disabled by default.

### R4 — JITO / MEV OPTIMIZATION

Goal: Improve landing probability without allowing execution costs to destroy MICRO_10 economics.

**R4.1 — Dynamic Tip Policy:** Use live Jito tip information. The exact tip used must flow through quote, risk, transaction, journal, and accounting.

**R4.2 — Bounded Tip Escalation:** Retries may escalate tips only within configured maximum, fee-percentage limit, and remaining bankroll reserve. No unlimited escalation.

**R4.3 — Leader Slot Awareness:** If supported by current documented Jito APIs, incorporate leader-slot awareness. Measure whether it materially improves landing rate. If not, leave it optional.

**R4.4 — Direct RPC Fallback:** Implement only if idempotency is guaranteed. Required: same execution intent, dedupe, bundle/status check, signature check, wallet state check. No possible double fill.

**R4 Acceptance:** Report submission attempts, landed bundles, failed bundles, timeout rate, median tip, p95 tip, tip as % of position, fallback use, duplicate fills = 0.

### R5 — COPY TRADING

Goal: Monitor explicitly configured public Solana wallets and transform their confirmed buys into candidate signals. Do NOT blindly mirror trades.

Pipeline: tracked wallet transaction → decode → identify Pump/PumpSwap buy → mint candidate → mandatory provenance = COPY_TRADE → fresh token eligibility → signal/risk → capital sizing → ExecutionCoordinator.

The copied wallet NEVER determines APEX's position size, slippage, risk limit, or fee budget. APEX does.

**R5.1 — Configuration:** Tracked wallets configurable through config file and/or authenticated UI. Persist: wallet public key, enabled, label, max copy latency, cooldown.

**R5.2 — Deduplication:** One tracked-wallet transaction must produce at most one APEX trade intent. Multiple tracked wallets buying the same mint simultaneously must still respect duplicate mint protection, aggregate exposure, and cooldowns.

**R5 Acceptance:** Tests: tracked buy detected, untracked wallet ignored, sell ignored or separately classified, Pump buy recognized, PumpSwap buy recognized, duplicate event deduped, candidate enters ExecutionCoordinator, risk rejection respected.

### R6 — SOCIAL SIGNALS

Goal: Implement one real optional social source. Prefer the source with the cleanest available credentials and API access. Must be disabled by default, failure isolated, rate-limit aware.

**R6.1 — Contract Address First:** A social ticker alone is not authoritative token identity. Ticker-only messages may become unresolved candidates but must NOT autonomously execute until resolved to an authoritative mint.

**R6.2 — Pipeline:** social message → extract mint/candidate → provenance = REAL_SOCIAL → resolve token → eligibility → signal → risk → ExecutionCoordinator. No direct social-to-buy shortcut.

**R6 Acceptance:** Tests: valid contract extracted, invalid address ignored, ticker-only does not auto-trade, duplicate callout deduped, disabled integration affects nothing, API failure does not break on-chain trading.

### R7 — MICRO_10 CAPITAL EFFICIENCY

The bankroll is approximately 0.07 SOL. Do not hard-code a USD equivalent because SOL price changes.

**R7.1 — Define Spendable Bankroll:** `spendable bankroll = wallet SOL - required network/Jito reserve - reserved pending capital`. Sizing must use spendable bankroll, not total wallet balance.

**R7.2 — Fractional Kelly Only:** Use a conservative fractional Kelly model (configurable 0.10–0.25 Kelly) with statistical safeguards. Kelly estimate must use historical closed trades stored in SQLite. Inputs: estimated win probability, average win, average loss, payoff ratio, sample size.

**R7.3 — Sample Confidence:** Require a configurable minimum sample (e.g. >= 30 closed comparable trades) and apply shrinkage toward a conservative prior. If statistical confidence is insufficient, fallback to fixed conservative sizing.

**R7.4 — Hard Position Cap:** Single-trade allocation <= 10% of current spendable bankroll. For a 0.07 SOL total bankroll, absolute allocation must never exceed approximately 0.007 SOL before accounting for reserved capital. The hard 10% cap must be enforced inside RiskEngine, not merely by the strategy.

**R7.5 — Fee Economics:** Reject a trade if expected execution costs (network fee + priority fee + Jito tip + protocol/creator fees + slippage) consume an unreasonable portion of position size or expected edge. A technically valid snipe is not economically valid if fees dominate a tiny position.

**R7.6 — Drawdown Recovery:** Implement NORMAL → RECOVERY → HALTED capital states. Exact thresholds must be configurable and conservative.

**R7 Acceptance:** Tests: Kelly math, fractional Kelly, insufficient-sample fallback, 10% hard cap, fee reserve, reserved pending capital, drawdown recovery, halt state, restart restores bankroll state.

---

## BUILD / TYPE / TEST GATE

After all changes, run from a clean checkout:

```bash
rm -rf node_modules dist
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Rust:
```bash
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo build --release
```

Do not claim PASS unless each command actually ran successfully.

---

## DEPENDENCY RULES

Protocol-critical libraries should be direct, pinned dependencies after validation. Examples: `@pump-fun/pump-sdk`, `@pump-fun/pump-swap-sdk`, `@solana/web3.js`, `@solana/spl-token`.

Do not directly import undeclared transitive dependencies. Do not casually upgrade protocol SDK major/minor versions without integration tests, transaction simulations, and quote comparison.

---

## CLEAN RELEASE PACKAGE

Generated review/release ZIP must exclude: `.env`, operator session files, signer files, private keys, SQLite runtime DB, WAL, `node_modules`, `dist`, `coverage`, temporary logs. Create a repeatable packaging command.

---

## TRUTHFUL TELEMETRY

Remove remaining fake production-like telemetry. Do not transform measured Internet RTT into hypothetical co-location RTT. Do not generate random CEX PnL and label it real.

Keep simulations if useful, but label them SIMULATED and isolate them from: LIVE PnL, wallet PnL, execution results, live latency.

---

## TEAM EXECUTION ORDER

**Team A — Protocol / Execution Correctness**
Own: Pump V2, PumpSwap, Jito, strict LIVE propagation, transaction simulations. Must complete Phase 0 protocol blockers first.

**Team B — Security / Reliability**
Own: authentication, WebSocket authorization, provenance, eligibility, health/readiness, crash recovery.

**Team C — Strategy / Signal Research**
Own: new on-chain signals, historical replay, baseline comparison, exit optimization. May begin research in parallel, but strategy code is NOT production-approved until Teams A/B pass Phase 0.

**Team D — Execution Performance**
Own: profiling, hot-path measurement, caching, parallelization, latency optimization. Do not remove safety checks to meet performance targets.

**Team E — Alpha Inputs**
Own: copy trading, social integration. Everything produces candidates only. No independent trading engine.

**Team F — Capital / Accounting / QA**
Own: fractional Kelly, MICRO_10 risk, fee economics, drawdown recovery, PnL correctness, test suite, CI, clean build, release packaging.

**Cross-Team Rule:** There must still be ONE canonical execution path: Candidate → Authoritative Eligibility → Signal → Capital Sizing → RiskEngine → ExecutionCoordinator → PAPER or LIVE → Reconciliation → Persistent Position. No subteam may create its own execution shortcut.

---

## FINAL DELIVERABLES

Produce:
- `FINAL_AUDIT_REPORT.md`
- `AUDIT_EVIDENCE.md`
- `KNOWN_RISKS.md`
- `PERFORMANCE_REPORT.md`
- `STRATEGY_EVALUATION.md`

`PERFORMANCE_REPORT.md` must contain: per-stage latency, p50/p90/p95/p99, benchmark environment, sample count, network vs local boundaries.

`STRATEGY_EVALUATION.md` must contain: baseline strategy, new strategy, training sample, out-of-sample sample, fees/slippage assumptions, expectancy, profit factor, win rate, max drawdown, rug-loss rate, MAE, MFE, limitations.

---

## FINAL STATUS RULE

At completion, use exactly one status:
- NOT READY
- PAPER READY
- LIVE ARCHITECTURE READY — CONTROLLED VALIDATION REQUIRED
- CONTROLLED LIVE READY

Do NOT choose the highest status unless supported by actual test evidence.

---

## FINAL RESPONSE FORMAT

```
FINAL STATUS:
PHASE 0: PASS / FAIL
CRITICAL LIVE BLOCKERS: <number>
PUMP V2: PASS / FAIL
PUMPSWAP: PASS / FAIL
JITO: PASS / FAIL
TOKEN ELIGIBILITY: PASS / FAIL
AUTH / WEBSOCKET: PASS / FAIL
CRASH RECOVERY: PASS / FAIL
SNIPE LATENCY P50: <value>
SNIPE LATENCY P95: <value>
SNIPE LATENCY P99: <value>
OUT-OF-SAMPLE EXPECTANCY: <value>
PROFIT FACTOR: <value>
MAX DRAWDOWN: <value>
COPY TRADING: PASS / FAIL
SOCIAL SIGNAL: PASS / FAIL
FRACTIONAL KELLY: PASS / FAIL
MICRO_10 10% HARD CAP: PASS / FAIL
TYPECHECK: PASS / FAIL
ESLINT: PASS / FAIL
JS TESTS: PASS / FAIL + count
PRODUCTION BUILD: PASS / FAIL
RUST FMT: PASS / FAIL
RUST CLIPPY: PASS / FAIL
RUST TESTS: PASS / FAIL + count
RUST RELEASE BUILD: PASS / FAIL
REAL-MONEY TEST EXECUTED: NO unless explicitly approved by user
REMAINING LIVE BLOCKERS: <list>
```

Then give a concise explanation of: what changed, what improved, what failed, what remains, what should be done next.

---

## CORE PRINCIPLE

The order is:

CORRECTNESS → SECURITY → RECONCILIATION → PROTOCOL VALIDATION → PERFORMANCE → SIGNAL QUALITY → FEATURE EXPANSION → CONTROLLED LIVE VALIDATION

That ordering aligns with the actual goal: build a fast and potentially profitable memecoin trading system without allowing vibe-coded protocol mistakes, fake data, fee errors, stale state, or duplicate execution to destroy the 0.07 SOL bankroll.

## 2026-09-26T02:19:00Z

Perform a critical, independent production-readiness review of the APEX Quant HFT Workstation, a full-stack Solana memecoin trading engine. The codebase has already undergone internal development and self-reported testing (473 Vitest tests, Rust gates, benchmark suites). Your job is to independently verify whether those claims hold up, and more importantly, whether a real operator could take this system, import a funded wallet keypair, and begin profitable live trading on Pump.fun and PumpSwap — or whether critical gaps, facade tests, dead code paths, or unfinished integrations would prevent that.

Working directory: /Users/titus/antigravity/Apex-Quant-HFT-—-Workstation
Integrity mode: benchmark

## Reference Material

The original specification is at `ORIGINAL_REQUEST.md` in the working directory. Key existing reports to audit (do NOT trust at face value):
- `FINAL_AUDIT_REPORT.md`
- `AUDIT_EVIDENCE.md`
- `KNOWN_RISKS.md`
- `PERFORMANCE_REPORT.md`
- `STRATEGY_EVALUATION.md`
- `benchmark_results.json`

## Requirements

### R1. Independent Code Path Verification

Trace the actual execution path from system startup through a complete trade lifecycle: event ingestion → token eligibility → signal evaluation → risk check → capital sizing → quote → transaction build → sign → submit → confirm → reconcile → position management → exit. For each stage, determine whether the code is (a) real and functional, (b) stubbed/mocked but presented as real, or (c) missing entirely. Identify any stage where LIVE mode would hit an unhandled error, missing implementation, or silently fall back to PAPER behavior.

### R2. Plug-and-Play Readiness Assessment

Evaluate whether a real operator could realistically go from a clean checkout to live trading by following these steps only:
1. `npm ci`
2. Configure `.env` with RPC endpoint, Jito endpoint, and operator token
3. `npm run signer:import -- <keypair.json>` (funded with ~0.07 SOL)
4. `npm run build && npm start`
5. Arm live mode through the UI or API

Identify every point where this would fail, crash, require undocumented manual steps, or silently do nothing. Specifically check: Does the server actually start and serve the UI? Do WebSocket connections work? Does the Pump.fun event feed connect and receive real data? Does the Jito transport actually submit bundles? Does SQLite persistence actually work across restarts?

### R3. Test Suite Integrity Audit

Run the existing test suite (`npm test`) and independently evaluate its quality:
- Are tests exercising real code paths or just asserting against their own mocks?
- Do tests cover the actual LIVE execution path or only PAPER mode?
- Are there critical paths with zero test coverage?
- Would any test pass even if the underlying feature were completely broken?
- Run `npm run typecheck` and `npm run lint` and verify they pass clean.

### R4. Honest Assessment of Trading Viability

Based on the code review, assess whether this system has a realistic chance of being profitable:
- Are the signal components (CreatorRiskScorer, CurveVelocityEvaluator, LiquidityDepthFilter) real implementations with meaningful logic, or skeleton placeholders?
- Does the out-of-sample replay in `benchmark_results.json` represent genuine backtesting or synthetic/fabricated numbers?
- Is the risk engine actually wired into the execution path, or can it be bypassed?
- Would the 0.07 SOL bankroll survive real-world fee economics?

## Acceptance Criteria

### Code Path Tracing
- [ ] Every stage of the trade lifecycle has been traced through actual source code with file and line references
- [ ] Each stage is classified as: REAL (functional implementation), STUB (mock/placeholder presented as real), or MISSING
- [ ] Any silent LIVE→PAPER fallbacks are identified with exact code locations

### Plug-and-Play Verification
- [ ] The 5-step setup sequence above has been tested or traced to identify every failure point
- [ ] A list of ALL undocumented prerequisites or manual steps is produced
- [ ] Server startup, UI serving, WebSocket, and API endpoint availability are verified
- [ ] The verdict clearly states: "An operator CAN / CANNOT go live with just a wallet and these steps"

### Test Quality
- [ ] `npm test`, `npm run typecheck`, and `npm run lint` are executed independently and results reported
- [ ] At least 10 tests are spot-checked for real vs. facade quality with specific examples
- [ ] Critical untested paths are identified

### Trading Viability
- [ ] Signal components are reviewed for substantive logic vs. placeholder code
- [ ] Risk engine integration into the execution path is traced and verified
- [ ] Fee economics for 0.07 SOL bankroll are independently calculated
- [ ] Final honest verdict: VIABLE / NOT VIABLE / CONDITIONALLY VIABLE with specific blockers

### Final Deliverable
- [ ] A single `INDEPENDENT_REVIEW.md` report is produced in the working directory containing all findings, organized by requirement, with file:line references throughout
- [ ] The report ends with a clear PRODUCTION READY / NOT PRODUCTION READY verdict and a numbered list of every blocker that must be fixed

---

## 2026-09-26T04:00:18Z

# Teamwork Project Prompt — APEX Workstation Remediation (B01–B24)

> Status: Launched
> Goal: Comprehensive 6-Phase Engineering Remediation of APEX Quant HFT Workstation (Blockers B01–B24)
> Integrity mode: benchmark
> Working directory: /Users/titus/antigravity/Apex-Quant-HFT-—-Workstation
> Requested team: Full team routed from task description

Execute a rigorous, multi-agent engineering remediation of the APEX Quant HFT Workstation to resolve all 24 critical blockers (B01 through B24) identified in the certified independent forensic audit `INDEPENDENT_REVIEW.md` and specified in the master blueprint `FINDINGS_AND_REMEDIATION_PLAN.md`. Transform the platform from its current non-viable state into a genuinely production-ready, plug-and-play Solana trading workstation with real on-chain ingestion, zero live deadlocks, reclaimed token account rent, genuine alpha scoring, and strict test integrity.

## Reference Material

- `INDEPENDENT_REVIEW.md` — The certified 825-line master independent forensic review
- `FINDINGS_AND_REMEDIATION_PLAN.md` — Master exhaustive findings and 6-phase engineering blueprint (v3.0.0)
- `ORIGINAL_REQUEST.md` — The original project specification

---

## Requirements

### R1. Live Arming, Authentication & Deadlock Remediation (B01, B02, B03, B04, B05, B15, B16, B18, B22)
Eliminate all operational, architectural, and authentication barriers preventing a real operator from checking out, configuring, starting, and arming the workstation:
- **Holder Query & Live Eligibility (B01):** Implement `fetchTokenHolderDistribution` in `server/solana/pumpCurve.ts` using `connection.getTokenLargestAccounts(mint)` to compute true top 10 concentration (excluding bonding curve) and creator holding. Pass verified values to `EligibilityFilter.evaluate` in `coordinator.ts:1262`, completely eliminating the `SAFETY_CHECK_UNVERIFIED` deadlock so valid live buy orders pass into execution.
- **Startup Feed Grace Period (B02):** Eliminate the circular startup check deadlock in `coordinator.ts:197-237, 617-647` by introducing a 5-minute initialization grace period (`startupGracePeriodMs = 300_000`) and a `WARMING_UP` telemetry state, allowing feeds to connect before asserting timestamp freshness.
- **Frontend Authentication Flow (B03, B22):** Build `src/components/AuthModal.tsx` in React to prompt for `OPERATOR_AUTH_TOKEN`, validate against `/api/auth/session`, save to `localStorage`, and transmit via `Authorization: Bearer` headers and `{ type: 'AUTH', token }` WebSocket handshakes in `engineClient.ts`. In `Header.tsx`, remove the hardcoded initial `+$4.22` profit ticker, initializing to `$0.00 (0.0%) 0 Active`.
- **Configuration & Runtime Hygiene (B04, B05, B15, B16, B18):**
  - Standardize `.env.example` on `OPERATOR_AUTH_TOKEN` (≥16 chars) and document `ALLOW_LIVE_REAL_MONEY_TRADING="true"`.
  - In `server/middleware/auth.ts`, prominently log any generated fallback tokens to stdout.
  - Enforce `"engines": { "node": ">=22.5.0" }` in `package.json` and update `README.md` explaining native `node:sqlite` usage.
  - Support dynamic `const PORT = parseInt(process.env.PORT || '3000', 10)` in `server.ts`.
  - Isolate test runs to an in-memory SQLite database (`:memory:`) via `process.env.TEST_DB_PATH`, preventing pollution of `apex_workstation.db`.

### R2. Economic Viability & Protocol Capital Preservation (B06, B07, B19, B20, B24)
Halt capital bleeding and make the micro-bankroll economically viable:
- **ATA Rent Reclamation on Exits (B06):** In `server/solana/transactionBuilder.ts:364-400` (`buildSellTransaction`), append `createCloseAccountInstruction` from `@solana/spl-token` when `closeAta` is true (100% position exits). Reclaim **0.00203928 SOL** rent back to the wallet on every closed trade, verified in `TradeReconciler`.
- **Economic Exit Gating (B19):** Add rationality checks in `coordinator.closePosition` to abort selling dust tokens where transaction fees exceed residual value, unless rent reclamation yields net positive proceeds.
- **Dynamic Jito Tip Sizing & UI Normalization (B07, B24):** In `executionConfig.ts`, scale Jito tips dynamically at 3.0% of trade notional (default 180,000 lamports for micro trades) with a 150,000 lamport floor and 1,000,000 lamport ceiling, reducing tip drag by 82%. Update `PumpFunHotCalloutsView.tsx:72` to use `0.00018 SOL` default tip instead of hardcoded `0.005 SOL`.
- **Mark-to-Market Daily Loss Limit (B20):** In `WorkstationDatabase`, implement `getDailyTotalPnLSol()` summing closed PnL, open unrealized PnL, and transaction fees. Evaluate against `maxDailyLossSol` in `riskEngine.ts:234`.

### R3. Real On-Chain Ingestion & Provenance (B08, B09, B17, B21, B23)
Replace slow web polling with genuine real-time Solana infrastructure:
- **WebSocket Event Listener (B08):** Create `server/solana/pumpFeedListener.ts` using `connection.onLogs(PUMP_FUN_PROGRAM_ID, 'processed')` to detect Pump.fun V2 `CreateEvent` transactions within <50ms of block production. Wire into `pumpfunService.ts` and `memecoinAggregator.ts`, relegating HTTP polling to a secondary fallback.
- **Correct Signal Provenance (B09):** Tag on-chain discovered events with `provenance: 'REAL_ONCHAIN'` so `ExecutionCoordinator` approves them in LIVE mode without `PROVENANCE_VIOLATION`.
- **Isolate Spurious Services & Price Feed Resilience (B17, B21, B23):** Isolate the Avellaneda-Stoikov Binance futures engine behind `ENABLE_BINANCE_FUTURES="false"`, eliminating geo-blocking errors from `stream.binance.com`. In `walletTrader.ts:121`, add a Jupiter DEX or CoinGecko fallback if Binance price fetch fails. Document that `crates/apex_hft_engine` is a standalone reference benchmark for CEX matching.

### R4. Core Architecture Completion & Alpha Pipeline (B12, B13, B14)
Build the missing analytical and execution modules:
- **Capital Sizer (B12):** Implement `server/capital/capitalSizer.ts` with spendable bankroll calculation (`wallet - reserve - inFlight`), Fractional Kelly sizing with sample shrinkage ($S = N / (N + 25)$), and hard 10% ceiling. Wire into `memecoinAggregator` and `coordinator`.
- **Dynamic Exit Engine (B13):** Implement `server/exits/exitEngine.ts` featuring monotonic trailing stops ratcheting upward past +15% gain, 3-stage take-profit ladders (33% @ +30%, 33% @ +60%, 34% trailing), and time-based exits. Wire into `startAutoPositionMonitor` and update SQLite tracking columns `high_water_mark_sol`, `trailing_stop_sol`, and `exit_stage`.
- **Substantive Signal Models & Confluence (B14):**
  - Implement `server/signals/curveVelocityEvaluator.ts` measuring slot-level acceleration ($\Delta\text{SOL}/\Delta\text{slots}$) and short-window volume.
  - Implement `server/signals/creatorRiskScorer.ts` analyzing creator launch history, burner funding patterns, and previous rug count.
  - Wire `ConfluenceEngine` into `pumpfunService.ts` and `memecoinAggregator.ts`, filtering trades with composite score threshold $\ge 70$.

### R5. Test Integrity & Backtesting Truth (B10, B11)
Restore forensic integrity to testing and performance evaluation:
- **Facade Test Eradication (B10):** Refactor all 245 facade tests in E2E Tiers 1–4 to invoke real production classes (`CapitalSizer`, `ExitEngine`, `HardenedRiskEngine`, `PumpCurveService`, `EligibilityFilter`) with realistic mock state instead of local arrow functions or tautological comparisons.
- **Purge Synthetic Backtests (B11):** Purge the LCG pseudo-random generator and hardcoded -12% rug exit assumptions from `scripts/run_benchmarks_and_evaluation.ts`. Implement an authentic historical replay harness using real Solana transaction archives with realistic rug losses (-90% to -100%).

---

## Acceptance Criteria

### Live Arming & Execution Path
- [ ] `fetchTokenHolderDistribution` queries `getTokenLargestAccounts` and correctly separates bonding curve reserves from circulating holders; `coordinator.executeTrade` approves valid live buy orders without `SAFETY_CHECK_UNVERIFIED`
- [ ] System initializes with `lastPumpFeedTimestamp = 0` and can be armed for live trading immediately during the startup grace period without circular deadlock
- [ ] React UI renders an auth modal, authenticates with `/api/auth/session`, attaches `Bearer` tokens, connects to WebSocket with `AUTH`, and allows live arming without 401 errors
- [ ] `Header.tsx` initializes profit summary to `$0.00 (0.0%) 0 Active`
- [ ] `.env.example` standardizes on `OPERATOR_AUTH_TOKEN` and documents `ALLOW_LIVE_REAL_MONEY_TRADING="true"`
- [ ] Server dynamically binds to `process.env.PORT`
- [ ] Tests execute against `:memory:` or ephemeral test database without altering `apex_workstation.db`

### Capital Preservation & Protocol Correctness
- [ ] 100% position exits emit `createCloseAccountInstruction`, successfully reclaiming 0.00203928 SOL rent to the wallet (verified via unit test inspecting transaction instructions and lamport delta)
- [ ] Dust position sells worth less than transaction fees are aborted with `DUST_POSITION_EXIT_UNECONOMICAL` unless rent recovery yields net positive proceeds
- [ ] Jito tips for micro trades scale dynamically to 3.0% of trade notional (default 180,000 lamports) rather than flat 1,000,000 lamports; UI sends 180,000 lamport default
- [ ] Daily loss limit halts trading if open position unrealized losses + transaction fees breach the configured threshold

### Ingestion & Alpha Pipeline
- [ ] Solana WebSocket listener subscribes to Pump.fun program logs and decodes `CreateEvent` within 50ms of block production, assigning `provenance: 'REAL_ONCHAIN'`
- [ ] `server/capital/capitalSizer.ts` exists on disk, calculates spendable bankroll and shrunk Fractional Kelly size, and enforces the 10% hard cap
- [ ] `server/exits/exitEngine.ts` exists on disk, updates `high_water_mark_sol` and `trailing_stop_sol` in SQLite, and executes trailing stop / TP ladder logic
- [ ] `ConfluenceEngine` evaluates curve velocity and creator history, active in trade hot path with score threshold $\ge 70$
- [ ] Binance futures engine defaults to disabled (`ENABLE_BINANCE_FUTURES="false"`); SOL price fetch falls back to Jupiter/CoinGecko if Binance fails

### Test Quality & Verification
- [ ] `npm run typecheck` passes with 0 errors
- [ ] `npm run lint` passes with 0 errors
- [ ] `npm test` passes 100% of tests, with zero tests asserting against inlined local mock lambdas (facades purged)
- [ ] `npm run build` succeeds and produces `dist/server.cjs` and `dist/index.html` cleanly
- [ ] Zero synthetic LCG random backtests remain in the repository

## 2026-09-27T02:54:45Z

You are the Phase 6 Remediation Orchestrator for the APEX Quant HFT Workstation.
Your mission: Verify the completion of Phase 6 (B10: Facade Test Eradication & B11: Purge Synthetic Backtest) and the final 24-blocker production readiness state.

Working directory: /Users/titus/antigravity/Apex-Quant-HFT-—-Workstation
Integrity mode: benchmark

Review the recent remediation:
- In tests/e2e/tier1/features21_25.test.ts, F21.1 and F21.2 were refactored to call CapitalSizer directly.
- In tests/e2e/tier1/features16_20.test.ts, F20.1 was refactored to call ExitEngine directly.
- In tests/e2e/tier2/boundaries16_20.test.ts, B20.1-B20.3 were refactored to call ExitEngine.
- In tests/e2e/tier2/boundaries21_25.test.ts, B21.1-B21.2 were refactored to call CapitalSizer.
- In tests/challenger_m1_protocol_correctness.test.ts, test 4.2 was refactored to call PumpCurveService.
- In scripts/run_benchmarks_and_evaluation.ts, the LCG and -12% fake rug were purged and replaced with a deterministic scenario replay harness.
- Confirm all 696 tests pass across 33 test files.
- Audit all 24 blockers (B01-B24).
- Write your report to .agents/orchestrator_remediation_gen4/FINAL_COMPLETION_REPORT.md.

## 2026-09-27T04:45:28Z

# Teamwork Project Prompt — Final End-to-End Production & Live Plug-and-Play Verification

> Status: Launched
> Goal: Final End-to-End Production & Live Plug-and-Play Verification of APEX Quant HFT Workstation
> Integrity mode: benchmark
> Working directory: /Users/titus/antigravity/Apex-Quant-HFT-—-Workstation
> Requested team: Full team routed from task description

Conduct a comprehensive, end-to-end operational verification of the remediated APEX Quant HFT Workstation to certify beyond doubt that the platform is 100% production-ready and plug-and-play operable by a real trader with only a funded Solana wallet keypair.

## Reference Material

- `INDEPENDENT_REVIEW.md` — The original 825-line forensic audit report
- `FINDINGS_AND_REMEDIATION_PLAN.md` — Master 6-phase engineering remediation plan
- `PRODUCTION_READY.md` — Certified production readiness document
- `.agents/orchestrator_remediation_gen4/FINAL_COMPLETION_REPORT.md` — Master 24-blocker completion report
- `.agents/orchestrator_remediation_gen4/GATE_STATUS.md` — Phase 6 Gate Status

---

## Requirements

### R1. Operator Plug-and-Play Lifecycle Simulation
Verify the exact 5-step operator setup flow from a clean checkout:
1. `npm ci` dependencies installation and engine constraints (`node >= 22.5.0`).
2. `.env` configuration template validation (`OPERATOR_AUTH_TOKEN`, `ALLOW_LIVE_REAL_MONEY_TRADING="true"`, RPC endpoints).
3. Keypair generation and import via `npm run signer:import` verifying correct encrypted storage in SQLite and memory unlock.
4. Clean production build (`npm run build`) and startup (`npm start` running `dist/server.cjs`), confirming zero runtime import errors (e.g., `createRequire` / `import.meta.url` issues).
5. Frontend authentication flow via `AuthModal.tsx` transmitting `Bearer` tokens and `{ type: 'AUTH', token }` WebSocket messages to arm live trading without 401 lockouts.

### R2. End-to-End Autonomous Trading Pipeline Verification
Trace and verify every component of the live trade execution path under simulated network conditions:
- **Feed Ingestion:** `PumpFeedListener` WebSocket log subscription capturing Pump.fun V2 `CreateEvent` transactions within <50ms with `provenance: 'REAL_ONCHAIN'`.
- **Eligibility & Safety:** `EligibilityFilter` verifying freeze authority revocation, mint authority revocation, token-2022 safety, and holder concentration via `fetchTokenHolderDistribution`.
- **Alpha Scoring:** `ConfluenceEngine` scoring tokens with `CurveVelocityEvaluator` (ΔSOL/Δslots) and `CreatorRiskScorer`.
- **Pre-Trade Risk & Sizing:** `HardenedRiskEngine` verifying all 14 risk controls; `CapitalSizer` calculating spendable bankroll and shrunk Fractional Kelly sizing capped at 10%.
- **Quoting & Transaction Build:** `PumpCurveService` deriving PDAs and integer quotes; `TransactionBuilder` generating VersionedTransactions with dynamic Jito tips.
- **Rent Reclamation & Dynamic Exits:** `TransactionBuilder.buildSellTransaction` appending `createCloseAccountInstruction` to reclaim **0.00203928 SOL** rent per trade; `ExitEngine` evaluating high-water marks, 3-stage take-profit ladders, and trailing stops.

### R3. Comprehensive Verification & Zero-Facade Integrity
Independently execute and verify the platform's test and build suites:
- Execute `npm test` verifying all 33 test files and 696 tests pass clean (100% PASS rate).
- Verify that residual facade tests across E2E Tiers 1–4 are completely eliminated and exercise real production classes.
- Execute `npm run typecheck` (`tsc --noEmit`) and verify 0 errors.
- Execute `npm run lint` (`eslint . && tsc --noEmit`) and verify 0 errors.
- Execute `cargo test --manifest-path crates/apex_hft_engine/Cargo.toml` verifying 4/4 Rust engine tests pass.
- Execute `npx tsx scripts/run_benchmarks_and_evaluation.ts` verifying the deterministic 300-scenario strategy replay executes with authentic rug loss profiles.

### R4. Final Certification & Operator Sign-off
Deliver a final `FINAL_CERTIFICATION.md` report verifying whether an operator with a funded Solana wallet can begin live trading immediately without manual code modifications, workarounds, or hidden prerequisites.

---

## Acceptance Criteria

### Operator Setup & Startup
- [ ] `node dist/server.cjs` starts without `ERR_INVALID_ARG_VALUE` or import errors, binds to `PORT`, and serves the UI.
- [ ] Keypair import script (`scripts/import_signer.ts`) successfully imports and verifies keypair files.
- [ ] UI WebSocket connects, authenticates using `OPERATOR_AUTH_TOKEN`, and allows toggling live arming.
- [ ] Header profit ticker initializes to `$0.00 (0.0%) 0 Active`.

### Pipeline & Protocol Execution
- [ ] Valid live buy orders pass `SAFETY_CHECK_UNVERIFIED` and provenance checks without deadlocking.
- [ ] 100% position exits reclaim 0.00203928 SOL rent via `createCloseAccountInstruction`.
- [ ] Jito tips scale dynamically at 3% of trade notional (default 180,000 lamports for micro trades).
- [ ] `CapitalSizer`, `ExitEngine`, `ConfluenceEngine`, and `HardenedRiskEngine` execute in the live trade hot path.

### Test & Code Integrity
- [ ] `npm test` passes 33/33 files and 696/696 tests (100% pass rate).
- [ ] `npm run typecheck` passes with 0 errors.
- [ ] `npm run lint` passes with 0 errors.
- [ ] `npm run build` builds both client and server bundles cleanly.
- [ ] `cargo test` passes 4/4 tests.
- [ ] Zero synthetic LCG random backtests exist in the repository.
