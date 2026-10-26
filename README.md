# Apex Quant - Solana Pump.fun Trading Workstation

A full-stack workstation and automated execution engine for Pump.fun bonding-curve tokens on Solana. One `ExecutionCoordinator` owns every trade; risk gates, on-chain reconciliation and a persisted halt sit behind it. **Devnet and localnet only**: the cluster guard refuses mainnet.

> **Status: not live-ready. Devnet: one manual round trip verified.** Everything runs in PAPER mode and is covered by tests, and the full flow runs against an in-process LiteSVM validator (`npm run localnet:e2e`). On 2026-10-10 a manual round trip on real devnet passed through the app's own API and dashboard (0.01 SOL buy, 50% sell, 100% close of a Token-2022 pump coin; recorded quantity matched the chain at each step; token account closed). It needed `MIN_LIQUIDITY_USD=5`, because devnet curves hold only a few dollars and the $2,000 default rejects them all; that override is honoured on devnet and localnet only and ignored on mainnet-beta. A 30-minute DEVNET_LIVE auto-snipe window placed no trades: every devnet launch it watched was rejected (creator sold, no trades, or score far below 70). The devnet harness (`npm run devnet:e2e`) has been run on the Mac since then (code comments and tests cite runs 4 to 16); those results are not kept in this repository and the cloud sessions that edit these documents cannot reach devnet, so this README does not restate them. Do not fund a mainnet wallet for this system. What the tests do and do not prove is in [`docs/TEST_FIDELITY.md`](docs/TEST_FIDELITY.md); open decisions and unverified items are listed under "Needs Mike" in the overnight patch `INDEX.md`. What score auto can realistically reach (72-76 at best, 62-68 typical) and why the seeded devnet token will not be bought are in [`KNOWN_RISKS.md`](KNOWN_RISKS.md) section 8. This is not a latency-sensitive HFT system: there is no measured latency advantage, kernel bypass or co-location in the code.

---

## 🔒 Critical Safety & Architecture Principles

1. **Authoritative Execution Pipeline**: All trading paths (UI manual terminal, social signals scanner, Pump.fun hot callouts, and autonomous snipers) delegate exclusively to the central `ExecutionCoordinator`. No external component or background loop may independently generate or mutate positions.
2. **Safe Default (PAPER Mode)**: The engine starts in **PAPER simulation**; auto trading starts **OFF**. A live buy needs an explicit arm.
3. **Cluster guard (devnet or localnet only)**:
   - `ALLOWED_CLUSTER` defaults to `devnet`. Before any send the RPC's genesis hash must match the allowed cluster; a mainnet RPC URL or a mainnet genesis is refused, and the check fails closed if the genesis cannot be read. A `mainnet-beta` value of `ALLOWED_CLUSTER` is accepted only so a read-only server can watch mainnet; while it is set, arming LIVE, `executeTrade` and every send refuse (`assertSendClusterAllowed`). `ALLOWED_CLUSTER=localnet` (needs `LOCALNET_GENESIS_HASH`) is allowed for a local validator. There is no mainnet auto mode; only a read-only server should use a `mainnet-beta` cluster value.
   - The database file remembers the genesis hash of the first verified RPC (`cluster_genesis_hash` in `app_settings`). After that, an RPC on another cluster fails the cluster check with `DB_CLUSTER_MISMATCH`, so that ledger is never reconciled or traded against another chain. To change clusters, point `APEX_DB_PATH` at a new file.
   - A wrong-cluster RPC is also refused at arming time (`GET /api/execution/can-arm`), not only at the first send.
