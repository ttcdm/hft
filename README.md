# Apex Quant HFT - Autonomous Quantitative Execution Engine

A hardened, full-stack quantitative high-frequency trading (HFT) workstation and autonomous Solana execution engine with Jito MEV bundle protection, strict risk controls, and on-chain post-trade reconciliation.

> **Status: not live-ready. Devnet unverified.** Everything below runs in PAPER mode and is covered by tests, but no real transaction has been sent from this build: the devnet end-to-end harness (`npm run devnet:e2e`) has not been run against a live cluster. Do not fund a wallet for this system. See `FINAL-SUMMARY.md` and `FEATURE-MATRIX.md` for what is tested, partial or untestable.

---

## 🔒 Critical Safety & Architecture Principles

1. **Authoritative Execution Pipeline**: All trading paths (UI manual terminal, social signals scanner, Pump.fun hot callouts, and autonomous snipers) delegate exclusively to the central `ExecutionCoordinator`. No external component or background loop may independently generate or mutate positions.
2. **Safe Default (PAPER Mode)**: The engine defaults strictly to **PAPER simulation** upon startup. No real funds are ever placed at risk until explicitly armed.
3. **Strict Live Trading Safeguards**:
   - Live trading requires an armed state (`POST /api/execution/arm` with confirmation code `CONFIRM_LIVE_TRADING_RISK`).
   - A valid local keypair must be loaded and set to `READY` status.
   - Solana RPC health must be `HEALTHY` (latency verified, non-degraded).
   - Hardened Pre-Trade Risk limits must pass (daily loss limits, exposure limits, slippage caps, priority fee caps).
   - Any live trade execution must receive real on-chain quotes; fallback or synthetic prices are forbidden.
4. **Post-Trade On-Chain Reconciliation**: Positions are constructed from verified on-chain transaction outcomes and actual balance changes, not pre-trade estimates.
5. **Operator Authentication**: All state-mutating endpoints (arming, trades, keypair management, config updates, kill switches) require a valid operator session token.

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

Key environment variables:
- `PORT=3000`: Port bound by server (default: 3000)
- `SOLANA_RPC_URL`: Solana JSON-RPC node URL (this build is devnet/localnet only: `https://api.devnet.solana.com`, or a loopback URL for the local validator; mainnet is refused by the cluster guard)
- `JITO_BLOCK_ENGINE_URL`: Jito MEV Block Engine endpoint for private bundle routing (leave unset on devnet/localnet; there is no devnet block engine and mainnet endpoints are not supported)
- `DEFAULT_JITO_TIP_SOL`: Base validator tip in SOL included with bundles (optional floor of the tip policy, default `0.00018`; explicit tips are bounded by `MIN_JITO_TIP_SOL`/`MAX_JITO_TIP_SOL` and capped at 15% of trade notional)
- `PAPER_BANKROLL_SOL`: Paper-mode bankroll used for sizing when no real balance is known (default `0.07`)
- `PAPER_STRICT_GATES`: `1` makes paper trades reject unverified safety checks exactly like LIVE (default off: unverified checks pass in paper but are recorded on the fill)
- `CAPITAL_TIER`: `MICRO_10` (0.07 SOL / $10 risk-capped bankroll) or `INSTITUTIONAL` (3,500 SOL)
- `OPERATOR_AUTH_TOKEN`: Operator API token (min 16 characters; generate with `openssl rand -hex 32`). If unset, a volatile token is generated and printed at startup. Never commit it.
- `GEMINI_API_KEY`: Optional API key for AI Quant Diagnostics

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
PAPER Engine       LIVE Execution (Jito Bundle / RPC)
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
- Auto trading is owned by one controller (`server/auto/controller.ts`), **OFF on every start**. Modes: `OFF`, `SHADOW` (all gates, journals "would buy", nothing sent), `PAPER`, `DEVNET_LIVE` (devnet only, fixed 0.005 SOL, one open position, needs `ALLOWED_CLUSTER=devnet`, the coordinator armed LIVE and the confirmation code). There is no mainnet auto mode. It needs `AUTO_SNIPE_ENABLED=true`.
- Candidates must come out of the watch window (20-120s of real trade events) before any gate runs. Every decision, accept or reject, is a row in the `decisions` table with its reason.
- Kill switch: session budgets (5 buys, 0.02 SOL incl. fees, 15% loss, 4h), negative expectancy over the last 20 verified closed trades, 8 losses in a row, 2 slippage breaches, readiness red over 10s, and low wallet drop to SHADOW; an unexplained wallet balance change halts all trading including exits.
- Thresholds (holder concentration 20% top-10 / 5% creator, kill-switch limits, watch-window numbers) are conservative overnight defaults, **not validated on real launches**.

## 🛠️ Verification & Health

Commands (all run from the repo root; Node 22.5+ because of `node:sqlite`):

| Command | What it does |
| --- | --- |
| `npm ci` | install from the lockfile |
| `npm test` | the full suite (`vitest run`): **1169 tests in 88 files**, all passing at the time of writing |
| `npm run localnet:e2e` | end to end against an in-process LiteSVM validator (real pump binaries, loopback RPC): see `scripts/localnet/README.md`. Not a real cluster. |
| `npm run lint` | ESLint (0 errors, 172 warnings) plus `tsc --noEmit` |
| `npm run build` | frontend + `dist/server.cjs` |
| `npm run smoke` | boots `dist/server.cjs` on a random port and checks `/`, `/api/health`, login, session and the `/ws/engine` handshake |
| `npm run devnet:e2e` | the devnet end-to-end harness. **Not run in CI or in the build sandbox (no devnet access).** Devnet only; refuses mainnet |

- **Health Check Endpoint**: `GET /api/health`
- **System Diagnostics**: `GET /api/execution/diagnostics`
- **Engine Status**: `GET /api/engine/status`
- **Auto-snipe**: `GET /api/auto/status`
