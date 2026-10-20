# Environment variables

Every variable the server reads (`server.ts` and `server/`), what it defaults to, where it is read, and what value is safe on devnet. Copy `.env.example` to `.env` and set only what you need. A variable already set in the real environment wins over `.env`. `tests/env_docs.test.ts` fails if the server reads a name that is missing here, or if this page lists a name nothing reads, so the page cannot quietly drift.

**Devnet only.** The cluster guard refuses mainnet. Nothing on this page asks you to point the app at mainnet or to enable real-money trading. Use throwaway devnet keys and never commit a `.env`, a keypair, or an RPC URL that carries an API key.

Values are read as strings. Booleans mean the exact text `true` unless the row says otherwise. Most settings treat a blank value as unset; `APEX_RETENTION_DAYS` does not (blank becomes `0`, which turns pruning off), so leave a line out rather than leaving it blank when you are unsure.

## Operator settings

| Variable | Default | Read in | Devnet-safe value and notes |
|---|---|---|---|
| `ALLOWED_CLUSTER` | `devnet` | `server/pumpfunService.ts`, `server/solana/clusterGuard.ts` | `devnet`, or `localnet` with `LOCALNET_GENESIS_HASH`. Any value except `localnet` and `mainnet-beta` means devnet. `mainnet-beta` is accepted only so a read-only server can watch mainnet: while it is set, arming LIVE, every trade and every send are refused. Do not set it for trading: this project is devnet only. |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | `server/solana/clusterGuard.ts` | A devnet URL or a loopback URL. A URL that names mainnet is replaced by the devnet default. Never commit one with an API key in it. |
| `ALLOW_LIVE_REAL_MONEY_TRADING` | off (anything but `true`) | `server/execution/coordinator.ts`, `server/solana/readOnly.ts` | Leave `false`. Only the devnet harness sets it, in-process, after checking the genesis hash. Read-only mode refuses to start with it on. |
| `APEX_READ_ONLY` | off | `server/solana/readOnly.ts` | `true` for watch-only mode. Startup refuses if any signing key is configured. |
| `OPERATOR_AUTH_TOKEN` | none: a volatile token is generated at start | `server/middleware/auth.ts` | 16+ characters, `openssl rand -hex 32`. Never commit it. |
| `OPERATOR_PASSWORD` | none (password login off) | `server/middleware/auth.ts` | Optional. Enables password login that returns a session token. |
| `SIGNER_KEYPAIR_PATH` | `.apex_trading_keypair.json` in the working directory | `server/middleware/filePermissions.ts`, `server/solana/signer.ts` | A throwaway devnet key, mode 0600. |
| `OPERATOR_PRIVATE_KEY` | none | `server/solana/signer.ts` | Overrides the keypair file. Better left unset. Throwaway devnet key only. |
| `SOLANA_PRIVATE_KEY` | none | `server/solana/signer.ts` | Same as `OPERATOR_PRIVATE_KEY` (the second one tried). Better left unset. |
| `PORT` | `3000` | `server.ts` | `APP_PORT` wins if set; a `PORT` of `8080` is ignored. |
| `APP_PORT` | none | `server.ts` | Overrides `PORT`. |
| `BIND_HOST` | `127.0.0.1` | `server/middleware/auth.ts` | Loopback unless `ALLOW_PUBLIC_BIND=true`; otherwise ignored with a warning. |
| `ALLOW_PUBLIC_BIND` | off | `server/middleware/auth.ts` | Leave `false` unless you need to reach the operator API from another machine. |
| `ALLOWED_ORIGINS` | none | `server/middleware/auth.ts` | Comma-separated browser origins allowed besides localhost and the request host. |
| `CORS_ORIGIN` | none | `server/middleware/auth.ts` | Fallback for `ALLOWED_ORIGINS`. |
| `APP_URL` | none | `server/middleware/auth.ts` | Second fallback for `ALLOWED_ORIGINS`. |
| `AUTO_SNIPE_ENABLED` | off | `server/auto/controller.ts`, `server/pumpfunService.ts` | Must be `true` before the auto-snipe pipeline runs at all; the controller still starts in mode OFF. |
| `AUTO_MANAGE_RECOVERED` | off | `server/execution/coordinator.ts` | `true` lets the exit ladder manage positions rebuilt after a restart; otherwise they only get the hard stop. |
| `CONFLUENCE_MIN_SCORE` | `70` | `server/signals/confluenceThreshold.ts` | Whole number 0 to 100. Starting value of the confluence buy threshold; the operator can change it at runtime. An invalid value is ignored with a warning. |
| `MIN_LIQUIDITY_USD` | `2000` | `server/solana/executionConfig.ts` | Eligibility floor in USD. Devnet curves hold a few dollars, so a devnet run needs a lower value (the 2026-10-10 round trip used `5`). Honoured off mainnet only. |
| `MAX_POSITION_SIZE_SOL` | `0.02` (MICRO_10) or `1.50` | `server/solana/executionConfig.ts` | Upper limit for one order, including the editable snipe amount and auto order size. |
| `MAX_DAILY_LOSS_USD` | `2.50` (MICRO_10) or `250.00` | `server/solana/executionConfig.ts` | Daily loss limit in USD. (`MAX_DAILY_LOSS_SOL` appears in old notes and is not read.) |
| `MAX_SLIPPAGE_BPS` | `800` | `server/solana/executionConfig.ts` | Risk engine slippage cap (8%). |
| `PRIORITY_FEE_MICROLAMPORTS` | `25000` | `server/solana/executionConfig.ts` | Priority fee on ordinary transactions. |
| `CAPITAL_TIER` | `MICRO_10` | `server/solana/executionConfig.ts` | `MICRO_10`, `INSTITUTIONAL` or `CUSTOM`. Picks the defaults above. |
| `PAPER_BANKROLL_SOL` | `0.07` | `server/solana/executionConfig.ts` | Paper bankroll. A PAPER auto session may spend up to 10 times this. |
| `PAPER_STRICT_GATES` | off | `server/solana/executionConfig.ts` | `1` or `true`: paper rejects unverified safety checks like LIVE. |
| `DEMO_MODE` | off | `server/memecoinAggregator.ts`, `server/pumpfunService.ts` +2 | `true` loads fake callers and synthetic social data. Demo only. |
| `ENABLE_RPC_FALLBACK` | off | `server/solana/executionConfig.ts` | `true` falls back to plain RPC when a Jito bundle fails. On devnet RPC is already the only transport. |
| `RPC_FALLBACK_TIMEOUT_MS` | `15000` | `server/solana/executionConfig.ts` | Timeout of the RPC fallback. |
| `RPC_REQUEST_TIMEOUT_MS` | `1500` | `server/solana/rpcConnection.ts` | Per-request timeout of the trading RPC connection (every buy, sell, mark read and confirm poll the coordinator makes). A request with no answer by then is aborted; a read (and a read answered with HTTP 429) is tried once more at once, a send is not (its outcome is unknown and the send watch decides). web3.js's own 429 retry with sleeps is off. The account and signature scans no sell waits on (`getProgramAccounts`, `getSignaturesForAddress`, `getTransaction`, `getTokenLargestAccounts`, `getTokenAccountsByOwner`) get 10 s, or this value when it is longer. Raise it for a slow RPC; a large value lets one stuck call hold that sell for that long. |
| `BUNDLE_CONFIRM_TIMEOUT_MS` | `15000` | `server/solana/executionConfig.ts` | How long to wait for a bundle to confirm. |
| `STARTUP_GRACE_PERIOD_MS` | `300000` | `server/execution/coordinator.ts` | Initialisation grace period after start. |
| `JITO_BLOCK_ENGINE_URL` | none (Jito off) | `server/solana/clusterGuard.ts` | Leave unset: devnet has no block engine. A URL that names mainnet is refused. |
| `DEFAULT_JITO_TIP_SOL` | `0.00018` | `server/solana/executionConfig.ts` | Fallback tip in SOL, used only when no tip-floor reading and no order size is available (a normal buy takes a size-scaled tip, at least `MIN_JITO_TIP_SOL`, at most 15% of the order). Falls back to `JITO_TIP_SOL`, then `JITO_DEFAULT_TIP_LAMPORTS`. While Jito is off the coordinator forces the tip to 0, so no tip transfer is sent. |
| `JITO_TIP_SOL` | none | `server/solana/executionConfig.ts` | Second choice for the tip floor. |
| `JITO_DEFAULT_TIP_LAMPORTS` | none | `server/solana/executionConfig.ts` | Third choice for the tip floor, in lamports. |
| `MIN_JITO_TIP_SOL` | `0.00015` | `server/solana/executionConfig.ts` | Lower clamp for the tip (an explicit or computed tip is raised to at least this). |
| `MAX_JITO_TIP_SOL` | `0.05` | `server/solana/executionConfig.ts` | Upper clamp for the tip. |
| `JITO_TIP_ACCOUNT` | a built-in tip account | `server/solana/executionConfig.ts` | Only used when Jito is on. |
| `JITO_MAX_RETRIES` | `2` | `server/solana/executionConfig.ts` | Bundle retries. |
| `JITO_RETRY_INTERVAL_MS` | `1000` | `server/solana/executionConfig.ts` | Delay between bundle retries. |
| `JITO_PROBE_INTERVAL_MS` | `15000` | `server/solana/executionConfig.ts` | Block engine health probe interval. |
| `APEX_DB_PATH` | `apex_workstation.db` in the working directory | `server/db/dbPath.ts` | SQLite file. Point scratch runs at a scratch path. |
| `APEX_LOCK_DIR` | `~/.apex/locks` | `server/system/instanceLock.ts` | Where the per-key signer lock (`<pubkey>.lock`) lives. One process per signing key: a second process with the same key refuses to sign. Leave unset; tests point it at a scratch folder. The database lock is always `<APEX_DB_PATH>.lock`, next to the database. |
| `APEX_RETENTION_DAYS` | `90` | `server.ts` | Days of audit rows (risk decisions, auto decisions, journal) kept; `0` turns pruning off. |
| `APEX_RATE_LIMIT_BURST` | `120` | `server.ts` | Rate limiter burst size for `/api` routes. |
| `APEX_RECORD_MINT_MINUTES` | `30` (`180` read-only) | `server/backtest/recorderConfig.ts` | 1 to 1440. How long the recorder follows each launch. |
| `APEX_RECORD_MAX_TRADES_PER_MINT` | scales with the minutes above | `server/backtest/recorderConfig.ts` | 100 to 1,000,000. Trades kept per launch. |
| `APEX_RECORD_RETENTION_DAYS` | `14` | `server/backtest/recorderConfig.ts` | 1 to 365. Recorded launches older than this are pruned. |
| `APEX_RECORD_MAX_ROWS` | `3000000` (`6000000` read-only) | `server/backtest/recorderConfig.ts` | 10,000 to 200,000,000. The oldest launches are pruned past this. |
| `APEX_VERIFY_BLOCKHASH` | off (anything but `true`) | `server/solana/clusterGuard.ts`, `server/execution/coordinator.ts` | `true` makes every LIVE order ask the public devnet RPC (a second, independent source) whether the order's blockhash exists on devnet before it is signed. Catches a configured RPC that reports devnet but is really another network. Costs one extra call per live order (about the 120 to 160 ms a public devnet call takes). A buy that cannot be checked is refused; a sell is refused only if devnet says the blockhash is unknown, so a flaky public endpoint cannot block a stop-loss. Skipped on localnet. |
| `APEX_TRACING` | off (anything but `true`) | `server/observability/tracing.ts` | `true` turns on OpenTelemetry tracing: outbound http and fetch calls plus the trade pipeline steps become spans, sent only to a local OTLP endpoint. See [`TRACING.md`](TRACING.md). Off means no tracing code runs. |
| `APEX_TRACING_OTLP_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` | `server/observability/tracing.ts` | Where spans go. Must be loopback or the compose service `jaeger`; anything else makes tracing refuse to start. Span attributes never carry URL paths or queries. |
| `APEX_REPLAY_MAX_LAUNCHES` | `5000` | `server.ts` | 100 to 50000. Newest launches covered by one replay. |
| `APEX_WATCH_MAX_CANDIDATES` | `60` (`250` read-only) | `server/signals/capacity.ts` | 10 to 2000. How many launches the watch window follows at once. |
| `APEX_PUBLIC_FUNDERS` | none | `server/signals/watchWindow.ts` | Comma-separated addresses of wallets that fund thousands of unrelated traders (exchange hot wallets, a faucet), so the watch window does not treat their customers as one cluster. Empty by default. |
| `APEX_DISABLE_EXTERNAL_FEEDS` | off | `server.ts`, `server/pumpfunService.ts` +1 | `true` stops outbound market feeds (used by smoke and hermetic runs). |
| `GEMINI_API_KEY` | none | `server.ts` | Optional, for AI diagnostics. Nothing is sent without it. |
| `TELEGRAM_BOT_TOKEN` | none | `server/socialScanner.ts` | Optional Telegram bot. |
| `TELEGRAM_CHAT_ID` | none | `server/socialScanner.ts` | Optional Telegram chat. |
| `TWITTER_BEARER_TOKEN` | none | `server/socialScanner.ts` | Optional X (Twitter) scan. |
| `X_API_BEARER_TOKEN` | none | `server/socialScanner.ts` | Second choice for the X scan token. |

