# Apex Quant HFT - Autonomous Quantitative Execution Engine

A hardened, full-stack quantitative high-frequency trading (HFT) workstation and autonomous Solana execution engine with Jito MEV bundle protection, strict risk controls, and on-chain post-trade reconciliation.

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
- `SOLANA_RPC_URL`: Solana JSON-RPC node URL (e.g. Helius, QuickNode, Triton, or Solana mainnet)
- `JITO_BLOCK_ENGINE_URL`: Jito MEV Block Engine endpoint for private bundle routing (e.g. `https://mainnet.block-engine.jito.wtf`)
- `DEFAULT_JITO_TIP_SOL`: Base validator tip in SOL included with bundles (optional floor of the tip policy, default `0.00018`; explicit tips are bounded by `MIN_JITO_TIP_SOL`/`MAX_JITO_TIP_SOL` and capped at 15% of trade notional)
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

## 🛠️ Verification & Health

- **Health Check Endpoint**: `GET /api/health`
- **System Diagnostics**: `GET /api/execution/diagnostics`
- **Engine Status**: `GET /api/engine/status`
- **TypeScript Check**: `npm run lint`
- **Build Verification**: `npm run build`

