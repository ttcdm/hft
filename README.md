# Apex Quant - Solana Pump.fun Trading Workstation

A full-stack workstation and automated execution engine for Pump.fun bonding-curve tokens on Solana. One `ExecutionCoordinator` owns every trade; risk gates, on-chain reconciliation and a persisted halt sit behind it. **Devnet and localnet only**: the cluster guard refuses mainnet.

> **Status: not live-ready. Devnet unverified.** Everything runs in PAPER mode and is covered by tests, and the full flow runs against an in-process LiteSVM validator (`npm run localnet:e2e`), but no real transaction has been sent from this build: `npm run devnet:e2e` has never been run against a live cluster. Do not fund a wallet for this system. What the tests do and do not prove is in [`docs/TEST_FIDELITY.md`](docs/TEST_FIDELITY.md); open decisions and unverified items are listed under "Needs Mike" in the overnight patch `INDEX.md`. This is not a latency-sensitive HFT system: there is no measured latency advantage, kernel bypass or co-location in the code.

---

## 🔒 Critical Safety & Architecture Principles

1. **Authoritative Execution Pipeline**: All trading paths (UI manual terminal, social signals scanner, Pump.fun hot callouts, and autonomous snipers) delegate exclusively to the central `ExecutionCoordinator`. No external component or background loop may independently generate or mutate positions.
2. **Safe Default (PAPER Mode)**: The engine starts in **PAPER simulation**; auto trading starts **OFF**. A live buy needs an explicit arm.
3. **Cluster guard (devnet or localnet only)**:
   - `ALLOWED_CLUSTER` defaults to `devnet`. Before any send the RPC's genesis hash must match the allowed cluster; a mainnet RPC URL or a mainnet genesis is refused, and the check fails closed if the genesis cannot be read. `ALLOWED_CLUSTER=localnet` (needs `LOCALNET_GENESIS_HASH`) is allowed for a local validator. There is no mainnet auto mode; do not set `ALLOWED_CLUSTER=mainnet-beta`.
   - A wrong-cluster RPC is also refused at arming time (`GET /api/execution/can-arm`), not only at the first send.
4. **Strict live safeguards**:
   - `ALLOW_LIVE_REAL_MONEY_TRADING=true` is required for any real send, and the harnesses set it only after asserting the cluster genesis.
   - Arming: `POST /api/execution/arm` with confirmation code `CONFIRM_LIVE_TRADING_RISK`, a loaded keypair in `READY` status, RPC health `HEALTHY` on the verified cluster, and no halt.
   - Hardened pre-trade risk limits (daily loss, exposure, slippage, priority fee caps) must pass. Live trades need real on-chain quotes; synthetic prices are refused.
   - **Kill switch**: `POST /api/execution/kill-switch` with an explicit `{"activate": true|false}` (anything else is a 400). Activating it also disarms live trading.
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

For live development with hot reloading:
```bash
npm run dev
```

---

### Option 2: Run with Docker / Docker Compose

**Prerequisites:** Docker and Docker Compose installed.

```bash
# Build and launch container in background
docker compose up -d --build

# View real-time logs
docker compose logs -f

# Stop the container
docker compose down
```

---

## ⚙️ Configuration (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Key environment variables (see `.env.example` and `ENV_CONFIG.md` for the rest):
- `PORT=3000`, `BIND_HOST` / `ALLOW_PUBLIC_BIND`: port and bind address (loopback by default)
- `OPERATOR_AUTH_TOKEN`: operator API token (min 16 characters; `openssl rand -hex 32`). If unset, a volatile token is generated and printed at startup. Never commit it. `OPERATOR_PASSWORD` optionally enables password login.
- `ALLOWED_CLUSTER`: `devnet` (default) or `localnet` (with `LOCALNET_GENESIS_HASH`). Mainnet is refused.
- `SOLANA_RPC_URL`: `https://api.devnet.solana.com` or a loopback URL for a local validator. `SOLANA_WS_URL` / `SOLANA_WS_RPC_URL` for the websocket.
- `ALLOW_LIVE_REAL_MONEY_TRADING`: leave `false`; only the devnet harness sets it, in-process, after checking the genesis hash.
- `SIGNER_KEYPAIR_PATH`: keypair file (default `.apex_trading_keypair.json`, mode 0600). Use only a throwaway devnet key. `OPERATOR_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` override it and are better left unset.
- `JITO_BLOCK_ENGINE_URL`: leave unset on devnet/localnet (there is no devnet block engine; devnet and localnet send plain transactions). `DEFAULT_JITO_TIP_SOL` is the tip floor (default `0.00018`; capped at 15% of trade notional).
- `AUTO_SNIPE_ENABLED=true`: required before the auto-snipe pipeline will run at all (default off; the controller then still starts in mode OFF).
- `AUTO_MANAGE_RECOVERED=true`: let the exit ladder manage positions rebuilt after a restart. Default off: recovered positions only get the hard stop.
- `PAPER_BANKROLL_SOL` (default `0.07`), `PAPER_STRICT_GATES=1` (paper rejects unverified safety checks like LIVE), `CAPITAL_TIER` (`MICRO_10` or `INSTITUTIONAL`).
- `DEMO_MODE=true`: loads fake callers and synthetic social data; never use it for anything but a demo.
- `APEX_ENV_FILE`: if set (even to an empty string) it replaces `.env`, so scripts and tests that spawn the server never read the real one. `APEX_WAL_PATH` moves the engine write-ahead log; `APEX_DISABLE_EXTERNAL_FEEDS=true` stops outbound market feeds (used by smoke).
- `GEMINI_API_KEY`: optional, for AI diagnostics.

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