4. **Strict live safeguards**:
   - The `ALLOW_LIVE_REAL_MONEY_TRADING` switch must be on before any send (the name is historical; on this project it gates devnet and localnet sends, nothing else). The in-process test harnesses turn it on only after asserting the cluster genesis; the repository's `.env.example` leaves it off.
   - Arming: `POST /api/execution/arm` with confirmation code `CONFIRM_LIVE_TRADING_RISK`, a loaded keypair in `READY` status, RPC health `HEALTHY` on the verified cluster, and no halt.
   - Hardened pre-trade risk limits (daily loss, exposure, slippage, priority fee caps) must pass. Live trades need real on-chain quotes; synthetic prices are refused.
   - **Kill switch**: `POST /api/execution/kill-switch` with an explicit `{"activate": true|false}` (anything else is a 400). Activating it also disarms live trading and sets auto OFF (after any buy in flight); resetting it turns neither back on. The switch is held in memory, so a restart clears it; the next boot then raises `KILL_SWITCH_WAS_ON` and LIVE refuses to arm until `POST /api/auto/resume {"clearHalt":true}` clears it. `POST /api/wallet/panic-liquidate`, the WebSocket `PANIC_LIQUIDATE` and Telegram `/panic_sell` run the same stop and then sell every active position. `POST /api/execution/close` always closes with the reason `Operator close` (the client's `reason` text is kept only as a journal note).
   - **Persisted halt**: a halt (for example an unexplained wallet balance change) survives a restart. While halted, buys are refused and the can-arm reasons say why; protective exits (stop-loss, trailing stop, manual close, panic) still run. An operator clears it with `POST /api/auto/resume {"clearHalt":true}`.
5. **Post-Trade On-Chain Reconciliation**: Positions are constructed from verified on-chain transaction outcomes and actual balance changes, not pre-trade estimates.
6. **Operator Authentication**: every `/api` route except `GET /api/health` and `POST /api/auth/login` requires an operator token (deny by default; the path is normalized first, so case, encoding and absolute-form tricks do not bypass it). The token is `OPERATOR_AUTH_TOKEN` (16+ characters); `OPERATOR_PASSWORD`, if set, enables password login that returns a session token. The server binds to loopback unless `ALLOW_PUBLIC_BIND=true` (then `BIND_HOST` is honoured).

---

## 🚀 Quickstart: Run Locally

### Option 1: Run with Node.js (Local / VPS)

**Prerequisites:** Node.js >= 22.5.0 and npm >= 10.0.0 installed (Node.js >= 22.5.0 is strictly required for native `node:sqlite` database persistence).

```bash
# 1. Install dependencies
npm install

# 2. Build production frontend & server bundle
npm run build

# 3. Start the production server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

**One server per database and per wallet.** Every guard against selling or buying twice lives in the server's memory, so two servers on one database or one signing key would both sell the same stop-loss. The server takes a lock file next to the database (`<APEX_DB_PATH>.lock`) before anything else starts, and one per signing key in `~/.apex/locks` (`APEX_LOCK_DIR`). A second server on the same database, port or key prints `INSTANCE_LOCKED` or the listen error and exits with code 1 before it reconciles, runs the exit loop or restores the auto mode. A lock left by a process that is no longer running is taken over on the next start. For a second copy (a smoke test, a scratch run) use its own scratch folder, database and throwaway key: `npm run smoke` does this.

For live development with hot reloading:
```bash
npm run dev
```

---

### Option 2: Run with Docker / Docker Compose

**Prerequisites:** Docker and Docker Compose installed.

```bash
# Compose refuses to start without an operator token (16+ characters). Put it in your shell or in .env next to docker-compose.yml.
export OPERATOR_AUTH_TOKEN=$(openssl rand -hex 32)

# Build and launch container in background
docker compose up -d --build

# View real-time logs
docker compose logs -f

# Stop the container (the data volume is kept)
docker compose down
```

What to expect from the container:
- The dashboard is at <http://127.0.0.1:3000>, published on the host's loopback only.
- It is devnet-only and starts in PAPER with no signer: compose passes a fixed list of variables (see `docker-compose.yml`) and does not load `.env` as a whole, so `OPERATOR_PRIVATE_KEY`, `SIGNER_KEYPAIR_PATH` and other `.env` settings outside that list do not reach it. A key generated or imported in the UI is saved in the volume.
- The database (and any such key) lives in the named volume `apex-data`, mounted at `/app/data`. It survives `docker compose down` and rebuilds; `docker compose down -v` deletes it.
- The image only runs the app. Tests and the localnet scripts (`npm run localnet:e2e` and friends) need `solana-test-validator` and the dev dependencies, so run them on the host.

---

## ⚙️ Configuration (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Key environment variables. [`docs/ENV.md`](docs/ENV.md) lists every variable the server reads, with defaults and devnet-safe values (a test keeps it in step with the code); `.env.example` is the starting file:
- `PORT=3000`, `BIND_HOST` / `ALLOW_PUBLIC_BIND`: port and bind address (loopback by default)
- `OPERATOR_AUTH_TOKEN`: operator API token (min 16 characters; `openssl rand -hex 32`). If unset, a volatile token is generated and printed at startup. Never commit it. `OPERATOR_PASSWORD` optionally enables password login.
- `ALLOWED_CLUSTER`: `devnet` (default) or `localnet` (with `LOCALNET_GENESIS_HASH`). LIVE arming, trading and sending on mainnet are refused. `mainnet-beta` is accepted only so a read-only server can watch mainnet.
- `SOLANA_RPC_URL`: `https://api.devnet.solana.com` or a loopback URL for a local validator. The websocket address is derived from it; `SOLANA_WS_URL` is not read by the server.
- `ALLOW_LIVE_REAL_MONEY_TRADING`: leave `false`; only the devnet harness sets it, in-process, after checking the genesis hash.
- `SIGNER_KEYPAIR_PATH`: keypair file (default `.apex_trading_keypair.json`, mode 0600). Use only a throwaway devnet key. `OPERATOR_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` override it and are better left unset.
- `JITO_BLOCK_ENGINE_URL`: leave unset on devnet/localnet (there is no devnet block engine; devnet and localnet send plain transactions). `DEFAULT_JITO_TIP_SOL` is the fallback tip (default `0.00018`, capped at 15% of trade notional); the tip floor is `MIN_JITO_TIP_SOL` (default `0.00015`), and the coordinator forces the tip to 0 while Jito is off.
- `AUTO_SNIPE_ENABLED=true`: required before the auto-snipe pipeline will run at all (default off; the controller then still starts in mode OFF).
- `AUTO_MANAGE_RECOVERED=true`: let the exit ladder manage positions rebuilt after a restart. Default off: recovered positions only get the hard stop.
- `PAPER_BANKROLL_SOL` (default `0.07`), `PAPER_STRICT_GATES=1` (paper rejects unverified safety checks like LIVE), `CAPITAL_TIER` (`MICRO_10` or `INSTITUTIONAL`).
- `DEMO_MODE=true`: loads fake callers and synthetic social data; never use it for anything but a demo. LIVE cannot be armed while it is on.
- `APEX_ENV_FILE`: if set (even to an empty string) it replaces `.env`, so scripts and tests that spawn the server never read the real one. `APEX_DISABLE_EXTERNAL_FEEDS=true` stops outbound market feeds (used by smoke).
- `GEMINI_API_KEY`: optional, for AI diagnostics.
- `APEX_READ_ONLY=true`: watch-only mode (see "Read-only mode" below).
- `CONFLUENCE_MIN_SCORE`: starting value of the confluence buy threshold, a whole number 0 to 100 (default `70`); the operator can change it at runtime (see below).
- `MIN_LIQUIDITY_USD`: eligibility floor in USD (default `2000`). Honoured on devnet and localnet only; ignored on mainnet-beta.
- `MAX_POSITION_SIZE_SOL`: upper limit for any single order, including the editable snipe amount and auto order size.
- `APEX_RECORD_MINT_MINUTES`, `APEX_RECORD_MAX_TRADES_PER_MINT`, `APEX_RECORD_RETENTION_DAYS`, `APEX_RECORD_MAX_ROWS`: how much the launch recorder keeps; `APEX_REPLAY_MAX_LAUNCHES` (100 to 50000, default 5000) caps one replay.

---

## 🎯 Authoritative Trading Pipeline

```text
Market Event / Callout
        ↓
Normalized Market State
        ↓
Eligibility Filter
        ↓
Signal Generation
        ↓
Hardened Risk Engine (Circuit Breakers & Limits)
        ↓
ExecutionCoordinator (Single Source of Truth)
   ↙              ↘
PAPER Engine       LIVE Execution (RPC; Jito bundle only if configured)
   ↘              ↙
On-Chain Reconciliation (Actual Balances & Fees)
        ↓
Persistent Position (Authoritative SQLite Store)
        ↓
Real Mark Price Feed (Bonding Curve / DexScreener)
        ↓
Exit & Dynamic Trailing Stop
        ↓
Final Reconciliation & Ledger Audit
```

---

## 🛡️ Security Hardening

What the code does, and where the limits are:

- **CORS and WebSocket origins**: REST requests are allowed from `localhost`, `127.0.0.1`, the request's own host, and origins listed in `ALLOWED_ORIGINS` (`server/middleware/auth.ts`). Other origins get no CORS headers.
- **Circuit breaker**: the risk engine opens the breaker and turns the kill switch on after 3 consecutive failed wallet-balance reads (`server/risk/riskEngine.ts`), and refuses buys once the net PnL of the last 24 hours (not since UTC midnight) reaches the floor set by `MAX_DAILY_LOSS_USD`; that refusal latches until an operator sends `POST /api/auto/resume {"clearDailyLossLatch":true}`, a flag separate from `clearHalt`. Only an operator closes the breaker: a kill-switch reset closes it once the latest balance read has succeeded.
- **Keypair file**: `.apex_trading_keypair.json` is written with POSIX `0600` permissions, and the app checks `.env` and the keypair for looser permissions. Use a throwaway devnet key only.
- **Audit trail**: auto decisions and trade records are rows in the SQLite database; see [`KNOWN_RISKS.md`](KNOWN_RISKS.md) section 10 for its limits.

---

## 🏠 Home page and auto-snipe

- The home page is the Pump.fun token board: **New launches / Watching / Holding**, a SOL wallet strip, a bonding-curve depth ladder and trade tape for the selected token, and the auto-snipe panel. Unknown values show "—".
- Auto trading is owned by one controller (`server/auto/controller.ts`), **OFF on a first start; after that the last mode and the confluence threshold come back on restart** (a saved `DEVNET_LIVE` comes back as `SHADOW`, so a restart never resumes live sending: arm and set it again; a mode that needs `AUTO_SNIPE_ENABLED=true` stays OFF without it). The order size, session budgets and callout rules are still in memory only. Change mode with `POST /api/auto/mode`, stop with `POST /api/auto/kill` (optionally `exitAll`). Modes: `OFF`, `SHADOW` (all gates, journals "would buy", nothing sent), `PAPER`, `DEVNET_LIVE` (devnet only, 0.005 SOL per order unless the operator changes it, one open position, needs `ALLOWED_CLUSTER=devnet`, the coordinator armed LIVE and the confirmation code). There is no mainnet auto mode. It needs `AUTO_SNIPE_ENABLED=true`.
- **Order sizes are editable.** One saved **snipe amount** sizes every manual snipe (default 0.01 SOL, minimum 0.001 SOL, at most `MAX_POSITION_SIZE_SOL`; `GET /api/snipe/limits` returns the limits). The auto trader has its own **order size** (`POST /api/auto/order-size`, default 0.005 SOL) that applies in PAPER and DEVNET_LIVE alike, so paper results match what live would do. An out-of-range value is refused with a reason, never clamped. Auto order size and budget are kept in memory and reset at restart.
- **Session spend cap.** `POST /api/auto/budget` edits the session budget. A DEVNET_LIVE session defaults to 5 buys and 0.02 SOL including fees. A PAPER session may turn its bankroll over: up to 50 buys and 10 times `PAPER_BANKROLL_SOL`. A PAPER limit never carries into real SOL.
- **PAPER auto-restore.** If a PAPER session is dropped to SHADOW only because readiness turned red, it comes back to PAPER by itself after readiness has stayed green for 60 seconds. Any other cause, and any operator choice, cancels the pending restore. DEVNET_LIVE is never restored automatically.
- **One confluence threshold.** The watch window's HOT gate, the buy gate and manual snipes all read the same score threshold. Its starting value is `CONFLUENCE_MIN_SCORE` (default 70); the operator changes it with `POST /api/auto/threshold` or the Auto panel (whole number 0 to 100, saved and restored after a restart, and the panel warns below 50). A lower threshold means more buys of weaker coins. See [`KNOWN_RISKS.md`](KNOWN_RISKS.md) section 8 for the scores that are actually reachable.
- Candidates must come out of the watch window (20-120s of real trade events) before any gate runs. Every decision, accept or reject, is a row in the `decisions` table with its reason and the release's `passingSignals`.
- **Release gates (P4.3).** A `READY` release (the window ran out without a HOT verdict) is bought only with concentration passing and at least 2 strong signals (`READY_TOO_WEAK` otherwise), and the `DEVNET_LIVE` auto mode never buys a score below 50 (`CONFLUENCE_DEVNET_LIVE_FLOOR`), whatever the threshold. The floor is an auto-buy gate only: a manual snipe, LIVE armed or not, is held to the plain threshold. A launch past 60% of its curve (tokens sold; `APEX_MAX_CURVE_PROGRESS_PCT`) is not bought: the window releases it `DEAD` `CURVE_TOO_FAR`, the controller drops a release past it (stage `curve`) and the coordinator refuses it on its fresh curve read, manual buys too. A release is a signal for 8 s in every mode, SHADOW included (`STALE_SIGNAL`); a queued release is kept 6 s. A refusal that only says "not now" (a cooldown, a stale read) no longer burns the mint for the session, and a watch release refused that way is tried again 2 s later while it is fresh. `npx tsx scripts/recorder_backtest/ready_strength.ts --recorded <db|jsonl>` prices the READY entries the new rule refuses against HOT entries on the app's own recordings.
- **The creator cluster is not demand.** In the watch window the creator, the create signer and every wallet whose first funder is one of them form one cluster. Their trades are left out of velocity, flow and net inflow (the board's net inflow column is the organic figure; `/api/watch` reports the cluster's own SOL as `creatorClusterBuySol` / `creatorClusterSellSol`), and a sell by any of them releases the launch `DEAD` with `CREATOR_SOLD`, also when the funder that ties a seller to the creator is learned after the sell. Funder coverage is measured over the 100 largest buyers by volume, and funder lookups for launches that are no longer watched are dropped. A seller's funder is looked up before the sell counts as organic, and the launch is held in the window while that lookup is outstanding; a seller whose funder cannot be read only fails the `buyers` signal, it does not release the launch `DEAD`.
- **Feed gaps.** When the pump log stream may have missed logs (the websocket closed, no slot heartbeat for 10 s, a slot jump, or an RPC switch), the feed shows `RECONNECTING` and every launch in the watch window is released `DEAD` with `FEED_GAP`, because a creator sell in the gap would never arrive. The status goes back to `ACTIVE` when the socket reopens or a slot arrives in order (after a slot jump, the slot after the jump); a gap opened by an RPC switch also ends on the first log from the new subscription. The feed telemetry counts the gaps (`feedGaps`, `lastFeedGap`). A switch of the RPC endpoint moves the log subscription and the creator lookups to the new endpoint. Launches quoted in a mint other than SOL are not watched (`nonSolQuoteSkipped`).
- **No mainnet HTTP feeds off mainnet.** The pump.fun and DexScreener HTTP pollers start only on a read-only server watching a `mainnet-beta` cluster value; on devnet and localnet the feed is the program log stream alone.
- Kill switch: session budgets (defaults for DEVNET_LIVE: 5 buys, 0.02 SOL incl. fees, 15% loss, 4h; a PAPER session gets 50 buys and spend up to 10 times the paper bankroll; the operator can edit buys and spend, not the loss or time limit), negative expectancy over the last 20 verified closed trades, 8 losses in a row, 2 slippage breaches, readiness red over 10s, and low wallet drop to SHADOW; an unexplained wallet balance change (DEVNET_LIVE wallet audit) halts every buy plus the take-profit and stale exits and sets auto OFF, while stop-loss, trailing stop, manual close and panic still run. Emergency procedures: [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- Thresholds (holder concentration 20% top-10 / 5% creator, kill-switch limits, watch-window numbers) are conservative overnight defaults, **not validated on real launches**.

## 👁️ Read-only mode

`APEX_READ_ONLY=true` makes the server watch a cluster and paper trade against what it sees; it cannot sign or send anything. Startup refuses if any signing key is configured (`OPERATOR_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, `SIGNER_KEYPAIR_PATH`, or a default `.apex_trading_keypair.json`) or if `ALLOW_LIVE_REAL_MONEY_TRADING=true`. While on: the signer loads no key and cannot generate or import one, every transport throws before touching the network, arming LIVE returns HTTP 409, and auto allows only OFF, SHADOW and PAPER. The threshold and order-size editors still work, because they change what is bought, not whether anything can be sent. Code: `server/solana/readOnly.ts`. A read-only server is allowed to watch mainnet (that is what accepting a `mainnet-beta` cluster value is for), because it can never sign or send on any cluster. Trading, paper or live, against real funds is still never done here: trading stays on devnet or localnet.

## 📼 Recording and replay backtest

The launch recorder saves every launch the watch window scores while the app runs against a pump.fun feed. `GET /api/backtest/recording` reports what is stored. `GET /api/backtest/replay` replays the auto trader's own rules over those recorded launches: the real watch window (same 20 s and 120 s timing), the real confluence engine and the real exit engine polled every 3 s, with fills, latency and costs from the same model the offline studies use (`server/backtest/costModel.ts`): the buy lands 1.5 s after the release and each sell 1.5 s after its decision, at the curve state then (both assumptions until the devnet latency measurement replaces them), the pump.fun fee (1.25% by default) is charged on the buy and on every sell, and every transaction sent pays the network fee, the priority fee and a 0.0001 SOL tip. Closed (realized) results and positions still open at the end are reported apart, and the report lists what it does not replay by the direction each gap moves the result. `?minScore=N` replays at another threshold without changing the live one. It covers the newest 5,000 launches by default (`APEX_REPLAY_MAX_LAUNCHES`), and the response says how many were replayed.

The replay does **not** include the eligibility filter (authorities, holder concentration), risk limits and capital sizing, slippage beyond the recorded price, or creator wallet history, so its result is optimistic by that much. With nothing recorded, there is no result. Recorder limits are in `server/backtest/recorderConfig.ts`; the oldest launches are dropped once the row or age limit is reached. Code: `server/backtest/`.

## 🛠️ Verification & Health

Commands (repo root; Node 22.5+ because of `node:sqlite`):

| Command | What it does |
| --- | --- |
| `npm ci` | install from the lockfile |
| `npm test` | the full suite (`vitest run`): 290 files, 2301 passed, 1 skipped, 0 failed, the last full run reported in the patch notes (3A, on this tree before the docs pass). The docs tests added since (`tests/s3j_docs_constants.test.ts`, the diagram-order tests in `tests/architecture_docs.test.ts`) were run on their own; the full suite has not been re-run since |
| `npm run lint` | ESLint (0 errors, 146 warnings, measured with the 3J patch applied) plus `tsc --noEmit` (0 errors) |
| `npm run build` | frontend + `dist/server.cjs` |
| `npm run smoke` | boots `dist/server.cjs` on a random port and checks `/`, `/api/health`, login, session and the `/ws/engine` handshake |
| `npm run test:long` | the long behaviour tests (`tests/long/*.longtest.ts`, about 2.5 min): the real server against the LiteSVM validator for the exit loop, crash recovery, the guards and the validator's fault controls. Runs in CI after `npm test`; `tests/test_globs.test.ts` fails if a test file under `tests/` is in neither suite. |
| `npm run localnet:e2e` | the full flow against an in-process LiteSVM validator (real pump binaries, loopback RPC, throwaway key, scratch DB, empty `APEX_ENV_FILE`): see `scripts/localnet/README.md`. 39 checks. Not a real cluster. |
| `npm run devnet:e2e` | the devnet harness (`scripts/DEVNET_E2E_README.md`). Needs network and a **throwaway** devnet key it generates itself; it aborts unless the genesis hash is devnet's, never uses the repo keypair, and airdrops at most once and only with `DEVNET_AIRDROP_ONCE=1`. Cloud sessions cannot run it (see Status). |
| `FIXTURE=1 node scripts/visual/click_through.cjs` | Chromium click-through of the real UI on a seeded fixture (layout and values checks); set `WIDTHS`, `OUT` to choose viewports and output |

How the tests are set up (details in [`docs/TEST_FIDELITY.md`](docs/TEST_FIDELITY.md)):
- **Hermetic**: `vitest.config.ts` uses an in-memory DB, clears signer keys and live/auto flags, and points RPC, websocket and Jito at a closed loopback port; `tests/setup/devnetGuard.ts` refuses any non-loopback connection and fails the test that tried one. A shell export or a real `.env` cannot change a result.
- **Behaviour tests** (`tests/behaviour_http.test.ts`) start the real server on a scratch DB and throwaway key and assert outcomes over HTTP (auth required on every route, cluster guard, PAPER never sends, halt and kill switch).
- Unit tests still mock collaborators; they show units behave as specified, not that the system trades correctly on a cluster.

Health and status endpoints (operator token required except health): `GET /api/health` (public), `GET /api/execution/can-arm`, `GET /api/execution/readiness`, `GET /api/auto/status`.

## Removed and relabelled

Fabricated or unverifiable features were removed rather than hidden: the CEX price stream and the HFT panels, `/api/exchange/time`, `/api/order/submit` and `/cancel`, `/api/backtest/run` (synthetic price paths), random market-data fallbacks, and invented social confidence/sentiment. The Backtest screen now replays recorded real launches (see above). The BTC market-maker simulator with its console (S211), the unused Rust crate (S212) and the unrendered Monte Carlo view (S213) were removed. Old self-certifying reports are in `docs/archive/`.
