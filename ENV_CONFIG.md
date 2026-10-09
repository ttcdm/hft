# APEX Quant HFT Workstation — Environment Configuration
> **Note for AI Studio Workspace:**
> The AI Studio file tree hides dotfiles (files starting with a `.`, like `.env`) by design.
> This file (`ENV_CONFIG.md`) is provided in the workspace so you can view, copy, and edit your configuration directly in the file tree.

---

### Current Active Configuration (`.env`)

```ini
# 1. Operator Dashboard Security (Generated)
OPERATOR_AUTH_TOKEN=<generate with: openssl rand -hex 32>

# 2. Local Hot Signer Path (POSIX 0600 protected)
SIGNER_KEYPAIR_PATH=/app/applet/.apex_trading_keypair.json

# 3. Environment Safety Override (Set to true when ready for real-money execution)
ALLOW_LIVE_REAL_MONEY_TRADING=false

# 4. Solana RPC Configuration
# Get a free fast RPC key at: https://dev.helius.xyz/ or https://www.quicknode.com/
# Never commit a real RPC URL: it embeds your API key.
SOLANA_RPC_URL=<your devnet RPC URL, including its API key>
SOLANA_WS_URL=<your devnet WebSocket URL, including its API key>

# 5. Jito MEV Bundle Transport
# Devnet has no Jito block engine: leave JITO_BLOCK_ENGINE_URL unset until you deliberately move to mainnet.
# JITO_BLOCK_ENGINE_URL=
MIN_JITO_TIP_SOL=0.002
MAX_JITO_TIP_SOL=0.050

# 6. Risk Limits & Capital Tier
CAPITAL_TIER=MICRO_10
MAX_SLIPPAGE_BPS=800
MAX_DAILY_LOSS_SOL=0.05
```

---

### Your Generated Trading Wallet
- **Public Key (Deposit Address):** `FYd91ZYjiJPZ2uMe5Rv1yUr5C66Q74DXqaScuRAxhc7g`
- **Explorer:** [https://solscan.io/account/FYd91ZYjiJPZ2uMe5Rv1yUr5C66Q74DXqaScuRAxhc7g](https://solscan.io/account/FYd91ZYjiJPZ2uMe5Rv1yUr5C66Q74DXqaScuRAxhc7g)
