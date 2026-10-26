# Apex Quant HFT Workstation — Known Risks & Operational Guidelines

This document outlines structural, economic, and operational risks of running this automated Pump.fun trader, together with the countermeasures the code applies or the operator must apply. The build is **devnet and localnet only**: the cluster guard refuses mainnet, so mainnet-specific advice (private mainnet RPC providers, Jito block engines, tip auctions) does not apply here. It is not a latency-sensitive HFT system.

---

## 1. Environmental & Network Risks

### 1.1 Public devnet RPC Rate Limits & Slot Lag
* **Risk Description:** The free public devnet RPC (`https://api.devnet.solana.com`) is rate limited per IP and can lag or drop requests. Devnet itself has far less activity and liquidity than mainnet.
* **Operational Impact:** Transactions may hit stale blockhash errors (`BlockhashNotFound`), and account balances or bonding curve state may be out of date, so a result seen on devnet says little about mainnet behaviour.
* **Required Countermeasure:** Use a devnet endpoint you control or a provider's devnet URL (never commit it: URLs often embed the API key), or a local validator for `localnet`. Set `SOLANA_RPC_URL` in `.env` (the websocket address is derived from it; the server does not read `SOLANA_WS_URL`). The trading connection aborts a request after `RPC_REQUEST_TIMEOUT_MS` (default 1500 ms) and tries a read once more, a send not; `RPC_MAX_REQUESTS_PER_SEC` adds a client-side limit (see [`docs/ENV.md`](docs/ENV.md)). The optional independent blockhash check (`APEX_VERIFY_BLOCKHASH`) asks the public devnet RPC through a plain web3.js connection, which has no per-call timeout and sleeps on an HTTP 429 (not re-measured here; from the audit). The app logs RPC and Jito URLs as scheme and host only. `ENABLE_RPC_FALLBACK` and `RPC_FALLBACK_TIMEOUT_MS` control the RPC fallback path.

### 1.2 Jito is not used on devnet
* **Risk Description:** Devnet has no Jito block engine, so there is no bundle delivery or tip auction to test here. Jito is off by default (no `JITO_BLOCK_ENGINE_URL`). Tip-floor lookups apply to mainnet-beta only. A non-mainnet block engine URL is accepted and used on devnet, which is only meaningful for a test mock.
* **Operational Impact:** Bundle landing behaviour, tip economics and private-mempool protection are **unverified** and out of scope. Orders are sent as ordinary transactions with a priority fee, so they are exposed to the public mempool.
* **Required Countermeasure:**
  - Leave `JITO_BLOCK_ENGINE_URL` unset. With no block engine configured, Jito readiness reads `NOT_CONFIGURED` and is **not** a blocker for arming; RPC is the only transport. A mainnet block engine URL is refused.
  - If a non-mainnet block engine URL is ever set (tests do, with a mock), it must be `HEALTHY` from a recent probe or live arming fails closed.
  - `DEFAULT_JITO_TIP_SOL` (default `0.00018`) is the fallback tip, used when neither a tip floor reading nor an order size is available; a normal buy takes a size-scaled tip, never below `MIN_JITO_TIP_SOL` (default `0.00015`) and capped at 15% of the order. While Jito is off (the devnet default) the coordinator forces the tip to 0 (`resolveLiveTip`), so no tip transfer is added to the transaction. A `JITO_DYNAMIC_TIP_FLOOR` setting appears in older notes; no code reads it.

---

## 2. On-Chain Protocol & Market Execution Risks

### 2.1 Bonding Curve Migration to Canonical PumpSwap AMM
* **Risk Description:** When a Pump.fun bonding curve reaches 100% completion (~85 SOL deposited), the contract locks trading on the bonding curve and initiates liquidity migration to the canonical PumpSwap AMM.
* **Operational Impact:** Any pending or submitted Pump.fun buy/sell transaction targeting a migrated curve will revert with custom program error `BondingCurveComplete`.
* **Required Countermeasure:** 
  - The workstation tracks bonding curve progression and dynamically migrates position state (`PUMP_BONDING_CURVE` → `PUMPSWAP`).
  - Active positions on migrated tokens are traded through the official `@pump-fun/pump-swap-sdk@1.20.0` integration using canonical pool PDA resolution, dynamic fee schedules, and `effectiveQuoteReserves = actualQuoteReserves + virtualQuoteReserves`.
  - Non-SOL quote mints are strictly rejected (`UNSUPPORTED_PUMPSWAP_QUOTE_MINT`).