## Test and harness variables the server also reads

| Variable | Default | Read in | Devnet-safe value and notes |
|---|---|---|---|
| `APEX_ENV_FILE` | unset | `server/loadEnv.ts` | Set (even to an empty string) it replaces `.env`; an empty value loads no file. Used by smoke and localnet runs so they never read the real `.env`. |
| `TEST_DB_PATH` | unset | `server/db/dbPath.ts` | Test database path (`:memory:` under vitest). Takes priority over `APEX_DB_PATH`. |
| `VITEST` | unset | `server.ts`, `server/loadEnv.ts` | Set by the test runner; keeps the server from starting on import and switches `loadEnv` to `.env.test`. |
| `NODE_ENV` | unset | `server.ts`, `server/middleware/enterprise.ts` | `test` keeps the server from starting on import; `production` skips the development logger setup in `startServer` and turns debug logs off unless `DEBUG_LOGS=true`. |
| `APEX_CONTAINER` | unset | `server/middleware/auth.ts` | `true` in Docker: a generated volatile token is not printed to the logs. |
| `DEBUG_LOGS` | unset | `server/middleware/enterprise.ts` | `true` keeps debug logs on in production. |
| `APEX_PUMP_WS_ONLY` | off | `server/pumpfunService.ts` | `true` with `ALLOWED_CLUSTER=localnet` runs the feed from the websocket only (localnet harness). |
| `LOCALNET_GENESIS_HASH` | none | `server/solana/clusterGuard.ts` | Required with `ALLOWED_CLUSTER=localnet`. Must differ from the public cluster hashes. |
| `LOCALNET_SOL_PRICE_USD` | none | `server/market/solPriceService.ts` | Fixed SOL price in USD for a local validator, which has no market. |

