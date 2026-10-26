# Latency: stages and time limits

What the trade path does between a launch on the feed and a landed buy or sell, and every time limit in the code that delays or refuses an order. It describes the integration snapshot 767c13a. **Devnet and localnet only.**

The name "HFT" is historical. Auto buys 20 to 120 s after a launch's first trade (the watch window), not at block 0; exits are polled every 3 s; and every RPC call goes over one shared connection. Nothing here claims a latency advantage. See [`KNOWN_RISKS.md`](../KNOWN_RISKS.md) section 8 for what the scores can reach.

`tests/s3j_docs_constants.test.ts` reads the constants named in the table of limits from the source and fails if one no longer has the value stated here. It does not check the line numbers: they are from the snapshot and drift, so search for the symbol.

## 1. What was measured and what was not

| Number | Source | Status |
|---|---|---|
| A LIVE buy about 1.4 s end to end on devnet; a LIVE sell about 1.5 to 2.7 s | the 2026-10-15 audit session's notes (prior_results, not in this repository) | Reported, not re-measured. The notes do not say where the clock starts and stops, so they may leave out some pre-send gates |
| One public devnet RPC call about 120 to 160 ms | S208 (a genesis call, 121 to 156 ms) and S210 (the blockhash check, 120 to 160 ms) | Reported in the patch notes, not re-measured |
| Replay entry delay 1.5 s after release | `entryDelayMs` in `server/backtest/replay.ts` (marked ASSUMPTION there) | Assumption |
| The number of RPC round trips per stage | the HFT pipeline draft (not in this repository), written at commit 9b9f568 | **Not re-counted at this snapshot** (the readiness gate, request timeouts and blockhash-expiry watch were added since). Do not use it for a decision |

To measure a stage yourself: run with `APEX_TRACING=true` (spans `watch.release`, `snipe.execute`, `gate.confluence`, `trade.execute`, `gate.eligibility`, `risk.evaluateOrder`, `tx.build`, `guard.blockhash`, `tx.sign`, `guard.sendCluster`, `guard.genesis`, `tx.submit`, `tx.confirm`, `tx.reconcile`, `exit.close`, one `POST` span per RPC call; see [`TRACING.md`](TRACING.md)). `GET /api/system/latency` reports measured send-to-confirm per transport, mode and side. `APEX_TRACING=true npm run devnet:e2e` shows the spans of a real devnet round trip; that check has not been run for this document.

## 2. Stages

| # | Stage | What bounds it | Code |
|---|---|---|---|
| 1 | Detection: pump program logs and slot notifications over the websocket, decoded into Create and Trade events | Push. A websocket drop, 10 s of slot silence, a slot jump or an RPC switch opens a gap and releases every watched launch `DEAD` | `server/solana/pumpFeedListener.ts:533` |
| 2 | Watch window: real trades for 20 to 120 s from the first trade; HOT early, READY at the end, DEAD on a creator sell, no trades or a curve past the cap; held while a seller's funder lookup is outstanding | The main delay, by design | `server/signals/watchWindow.ts:495` |
| 3 | Release to auto candidate: gates, one candidate in flight, a queued release retried after 2 s while it is younger than 6 s | Queue age is measured from the release, not from when it was queued | `server/auto/controller.ts:773` |
| 4 | `executeSnipe`: price, sizing, pool, freeze authority, creator share, confluence score | Manual routes join here | `server/memecoinAggregator.ts:494` |
| 5 | `executeTrade` LIVE branch up to the reservation: armed, cluster, per-buy readiness, curve read, eligibility, sizing, quote, risk engine, duplicate checks | Several sequential RPC reads; the curve read starts the 5 s market-data clock | `server/execution/coordinator.ts:2287` |
| 6 | Snapshot, build, optional blockhash check, signature, Q17 re-check, `orders` row | The per-buy readiness gate runs again here | `server/execution/coordinator.ts:2755` |
| 7 | `submitAndConfirmWithRetry`: read-only check, send-cluster check, cached genesis check, then the PENDING row | A refusal here leaves no row | `server/execution/coordinator.ts:1594` |
| 8 | `submitAndConfirmInner`: the guards again, then send and the confirm watch | 15 s watch plus up to 60 s while the blockhash is valid | `server/execution/coordinator.ts:1686` |
| 9 | Reconcile the fill and save the position | The position, and so its stop-loss, exists only after the fill is reconciled | `server/execution/reconciliation.ts:175` |
| 10 | Exit pass: every 3 s, marks read, rules evaluated, sells started together and awaited up to 2.5 s | A sell blocks only its own position | `server/execution/coordinator.ts:4029` |
| 11 | LIVE sell: cluster check, venue, quote, build, snapshot, optional blockhash check, signature, simulation, submit | Not gated by readiness | `server/execution/coordinator.ts:3211` |