### 2.2 Token-2022 Transfer Fees and Extensions
* **Risk Description:** Certain memecoins mint with Token-2022 extensions, including variable transfer fees, non-transferable flags, permanent delegate hooks, or transfer hooks.
* **Operational Impact:** Transactions may revert, lose capital to hidden transfer fees, or have token balances frozen.
* **Required Countermeasure:** `PumpCurveService.inspectToken2022Extensions` inspects the full TLV extension stream. Any token with transfer fees, hooks, permanent delegates, or non-transferable extensions fails closed and is rejected for LIVE trading (`UNSUPPORTED_TOKEN_EXTENSION`).

### 2.3 Slippage & Sandwich MEV
* **Risk Description:** Volatile memecoin liquidity pools are vulnerable to sandwich attacks when transactions are submitted via public mempools.
* **Operational Impact:** High slippage settings can result in severe adverse execution prices.
* **Required Countermeasure:**
  - Buys: the risk engine refuses a buy whose slippage is above `MAX_SLIPPAGE_BPS` (default 800 bps, 8%; `SLIPPAGE_TOO_HIGH`). That check runs for buys only.
  - Sells are not checked by the risk engine. Each consecutive failed exit of a LIVE position widens its sell slippage along the ladder 800, 1500, 2500, 4000 bps (`SELL_SLIPPAGE_LADDER_BPS` in `server/execution/coordinator.ts`), and waits 3, 6, 12, 24, then 30 s before the next try, so a stop-loss in a fast dump can still clear. After three counted failures a stop-loss goes out accepting up to 40% less than quoted, unless `MAX_SELL_SLIPPAGE_BPS` (100 to 4000, default 4000) caps the ladder lower; a lower cap means a stop-loss in a fast dump may not clear. The ladder advances only for LIVE sells and only on errors counted as attempts: a send that failed and a failed simulation (nothing was sent) count; quote failures and anything thrown before the send (`EXIT_QUOTE_FAILING`), and results that attempted nothing (a pending sell, unknown venue or unreadable curve, no signer, halt, dust, the cluster guard, an untrusted empty balance, an exit already in flight, a send the RPC rate-limited past its three resends, `RPC_RATE_LIMITED`) do not. A rate-limited sell send is resent after 0.5, 1 and 2 s without counting and without widening slippage; when every resend is refused the exit pass waits 6 s (`EXIT_RATE_LIMITED_WAIT_MS`, flat, without counting or widening slippage) before that position's next try, and `EXIT_RATE_LIMITED` is raised; a manual close or a panic is not held back by the wait. Set `RPC_MAX_REQUESTS_PER_SEC` on the public devnet RPC. A successful exit resets it.
  - On devnet and localnet there is no private bundle route (see 1.2): orders go through the public mempool as ordinary transactions, so sandwich protection is not provided or tested here.

---

## 3. Capital allocation on a small devnet wallet (`CAPITAL_TIER=MICRO_10`)

All amounts in this section are devnet SOL, on a throwaway devnet key (see 4.1).