## Listed in `.env.example` but not read by the server

| Variable | Why it is still there |
|---|---|
| `SOLANA_WS_URL` | The server does not read it (the websocket address is derived from `SOLANA_RPC_URL`). It stays in `.env.example` because `tests/phase1_remediation.test.ts` expects it. Remove both when that test is updated. |

## Where `docker-compose.yml` differs

`docker-compose.yml` passes a few variables through that the server does not read (`MEMECOIN_SNIPER_ENABLED`, `BINANCE_API_KEY`, `BINANCE_API_SECRET`), and it defaults `DEFAULT_JITO_TIP_SOL` to `0.005` where the code's default is `0.00018` (Jito is off on devnet, so the tip is forced to 0 and this default is unused). These are flagged, not changed here; a docs-only pass does not edit deployment config.

In the image, `APEX_DB_PATH` is `/app/data/apex_workstation.db` and `SIGNER_KEYPAIR_PATH` is `/app/data/.apex_trading_keypair.json` (set in the `Dockerfile`); compose mounts the named volume `apex-data` at `/app/data`. Compose does not pass `OPERATOR_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY` or `SIGNER_KEYPAIR_PATH` and has no `env_file`, so the container starts with no signer (PAPER).

## Script-only variables

Read by files under `scripts/`, not by the server. The harness READMEs (`scripts/DEVNET_E2E_README.md`, `scripts/localnet/README.md`) say how each script is run.

