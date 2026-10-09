# Devnet end-to-end harness (R2)

Run: `npm run devnet:e2e` (from a machine that can reach https://api.devnet.solana.com).
Optional env: `DEVNET_RPC_URL` (must not look like mainnet), `DEVNET_MINTS=<comma list of active pump.fun devnet mints>`.

## Safety
- Devnet only. The preload `scripts/devnet_guard.cjs` wraps fetch and http/https request/get, logs every attempt to stderr
  and throws on anything matching /mainnet|jito\.wtf/i.
- The harness sets its own environment and never reads `.env`: `SOLANA_RPC_URL` devnet, `JITO_BLOCK_ENGINE_URL=http://127.0.0.1:9`
  (dead port, forces the RPC fallback), `ENABLE_RPC_FALLBACK=true`, `JITO_MAX_RETRIES=1`, `JITO_RETRY_INTERVAL_MS=200`,
  `APEX_DB_PATH` and `SIGNER_KEYPAIR_PATH` in a fresh temp directory, `ALLOW_LIVE_REAL_MONEY_TRADING=false`.
- It aborts unless `getGenesisHash()` equals the devnet hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. Only then does it set
  `ALLOW_LIVE_REAL_MONEY_TRADING=true`, in-process.
- The keypair is a throwaway generated in the temp directory. The repo keypair is never used. If the address cannot be
  funded by airdrop the harness prints the address, runs only the simulate stage, and exits 1 (UNFUNDED).
  A 0.01 SOL buy needs about 0.115 SOL or more because of the 10% spendable ceiling.

## Stages
1. Simulate BUY with `sigVerify:false, replaceRecentBlockhash:true` (PumpCurveService LIVE state, calculateBuyQuote, txBuilder).
2. (a) BUY 0.01 SOL through the real ExecutionCoordinator: Jito fails, RPC fallback, CONFIRMED, db tokenQuantityRaw == on-chain ATA balance.
3. (b) close 50%. (c) close 100% (ATA closed, about 0.00203928 SOL rent back). Every signature is checked with getTransaction and printed as a Solscan `?cluster=devnet` link.
4. (d) forced revert: a buy with maxSolCost of 1 lamport, sent with skipPreflight, must land with an error.
5. (e) a second submit with an already recorded orderId must add no transaction row.
6. (f) a child process is killed right after `sendRawTransaction` returns; a second process on the same scratch DB runs startupReconciliation and must find the position.

## Status
Written and type-checked, NOT run against devnet: the overnight sandbox proxy returns 403 for api.devnet.solana.com. Running it
offline fails closed at the genesis check (verified). Expect to adjust stage details on the first real run: the exact
`executeTrade` eligibility/sizer outcome for a fresh wallet, and the (f) recovery assertions. Treat any FAIL as a finding, not a harness bug, until read.
