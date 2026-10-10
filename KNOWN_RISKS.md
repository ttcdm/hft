# Apex Quant HFT Workstation — Known Risks & Operational Guidelines

This document outlines structural, economic, and operational risks inherent to automated high-frequency trading on Solana, together with required operational countermeasures.

---

## 1. Environmental & Network Risks

### 1.1 Public RPC Rate Limits & Slot Lag
* **Risk Description:** Free public Solana RPC nodes (such as `api.mainnet-beta.solana.com`) employ strict IP-level rate-limiting and can lag several hundred slots behind the cluster leader.
* **Operational Impact:** Transactions may encounter stale blockhash errors (`BlockhashNotFound`), and account balances or bonding curve state may be outdated.
* **Required Countermeasure:** For live trading, operators must configure a dedicated private RPC provider (e.g., Helius, Triton One, QuickNode) with sub-20ms WebSocket feeds to active cluster validators. Set `SOLANA_RPC_URL` and `SOLANA_WS_URL` in `.env`.

### 1.2 Jito Block Engine Connectivity & Tip Floors
* **Risk Description:** Jito bundle delivery relies on validator availability and competitive tip auction dynamics. In periods of high network congestion, tips below the dynamic floor are dropped by validators.
* **Operational Impact:** Bundles may fail to land within their valid slot window without on-chain execution.
* **Required Countermeasure:** 
  - Ensure `JITO_BLOCK_ENGINE_URL` is set to the nearest geographic endpoint (e.g., Frankfurt, New York).
  - Keep `JITO_DYNAMIC_TIP_FLOOR` enabled so the engine dynamically queries real-time tip percentiles (25th to 75th percentile).
  - The workstation automatically validates and defaults to base58 bundle encoding.
  - In LIVE mode, `jitoHealth` must be `HEALTHY`. A `NOT_CONFIGURED` or `UNHEALTHY` status prevents live arming.

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
  - The risk engine strictly enforces an 800 bps (8%) maximum slippage cap (`SLIPPAGE_TOO_HIGH`).
  - In live mode, all sensitive orders are routed via private Jito bundles with direct validator tips, completely bypassing the public mempool.

---

## 3. MICRO_10 Capital Allocation & Economic Risks

### 3.1 Tiny Bankroll Sensitivity (~0.07 SOL)
* **Risk Description:** At ~0.07 SOL total bankroll, fixed execution costs (SOL signature fee, ATA rent, priority fee, Jito tip) represent a substantial percentage of position size.
* **Operational Impact:** Indiscriminate trading can lead to severe fee drag even on winning trades.
* **Required Countermeasure:**
  - Hard per-trade position cap: $\le 10\%$ of spendable bankroll ($\approx 0.007\text{ SOL}$).
  - Sizing uses spendable bankroll: $\text{Spendable} = \text{Wallet SOL} - \text{Reserve} - \text{Pending Capital}$.
  - Pre-trade fee economics check: If projected fees exceed 20% of trade size, the trade is rejected (`EXPECTED_EDGE_BELOW_EXECUTION_COST`).
  - Dynamic trailing stops and take-profit ladders enforce fee awareness, preventing micro-dust executions.

---

## 4. Key Management & Host Security

### 4.1 Local Signer Isolation
* **Risk Description:** Compromise of the server host filesystem exposes unencrypted keypair files.
* **Operational Impact:** Potential unauthorized asset drainage.
* **Required Countermeasure:**
  - Always import trading keys via the local CLI:
    ```bash
    npm run signer:import -- /path/to/trading-keypair.json
    ```
  - The import script creates `.apex_trading_keypair.json` with POSIX `0600` permissions (readable and writable solely by the running user).
  - Key material is never transmitted to web browsers, client frontends, or WebSocket consumers.
  - Dedicate a dedicated low-balance trading wallet (0.07 SOL). Never use cold-storage or primary treasury wallets for automated execution.

### 4.2 Operator Authentication
* **Risk Description:** Unprotected HTTP mutation routes could allow unauthorized trade initiation or configuration changes.
* **Operational Impact:** Unauthorized live trades or parameter modifications.
* **Required Countermeasure:**
  - The application applies `requireOperatorAuth` to all state-modifying endpoints.
  - WebSocket telemetry enforces `CONNECT → AUTH_REQUIRED → authenticate → AUTHENTICATED`. Query strings are not accepted.
  - Set `APEX_OPERATOR_TOKEN` in `.env` to a high-entropy secret.

---

## 5. Emergency Procedures

1. **Immediate Execution Halt:** Engage the Hardware Kill Switch via the UI or `POST /api/live/disarm`. This halts order generation and trips the circuit breaker.
2. **Panic Liquidation:** Initiate sequential exit via `POST /api/order/panic-liquidate`. This disarms live trading first, then liquidates all active positions.
3. **Wallet Balance Sweep:** In the event of an infrastructure anomaly, transfer all remaining SOL out of the trading keypair to a designated cold wallet via standard CLI tools (`solana transfer`).

## 6. Settings that are stored but change nothing (checked against the code, Q34)

These can be set (some from the UI) and are saved, but no code path reads them to decide anything. Do not rely on them.

| Setting | Where it lives | What it actually does |
|---|---|---|
| `snipeThresholdScore` (Telegram config) | `server/socialScanner.ts` | Stored and returned only. The auto-snipe score gate is the confluence gate (70), set in the confluence engine. |
| `autoForwardAlerts` (Telegram config) | `server/socialScanner.ts` | Stored only. Nothing forwards alerts to Telegram. |
| `webhookActive` (Telegram config) | `server/socialScanner.ts` | Changes the word in the `/status` reply. No webhook is registered with Telegram. |
| `isAutoSnipeEnvEnabled()` | `server/pumpfunService.ts` | Defined, never called. |
| `isAutoSnipeSubscribed` / `toggleCallerAutoSnipe` | `server/pumpfunService.ts` | Flips a flag shown in the UI. No code buys because of it. |
| `requireMintRevoked` | `server/memecoinAggregator.ts` config | Accepted and stored. The mint-authority rule is enforced by the eligibility gate, not by this field. |
| `ENABLE_SYNTHETIC_SOCIAL` | `server/solana/executionConfig.ts` | Read into the config object, never consulted. |

Also: Jito bundles are used only on mainnet-beta, which this build does not use. On devnet and localnet the app sends ordinary transactions with a priority fee.