- **CORS Restriction**: Only trusted local origins and designated cloud domains are permitted; permissive open wildcards are eliminated.
- **Circuit Breakers**: The engine automatically trips the circuit breaker after 3 consecutive RPC failures or when daily drawdown exceeds limits.
- **Keypair Protection**: Dedicated low-balance trading keypairs (`.apex_trading_keypair.json`) are stored with strict POSIX `0600` permissions and never exported over unauthenticated networks.
- **Audit Ledger**: All state transitions, lifecycle events, and emergency actions are recorded immutably in the SQLite Write-Ahead Log journal.

---

## 🏠 Home page and auto-snipe

- The home page is the Pump.fun token board: **New launches / Watching / Holding**, a SOL wallet strip, a bonding-curve depth ladder and trade tape for the selected token, and the auto-snipe panel. Unknown values show "—".
- Auto trading is owned by one controller (`server/auto/controller.ts`), **OFF on every start**. Change mode with `POST /api/auto/mode`, stop with `POST /api/auto/kill` (optionally `exitAll`). Modes: `OFF`, `SHADOW` (all gates, journals "would buy", nothing sent), `PAPER`, `DEVNET_LIVE` (devnet only, fixed 0.005 SOL, one open position, needs `ALLOWED_CLUSTER=devnet`, the coordinator armed LIVE and the confirmation code). There is no mainnet auto mode. It needs `AUTO_SNIPE_ENABLED=true`.
- Candidates must come out of the watch window (20-120s of real trade events) before any gate runs. Every decision, accept or reject, is a row in the `decisions` table with its reason.
- Kill switch: session budgets (5 buys, 0.02 SOL incl. fees, 15% loss, 4h), negative expectancy over the last 20 verified closed trades, 8 losses in a row, 2 slippage breaches, readiness red over 10s, and low wallet drop to SHADOW; an unexplained wallet balance change halts all trading including exits.
- Thresholds (holder concentration 20% top-10 / 5% creator, kill-switch limits, watch-window numbers) are conservative overnight defaults, **not validated on real launches**.

## 🛠️ Verification & Health

Commands (repo root; Node 22.5+ because of `node:sqlite`):

| Command | What it does |
| --- | --- |
| `npm ci` | install from the lockfile |
| `npm test` | the full suite (`vitest run`): 1255 tests in 103 files, all passing at the time of writing |
| `npm run lint` | ESLint (0 errors, 181 warnings) plus `tsc --noEmit` |
| `npm run build` | frontend + `dist/server.cjs` |
| `npm run smoke` | boots `dist/server.cjs` on a random port and checks `/`, `/api/health`, login, session and the `/ws/engine` handshake |
| `npm run localnet:e2e` | the full flow against an in-process LiteSVM validator (real pump binaries, loopback RPC, throwaway key, scratch DB, empty `APEX_ENV_FILE`): see `scripts/localnet/README.md`. 39 checks. Not a real cluster. |
| `npm run devnet:e2e` | the devnet harness (`scripts/DEVNET_E2E_README.md`). Needs network and a **throwaway** devnet key it generates itself; it aborts unless the genesis hash is devnet's, never uses the repo keypair, and airdrops at most once and only with `DEVNET_AIRDROP_ONCE=1`. **Not run yet.** |
| `FIXTURE=1 node scripts/visual/click_through.cjs` | Chromium click-through of the real UI on a seeded fixture (layout and values checks); set `WIDTHS`, `OUT` to choose viewports and output |

How the tests are set up (details in [`docs/TEST_FIDELITY.md`](docs/TEST_FIDELITY.md)):
- **Hermetic**: `vitest.config.ts` uses an in-memory DB, clears signer keys and live/auto flags, and points RPC, websocket and Jito at a closed loopback port; `tests/setup/devnetGuard.ts` refuses any non-loopback connection and fails the test that tried one. A shell export or a real `.env` cannot change a result.
- **Behaviour tests** (`tests/behaviour_http.test.ts`) start the real server on a scratch DB and throwaway key and assert outcomes over HTTP (auth required on every route, cluster guard, PAPER never sends, halt and kill switch).
- Unit tests still mock collaborators; they show units behave as specified, not that the system trades correctly on a cluster.

Health and status endpoints (operator token required except health): `GET /api/health` (public), `GET /api/execution/can-arm`, `GET /api/execution/readiness`, `GET /api/engine/status`, `GET /api/auto/status`.

## Removed and relabelled

Fabricated or unverifiable features were removed rather than hidden: the CEX price stream and the HFT panels, `/api/exchange/time`, `/api/order/submit` and `/cancel`, `/api/backtest/run`, random market-data fallbacks, and invented social confidence/sentiment. Backtests and Monte Carlo are labelled synthetic; the Rust tab's figures are marked unmeasured and the crate is not wired in. Old self-certifying reports are in `docs/archive/`.