The order of the guards between stages 5 and 8 is drawn in diagram 3 of [`ARCHITECTURE.md`](ARCHITECTURE.md), and `tests/s3j_docs_constants.test.ts` checks the diagram's edge order against the first calls in `executeTradeUntraced` and `submitAndConfirmWithRetry`.

## 3. Time limits

Each row: the limit, its value, what happens on a breach, and where it lives at 767c13a.

| Limit | Value | On breach | Code |
|---|---|---|---|
| Watch window, minimum and maximum | 20 s and 120 s from the first trade (`WATCH_MIN_MS`, `WATCH_MAX_MS`) | No release before 20 s. At 120 s a launch with no HOT verdict is released `READY` (or `DEAD`: `NO_TRADES`, `CURVE_TOO_FAR`, `CREATOR_SOLD`) | `server/signals/watchWindow.ts:36`, `server/signals/watchWindow.ts:37` |
| Feed slot silence | 10 s without a slot notification (`FEED_SLOT_SILENCE_MS`) | Gap: status `RECONNECTING`; every launch in the window released `DEAD` `FEED_GAP` | `server/solana/pumpFeedListener.ts:26` |
| Feed slot jump | more than 25 slots between two notifications (`FEED_SLOT_JUMP_MAX`) | Same gap; it ends at the next in-order slot | `server/solana/pumpFeedListener.ts:28` |
| Funder lookup retries | after 1.5 s, 4 s and 10 s (`FUNDER_RETRY_DELAYS_MS`); 4 lookups at a time, 150 per mint for buyers | A lookup that fails after its retries is unread: a buyer or seller with an unread funder fails the `buyers` signal | `server/signals/funderLookup.ts:8`, `server/signals/funderLookup.ts:4` |
| Release retry | 2 s (`RELEASE_RETRY_MS`); a queued release is kept while younger than 6 s (`PENDING_RELEASE_MAX_AGE_MS`, never above the risk engine's signal age minus 2 s) | A release older than that is journalled `STALE_SIGNAL` without a curve read | `server/auto/controller.ts:144`, `server/auto/controller.ts:142` |
| Signal age (release to risk check) | 8 s (`maxSignalAgeMs: 8000`) | `STALE_SIGNAL`, in PAPER, LIVE and (through `previewBuy`) SHADOW | `server/risk/riskEngine.ts:75` |
| Market data age (curve read to risk check) | 5 s (`maxDataAgeMs: 5000`) | `STALE_MARKET_DATA` (a retryable refusal) | `server/risk/riskEngine.ts:74` |
| Eligibility report age | 60 s | `ELIGIBILITY_REPORT_STALE` | `server/execution/coordinator.ts:2062` |
| SOL/USD price age | 120 s (`SOL_PRICE_MAX_AGE_MS`); a price needs a second source within 5% when no anchor under 10 min old exists (`SOL_PRICE_ANCHOR_MAX_AGE_MS`) | A LIVE buy with an older price is refused (`SOL_PRICE_UNAVAILABLE`, retryable) | `server/market/solPriceService.ts:29`, `server/market/solPriceService.ts:35` |
| Cooldown after a failed trade | 15 s, global (`cooldownAfterFailedTradeMs`) | `EXECUTION_DISABLED` | `server/risk/riskEngine.ts:76` |
| Cooldown per mint | 30 s after a buy (`cooldownPerMintMs`) | `DUPLICATE_MINT` | `server/risk/riskEngine.ts:77` |
| Net daily PnL window | 24 h rolling (`DAILY_LOSS_WINDOW_MS`); a SOL price older than 1 h (`DAILY_LOSS_PRICE_MAX_AGE_MS`) only tightens the floor | `DAILY_LOSS_LIMIT`, latched until `clearDailyLossLatch` | `server/risk/riskEngine.ts:38`, `server/risk/riskEngine.ts:47` |
| Genesis check cache | 60 s per Connection (`GENESIS_CHECK_TTL_MS`) | A miss costs one `getGenesisHash` on the send path; a failure removes the pass | `server/solana/clusterGuard.ts:148` |
| Independent blockhash check (opt-in) | one call to the public devnet RPC, a second after 500 ms on a "no"; no timeout of its own (plain web3.js connection) | A buy that cannot be checked is refused; a sell is refused only on a definite "no" | `server/solana/clusterGuard.ts:233` |
| Database writable probe | result reused for 1 s (`WRITABLE_CACHE_MS`); needs 16 MiB free (`MIN_FREE_BYTES`) | Per-buy readiness refuses (`the workstation database is not writable`) | `server/db/database.ts:1205`, `server/db/database.ts:1203` |
| RPC request timeout | 1.5 s per request on the trading connection (`DEFAULT_RPC_REQUEST_TIMEOUT_MS`); reads are tried twice (`RPC_READ_TRIES`), sends once; slow reads 10 s | The request is aborted; an unanswered send's outcome is decided by the send watch | `server/solana/rpcConnection.ts:14`, `server/solana/rpcConnection.ts:15`, `server/solana/rpcConnection.ts:38` |
| RPC limiter wait | 3 s for a slot (`DEFAULT_RPC_LIMITER_MAX_WAIT_MS`), only when `RPC_MAX_REQUESTS_PER_SEC` is set | The request fails unsent | `server/solana/rpcConnection.ts:66` |
| Send watch (RPC transport) | 15 s (`RPC_FALLBACK_TIMEOUT_MS`), status poll every 400 ms, the same signed bytes resent every 1.5 s, extended by up to 60 s while the blockhash is still valid | Expired with no status: `BLOCKHASH_EXPIRED`, row `TIMED_OUT`, a sell leaves no pending sell; a buy sent and not seen failing becomes `RECONCILIATION_REQUIRED` | `server/solana/executionConfig.ts:146`, `server/solana/transports.ts:272`, `server/solana/transports.ts:321`, `server/solana/transports.ts:271` |
| Sell resends after a rate limit | after 0.5 s, 1 s and 2 s (`SELL_RATE_LIMIT_BACKOFF_MS`), a buy is not resent | `RPC_RATE_LIMITED` if all are refused | `server/execution/coordinator.ts:112` |
| Wait after `RPC_RATE_LIMITED` | 6 s flat (`EXIT_RATE_LIMITED_WAIT_MS`) | The exit pass skips that position; manual close and panic are not held back | `server/execution/coordinator.ts:29` |
| Exit pass | every 3 s; the pass waits at most 2.5 s (`EXIT_SELL_WAIT_MS`) for the sells it started | A sell still running keeps going and its position is skipped until it ends | `server/execution/coordinator.ts:4191`, `server/execution/coordinator.ts:119` |
| Stale mark | 15 s (`MARK_STALE_MS`) then one direct read | The position is skipped if that read fails | `server/execution/coordinator.ts:33` |
| Mark failure back-off | 60 s doubling to 10 min (`MARK_RETRY_BASE_MS`, `MARK_RETRY_MAX_MS`); PAPER positions, and a LIVE position only when its mint can never be marked | No read of that mint meanwhile | `server/execution/coordinator.ts:36`, `server/execution/coordinator.ts:37` |
| Mark alert | 60 s without a mark (`MARK_ALERT_AFTER_MS`) | `POSITION_MARK_UNAVAILABLE` | `server/execution/coordinator.ts:35` |
| Mark feed health | DEGRADED after 45 s and STALE after 90 s without a LIVE position mark; arming needs 120 s or less | STALE refuses a LIVE buy (per-buy readiness) | `server/execution/coordinator.ts:316` |
| Failed-sell retry back-off | 3 s doubling to 30 s (`EXIT_RETRY_BASE_MS`, `EXIT_RETRY_MAX_MS`); slippage 800, 1500, 2500, 4000 bps (`SELL_SLIPPAGE_LADDER_BPS`), capped by `MAX_SELL_SLIPPAGE_BPS` | The deadline is wall-clock and is not rewritten (known gap, `KNOWN_RISKS.md` section 10) | `server/execution/coordinator.ts:23`, `server/execution/coordinator.ts:24`, `server/execution/coordinator.ts:21` |
| Pending sell | 100 s after the confirm gave up (`PENDING_SELL_WINDOW_MS`); an exit claim is stale after 200 s (`EXIT_CLAIM_STALE_MS`) | `SELL_PENDING_VERIFICATION`: no second sell until it lands, expires or the window ends | `server/execution/coordinator.ts:116`, `server/execution/coordinator.ts:121` |
| RPC heartbeat | every 10 s a `getSlot`, the cluster check and the feed ages; over 800 ms is `DEGRADED` | `DEGRADED` blocks arming; a wrong genesis sets `clusterProblem`, which refuses every send | `server/execution/coordinator.ts:325`, `server/execution/coordinator.ts:638` |
| Readiness red (auto) | 10 s (`READINESS_RED_LIMIT_MS`) | Auto drops to SHADOW; from DEVNET_LIVE it also disarms | `server/auto/killSwitch.ts:13` |
| Wallet balance unknown (auto) | the first null balance, no grace at this snapshot | `WALLET_UNKNOWN` kill trigger | `server/auto/killSwitch.ts:85` |
| Orphan buy recovery | retries after 5, 15, 45, 120 and 300 s (`orphanRecoveryDelaysMs`); `TIMED_OUT` once the blockhash has expired or the row is 15 min old (`ORPHAN_MAX_AGE_MS`) and the signature is unseen | The row can stay unresolved in-process until then; `POST /api/execution/reconcile` re-runs the pass | `server/execution/coordinator.ts:1321`, `server/execution/coordinator.ts:117` |
| Reconcile pass | 90 s (`reconcileTimeoutMs`); retried after 15 s | The pass keeps running; startup reconciliation stays not `EXECUTION_READY` meanwhile | `server/execution/coordinator.ts:1081`, `server/execution/coordinator.ts:1084` |
| PumpSwap pool cache | 15 s (`CACHE_TTL_MS`), on the monotonic clock | A migrated position's marks and stops can react up to about 15 s late | `server/solana/pumpSwapService.ts:66` |
| Panic wait for LIVE buys | 30 s (`PANIC_BUY_SETTLE_WAIT_MS`) | A buy still unsettled is reported `BUY_IN_FLIGHT` in `failed[]` | `server/execution/emergencyStop.ts:12` |

## 4. Known gaps in the limits

- The failed-sell retry deadline and the 6 s rate-limit wait are wall-clock deadlines that are not rewritten when the clock is set back: the exit pass can keep skipping that position until the old deadline (`KNOWN_RISKS.md` section 10).
- `WALLET_UNKNOWN` fires on the first null balance read. Changing it to wait for `READINESS_RED_LIMIT_MS` is planned work (3E), not in this snapshot.
- The independent blockhash check (`APEX_VERIFY_BLOCKHASH`) asks through a plain web3.js connection, so it has no per-call timeout and web3.js sleeps on an HTTP 429. That is from the audit; it was not re-measured here.
- The one-position cap of DEVNET_LIVE and the open-position count read ACTIVE rows of every mode; 3B is planned to change what counts (`ARCHITECTURE.md` section 2).