### 3.1 Tiny Bankroll Sensitivity (~0.07 devnet SOL)
* **Risk Description:** At ~0.07 SOL total bankroll, fixed execution costs (signature fee, token account rent, priority fee, and the one-time pump account rent on a wallet's first pump buy) are a large share of the order size.
* **Operational Impact:** Indiscriminate trading can lead to severe fee drag even on winning trades.
* **Required Countermeasure:**
  - Sizing uses spendable bankroll: $\text{Spendable} = \text{Wallet SOL} - 0.015\text{ SOL reserve} - \text{in-flight orders}$.
  - Hard per-trade cap for a LIVE buy: 10% of spendable, so about 0.0055 SOL on a 0.07 SOL wallet (`EXCEEDS_CAPITAL_CEILING`).
  - Pre-trade fee economics check: if the estimated round-trip cost exceeds 20% of the order, the buy is refused (`EXPECTED_EDGE_BELOW_EXECUTION_COST`). On a wallet's first pump buy that cost includes the pump volume-accumulator rent (1,346,200 lamports, never refunded), which alone is 20% of about 0.0067 SOL, so a first buy must be larger than that; the refusal names the size that would pass. If the accumulator account cannot be read, the rent is counted as unpaid.
  - The first trailing stop is never below entry x 1.03. A LIVE sell whose proceeds would not cover its fees is refused as dust (`DUST_POSITION_EXIT_UNECONOMICAL`) unless it is a stop-loss, trailing stop or panic.

---

## 4. Key Management & Host Security

### 4.1 Local Signer Isolation
* **Risk Description:** Compromise of the server host filesystem exposes unencrypted keypair files.
* **Operational Impact:** Potential unauthorized asset drainage.
* **Required Countermeasure:**
  - Use a throwaway devnet key generated for this app: the UI, `POST /api/signer/generate`, or `solana-keygen new`. Fund it only from the devnet faucet.
  - `npm run signer:import -- /path/to/throwaway-keypair.json` copies a keypair file into `.apex_trading_keypair.json` with POSIX `0600` permissions (readable and writable solely by the running user). It does no cluster check and accepts any key, so never give it a key that holds, or has ever held, mainnet funds.
  - Key material is never transmitted to web browsers, client frontends, or WebSocket consumers.

### 4.2 Operator Authentication
* **Risk Description:** Unprotected HTTP mutation routes could allow unauthorized trade initiation or configuration changes.
* **Operational Impact:** Unauthorized live trades or parameter modifications.
* **Required Countermeasure:**
  - The application applies `requireOperatorAuth` to all state-modifying endpoints.
  - WebSocket telemetry enforces `CONNECT → AUTH_REQUIRED → authenticate → AUTHENTICATED`. Query strings are not accepted.
  - Set `OPERATOR_AUTH_TOKEN` (16+ characters) in `.env` to a high-entropy secret.
  - Every non-GET `/api` request, `requireOperatorAuth` and the trading WebSocket need the OPERATOR role (T3). Only operator sessions are issued today, so this changes nothing in practice; a READONLY session could still GET.
  - The `/api` rate limit and the login limit are keyed on the peer's socket address (3G). `POST /api/auth/login` allows 5 attempts, then one every 12 s per address, with no lockout or backoff beyond that: about 7,200 guesses a day per address. A stronger rule is a design choice, not made.
  - An authenticated WebSocket keeps the token it authenticated with. Before each broadcast a socket whose token no longer validates is closed with code 4001; rotate and logout close the revoked sockets at once, and an expiry is caught at the next broadcast.
  - `GET /api/health` returns only `{"status":"ONLINE"}` (T4). In production an error with no code of its own returns a generic message and the correlation id; the full text stays in the log. Classified errors, 4xx and non-production runs keep their messages.
  - `POST /api/wallet/config` takes only the fields it is sent (3G): a save without `maxPositionSizeSol` no longer resets the cap, `jitoBlockEngineUrl: ''` turns Jito off, `riskLimits.maxDailyLossUsd` is refused with a 400 (it was never read; set `MAX_DAILY_LOSS_USD` in the environment), and `rpcEndpoint` must be an http or https URL. Link-local and unique-local IPv6 and metadata hosts are refused; loopback and private IPv4 stay allowed because localnet needs `127.0.0.1`.

---

**Operator token lifetime (Q54).** A token set in `OPERATOR_AUTH_TOKEN` is valid until the process stops (its session record is set for 365 days). To revoke it, change `OPERATOR_AUTH_TOKEN` and restart; `POST /api/auth/rotate` revokes every token but also the configured one, so set the new value in the environment as well. RPC and Jito URLs are logged and returned by the API as scheme and host only, because their keys often sit in the path.

## 5. Emergency Procedures

Step-by-step procedures, with the commands: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

1. **Stop new buys:** the KILL SWITCH button, or `POST /api/execution/kill-switch` with `{"activate":true}`. It runs the shared emergency stop without the sells (`server/execution/emergencyStop.ts`): the kill switch goes on (every new buy is refused, PAPER included), auto is killed and set OFF once any buy it already had in flight has finished (the OFF is saved, so a restart comes back OFF), and LIVE is disarmed. It does not open the circuit breaker and does not stop exits. The switch itself is held in memory only, so a restart clears it. Reset it with `{"activate":false}`; the reply says whether the circuit breaker or a halt is still set. Resetting it does not turn auto back on or re-arm LIVE: a DEVNET_LIVE session ended by the switch needs LIVE armed and DEVNET_LIVE set again with `CONFIRM_AUTO_DEVNET`. Independently, a DEVNET_LIVE session that sees the coordinator disarmed or the kill switch on (at its next candidate, its 5 s monitor tick or a status read) turns itself OFF, so re-arming LIVE never revives it.
2. **Panic Liquidation:** `POST /api/wallet/panic-liquidate`. The shared emergency stop with the sells, in this order: kill switch on; auto killed, after waiting for a buy it already had in flight, so the position that buy opens is in the list; LIVE disarmed; then 100% of every active position of every mode is sold, one at a time, with `EMERGENCY_PANIC_LIQUIDATION` (a protective reason: it runs during a halt and is never refused as dust). A position whose exit was already in flight (for example a take-profit partial) is waited for, re-read and its remainder sold. The active positions are read once more after the loop and any new one (a manual buy that was already past the risk gate) is sold too. Read the reply: `Failed` lists what is still open, for example a sell still being verified (`SELL_PENDING_VERIFICATION`) or a position another process is selling (`EXIT_IN_PROGRESS`); run panic again until nothing fails. **Decision (Q53): panic sells everything the app holds in the wallet, including balances it adopted at startup (RECOVERED) that it never bought, and rows of every mode.** It is an emergency exit, so it does not apply the "only what auto bought" scoping that auto's own kill uses (R23). If you hold a balance you want kept, do not use panic; close positions one by one.
   - The WebSocket `PANIC_LIQUIDATE` action and Telegram `/panic_sell` run the same emergency stop and report the same lists.
   - Telegram `/panic_sell` is still not an emergency control you can rely on from a phone: Telegram cannot deliver it (no webhook is registered with Telegram and nothing polls for updates); it runs only when something posts it to `POST /api/telegram/webhook` with the operator token.
3. **Move devnet SOL off the throwaway key:** `solana transfer --url devnet --keypair <throwaway.json> <another devnet address> ALL`. Always pass `--url devnet`: the Solana CLI's default cluster is not devnet. The destination is another devnet key you control.

## 6. Settings that are stored but change nothing (checked against the code, Q34)

S215 removed the settings this section used to list (`snipeThresholdScore`, `autoForwardAlerts`, `webhookActive`, `isAutoSnipeEnvEnabled`, the per-caller auto-snipe marker, `requireMintRevoked`, `ENABLE_SYNTHETIC_SOCIAL`, `minConfidenceScore`, `requireConfluenceScore`, the unused wallet-config fields and `priorityTipSol`), and the 2026-10-22 audit removed `enabledStrategies` (four strategy toggles nothing read) and `allocatedSol` (a constant per capital tier, 0.07 or 5 SOL, that the wallet state echoed as `allocatedSol` / `availableSol` as if it were a wallet figure; `totalPortfolioValueUsd` now comes from the real balance and is null until one has been read). None of them was read. The auto-snipe score gate is the confluence threshold: default 70, starting from `CONFLUENCE_MIN_SCORE`, editable at runtime (`POST /api/auto/threshold`, S187).

| Setting | Where it lives | What it actually does |
|---|---|---|
| Two "auto snipe" switches | env `AUTO_SNIPE_ENABLED` (`server/auto/controller.ts`) and `isAutoSnipeEnabled` in `server/memecoinAggregator.ts` | Both are read. The env flag and the Auto panel's mode decide whether auto trades at all. The aggregator flag, when on, makes its 5-second loop submit hot callouts to the controller as candidates (only while the controller is not OFF); the controller drops any that the watch window never released, so in practice it buys nothing. No screen sets the aggregator flag any more (P1.4): the sniper screen shows the controller's mode, read-only, and only `POST /api/memecoins/config` can change the flag. |
| Sniper take-profit and stop-loss | `takeProfitPct` / `stopLossPct` in `server/memecoinAggregator.ts` (and the Sniper tab's take-profit box) | Nothing. Every exit follows the fixed rules in `server/exits/exitEngine.ts` (stop −20%, trailing stop from +15%, 33% sold at +30% and 33% at +60%, all sold after 30 min under +5%). The Sniper tab shows those rules, from `exitRules` in `GET /api/memecoins/config`; it used to show the two config numbers as "Auto TP / Auto SL". |

Also: the callout auto-snipe rules on the Hot Callouts screen are live: while the Auto controller is not OFF, `server/pumpfunService.ts` (`evaluateAutoSnipeTriggers`) reads them and submits matching callouts to the controller as candidates, and the controller applies its own gates (in SHADOW nothing is sent). Jito bundles are used only on mainnet-beta, which this build does not use. On devnet and localnet the app sends ordinary transactions with a priority fee.

## 7. What the live confirmation (`confirmLive`) is, and is not (S1)

While LIVE is armed, every route and socket action that can open a position (`/api/execution/trade`, `/api/memecoins/trade`, `/api/wallet/snipe`, `/api/pumpfun/callouts/snipe`, `/api/social/signals/snipe`, the WebSocket `SNIPE_PUMP_CALLOUT` and `SNIPE_MEMECOIN` actions, and the Telegram `/snipe` and `/buy` commands) refuses a request that does not carry `confirmLive: true`. The UI sends it only after the operator accepts a dialog that names the cluster.

It is a guard against an accidental or scripted one-click trade. It is **not** a security boundary: the flag is a value the client asserts, and anyone holding the operator token can send it. The operator token is the real authorisation. Closing a position and the kill switch are not behind it.

## 8. What score auto can reach, and what the seeded devnet token will and will not do (S5, S4)

The auto gate asks for a confluence score at or above the threshold in force (HOT also needs 3 of the watch window's 4 signals). The threshold is **editable** since S187 (`CONFLUENCE_MIN_SCORE`, or `POST /api/auto/threshold`, whole number 0 to 100, default 70, saved and restored after a restart since S222), and the table below was measured against the default 70. Lowering it buys more and weaker coins; the Auto panel warns below 50 and the replay backtest can show a what-if (`?minScore=N`). The second review measured the score on the production modules at SOL $150; the earlier notes that put the ceiling at 90, or at 81, were wrong, because Liquidity cannot reach its maximum (it is real SOL x price x 2, so it is 0 to 3 below about 30 SOL real and 6 only at graduation, when the curve is complete and untradable), and Social is always 0.

| Scenario (hand-built replays, not recorded feeds) | Score |
|---|---|
| 70 buyers in 36 s, 0.2-0.9 SOL each | 72-73 |
| same, 0.1 SOL flat | 68 |
| 10 buyers in 36 s | 26-38 |
| 130-buyer crowd, 0.13 SOL | 74 (READY, not HOT: velocity not rising at the tick) |
| 260-buyer crowd | 76 |
| 40 buyers in 60 s plus 8 sells (mainnet-like) | 55 |
| one whale plus 30 small buyers | 56 |
| the devnet seed, 30 x 0.01 SOL, all funded by one wallet | 35 |

What to expect: **72-76 at best with an ideal crowd, 62-68 for a typical launch, and 81 only at graduation.** Reaching 70 needs Momentum 20, OrderFlow 20 (no sells), Distribution at least 10 (about 35 near-equal buyers), Curve at least 13 and DevRisk 5 at the same tick. DevRisk is 5 live only when the creator's history report says seasoned wallet; a creator whose report is missing (lookup failed, or not back yet) scores 0 and is listed as missing data (P4.1; it used to borrow 5 points from a 0% dev holding). The scenarios above are replays, which know no creator address and still use the dev-holding stand-in, so the same crowd behind a fresh-wallet creator scores 5 lower live. So a quiet auto run is normal, not a fault.

The seeded devnet token (`scripts/devnet_seed.ts`) is **not expected to be bought by auto**: the seed funds all 30 buyers from one wallet, the watch window clusters buyers by who first funded them, so it sees one buyer (HOT needs 25 unique buyers), and the measured score is 35. That is by design here; funding the buyers through disguised intermediaries to get around the check was considered and rejected. The seed is useful for watching the board and the watch window, and for manual buys, not as proof that auto can trade.


## 9. What the localnet proof does not cover (S23)

- **Finality is instant.** The in-process validator reports `finalized` for every landed signature at once. The "sent and unknown" class (SELL_PENDING_VERIFICATION, blockhash expiry, processed to confirmed) therefore runs only through explicit fault injection. Step (g) of `npm run localnet:e2e` covers "landed but the response was withheld", not "sent and the outcome is unknown". Devnet is the first place those paths meet real latency.
- **The `localnet_*` methods are harness-only.** No production code calls them (`grep` finds none), so `localnet_setAccount` cannot be reached from the app.
- **A buyer funded through a program call is untested on localnet.** The funder lookup reads inner (CPI) system transfers, `createAccount` and `transferWithSeed` since P4.1, but only a fake Connection test covers that: the validator's `getTransaction` (`jsonParsed`) returns no inner instructions and parses only direct system transfers.

## 10. Persistence and journal limits (Q55, Q56)

- **There is no write-ahead log.** The BTC simulation engine and its decorative WAL were removed (S211). Position and order recovery come from SQLite plus the startup reconciliation against the chain. An `apex_engine.wal` file left over from an older build is not read and can be deleted.
- **No multi-statement transactions.** Each save is its own statement. The mark and exit-state writes now touch only their own columns and never a CLOSED row (S11), which closes the known race, but a crash between two statements of a trade can still leave the order and the position out of step; startup reconciliation repairs that against the chain.
- **Unbounded tables.** `positions`, `orders` and `transactions` are never pruned, and `loadPositions()` scans the table in several loops. Fine for a devnet session; revisit before long runs.
- **Operator alerts are in memory only.** A restart forgets them (the journal keeps the events they came from). The kill switch is memory-only too, but its trip is journalled: the next boot raises `KILL_SWITCH_WAS_ON` once, and LIVE refuses to arm until `POST /api/auto/resume {"clearHalt":true}` clears it. The net daily PnL floor's latch is memory-only as well; after a restart the 24 h window still holds the losses, so the next buy latches again.
- **The `orders` table is write-only.** A LIVE buy writes one row with status `SUBMITTED` and nothing updates or reads it (`saveOrder` is the only access); the transaction rows are the record.
- **Failed-sell retry waits (A3).** The retry deadline is stored as wall-clock time, and the wait also runs down on the monotonic clock, so a wall clock set back no longer holds a position's exits (stop-loss included) past the wait. A wall clock set forward still ends the wait early. The pending-sell window is still compared on the wall clock.
- **The database-writable check has a 1 s cache and a 16 MiB floor.** `isWritable()` commits a probe row and needs 16 MiB free (a judgement call, one constant); a disk that fills inside the 1 s is found by the buy's own PENDING-row write, which then throws. A read-only filesystem could not be reproduced in a test; that path is covered by a failing-write trigger only.
- **SOL price.** A reading outside $1 to $100,000, or more than 2x away from a reading under 10 minutes old, is rejected. The first price, the first after a 10-minute gap, and a price outside the 2x band are taken only when two sources agree within 5%; a disagreement shows on the reading. A price older than an hour no longer converts the USD net daily PnL floor at full trust: the floor is then min(3 x MAX_POSITION_SIZE_SOL, MAX_DAILY_LOSS_USD / last known price), which a stale price can only tighten. With no price ever read it is 3 x MAX_POSITION_SIZE_SOL, which is looser than the USD floor; LIVE buys still need a fresh price (`requireFreshPrice`), so this reaches PAPER and the auto kill trigger only.
- **Unresolved LIVE buys are counted at their worst case, and may be counted twice (3B).** A buy that landed but whose fill is unread has already left the wallet and is also reserved again, so one buy too many can be refused, never one too few; it clears when recovery adopts or times out the row. While any LIVE buy is unresolved the wallet audit keeps its old mark and tolerates a drop up to that worst case (plus rent), so a real drain of that size is not caught until the buy resolves; the window is bounded because recovery marks a row `TIMED_OUT` once its blockhash has expired. A reverted buy's fee is not journaled (a few thousand lamports, inside the audit's base tolerance).