| Variable | Used by |
|---|---|
| `DEVNET_RPC_URL` | `scripts/devnet_e2e.ts`: RPC for the devnet harness (must not look like mainnet). |
| `DEVNET_MINTS` | `scripts/devnet_e2e.ts`: comma list of active devnet mints. |
| `DEVNET_AIRDROP_ONCE` | `scripts/devnet_e2e.ts`: `1` allows one airdrop. |
| `APEX_E2E_SCRATCH` | `scripts/devnet_e2e.ts`: scratch directory. |
| `APEX_SCRIPT_KEEP_TEST_DB_PATH` | `scripts/scriptEnv.ts` (via `hermeticEnv`): `true` keeps an exported `TEST_DB_PATH`. Otherwise every script that imports `hermeticEnv` drops it (it would beat the script's `APEX_DB_PATH`). `hermeticEnv` also always empties `APEX_ENV_FILE`, removes `OPERATOR_PRIVATE_KEY` and `SOLANA_PRIVATE_KEY`, and defaults `APEX_DB_PATH` to a scratch file and `SIGNER_KEYPAIR_PATH` to a file that does not exist. |
| `APEX_SCRIPT_ALLOW_REPO_STATE` | `scripts/scriptEnv.ts` (via `hermeticEnv`): `true` lets a script run with `./apex_workstation.db` as its database or `./.apex_trading_keypair.json` as its key. Without it the script exits with code 2. |
| `SEED_RPC_URL` | `scripts/devnet_seed.ts`: RPC for the devnet seed script. |
| `SEED_FUNDER_KEYPAIR_PATH` | `scripts/devnet_seed.ts`: funder keypair. |
| `SEED_PROOF_BUYERS` | `scripts/localnet/seed_proof.ts`: buyers to simulate. |
| `AUTO_RUN_DIR` | `scripts/localnet/auto_run.ts`: run directory. |
| `RUN_SECONDS` | `scripts/localnet/auto_run.ts`: how long to run. |
| `KEEP_UP` | `scripts/localnet/auto_run.ts`: keep the validator up after the run. |
| `LOCALNET_PORT` | `scripts/localnet/run_validator.ts`: validator port. |
| `LOCALNET_ACCOUNTS_DIR` | `scripts/localnet/validator.ts`: account fixtures. |
| `LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS` | `scripts/localnet/validator.ts`: initial virtual reserves. |
| `LOCALNET_DUMP_CREATE_LOG` | `scripts/localnet/e2e.ts`: dump the create log. |
| `LOCALNET_TRACE` | `scripts/localnet/e2e.ts`: trace output. |
| `LOCALNET_VERBOSE` | `scripts/localnet/e2e.ts`: verbose output. |
| `FIXTURE` | `scripts/visual/click_through.cjs`: `1` uses the seeded fixture. |
| `WIDTHS` | `scripts/visual/click_through.cjs`: viewport widths. |
| `OUT` | `scripts/visual/click_through.cjs`: output directory. |
| `CHROMIUM_PATH` | `scripts/visual/click_through.cjs`: browser binary. |
| `PLAYWRIGHT_PATH` | `scripts/visual/click_through.cjs`: Playwright location. |
