# Devnet end-to-end harness (R2)

Run: `npm run devnet:e2e` (from a machine that can reach https://api.devnet.solana.com).
Optional env:
- `DEVNET_RPC_URL`: the devnet RPC to use (must not look like mainnet). **A private devnet endpoint is recommended**: the public `api.devnet.solana.com` rate-limits (429) the holder lookups the eligibility check needs, and the run then stops with the holder shares unknown. Set it in your shell for the run; the harness never prints it (the devnet guard logs scheme and host only, and error text is scrubbed of URLs), and never reads `.env`.
- `DEVNET_MINTS=<comma list of active pump.fun devnet mints>`: tried first.
- `DEVNET_NO_WAIVER=1`: forbid the holder-limit waiver described below.

## Safety
- Devnet only. The preload `scripts/devnet_guard.cjs` wraps fetch and http/https request/get, logs every attempt to stderr
  and throws on anything matching /mainnet|jito\.wtf/i.
- The harness sets its own environment and never reads `.env`: `SOLANA_RPC_URL` devnet, no `JITO_BLOCK_ENGINE_URL`
  (as on devnet normally, so the RPC transport sends; a dead Jito URL makes readiness report Jito OFFLINE and arming refuses), `ENABLE_RPC_FALLBACK=true`, `JITO_MAX_RETRIES=1`, `JITO_RETRY_INTERVAL_MS=200`,
  `APEX_DB_PATH` and `SIGNER_KEYPAIR_PATH` in a fresh temp directory, `ALLOW_LIVE_REAL_MONEY_TRADING=false`.
- It aborts unless `getGenesisHash()` equals the devnet hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. Only then does it switch the
  real-money environment variable on, inside its own process (it is never set in your shell or in any file).
- The keypair is a throwaway generated in the temp directory. The repo keypair is never used. If the address cannot be
  funded the harness prints the address, runs only the simulate stage, and exits 1 (UNFUNDED).
- Faucet: no airdrop by default and never a retry loop. `DEVNET_AIRDROP_ONCE=1` sends exactly one request for an empty wallet.
  Trade size scales to the balance (about 8% of it, max 0.01 SOL, because of the 10% spendable ceiling); below 0.03 SOL it does not trade.

## Stages
1. Simulate BUY with `sigVerify:false, replaceRecentBlockhash:true` (PumpCurveService LIVE state, calculateBuyQuote, txBuilder).
2. (a) BUY (scaled, see above) through the app's `executionCoordinator` singleton (the one server.ts uses; the harness no longer builds a second coordinator): sent through the RPC transport, CONFIRMED, db tokenQuantityRaw == on-chain ATA balance.
3. (b) close 50%. (c) close 100% (ATA closed, about 0.00203928 SOL rent back). Every signature is checked with getTransaction and printed as a Solscan `?cluster=devnet` link.
4. (d') forced revert through the app (`scripts/devnet_e2e_steps.ts`): after the 30 s per-mint cooldown from (a), one `executionCoordinator.executeTrade` buy runs with `PumpCurveService.calculateBuyQuote` wrapped by the harness so the quote's `maxInputLamports` (the max-SOL-in bound the pump buy enforces) is 1 lamport; the wrapper is restored right after. The app signs and sends it and the program rejects it (pump error 6002 on localnet). Pass: lifecycle REVERTED, the signature failed on chain, a REVERTED BUY transaction row, no position, and an immediate second buy refused with `Cooling down after recent execution failure (Ns remaining)` (the 15 s `cooldownAfterFailedTradeMs`) adding no row.
5. (e') after that cooldown, two sequential `executeTrade` buys of the same mint: the first CONFIRMED, the second refused before anything is sent (`POSITION_ALREADY_OPEN`), exactly one open position; the harness then closes it so (f) starts flat.
6. (f) a child process is killed right after `sendRawTransaction` returns; a second process on the same scratch DB runs startupReconciliation and must find the position.

## Notes
- The LIVE buy request is built by `liveBuyRequest` in `scripts/devnet_funding.ts` (typed as `ExecuteTradeRequest`, with `signalTimestamp` set when the request is made; LIVE refuses a trade without one).

- Boot-time services: the harness does not run `server.ts`, so it starts what a LIVE buy needs from there. The SOL/USD price service is started and its first reading awaited (public Coinbase / CoinGecko / Binance hosts; no price is ever made up; if none can be read the run stops at "SOL/USD price"). The coordinator's own constructor starts the RPC heartbeat, startup reconciliation, the exit monitor and the mark feed. `MIN_LIQUIDITY_USD=0` is set because devnet pump curves hold cents (honoured off mainnet only). The top-10 and creator holding limits are fixed, so a mint that fails them is refused: pick another with `DEVNET_MINTS`.

## Tracing and output
- `APEX_TRACING=true` works here: the harness starts tracing before it makes any connection, as `server.ts` does (the local-only OTLP rule still applies; see the tracing notes in the README).
- With `APEX_VERIFY_BLOCKHASH=true` the log shows `[S210] independent blockhash check passed for the BUY` when the check ran.
- Everything printed goes through a redactor, and the devnet guard prints a private RPC host as `<rpc>`. When the crash-after-submit child does not reach the send, step (f) says how it ended and shows its last lines instead of a raw dump.

## Which mint it trades
The app's eligibility filter refuses a creator holding over 5% or a top-10 share over 20%, and devnet test mints often fail that. So the harness probes mints (the listed ones, then the pump program's recent activity, at most 25) until one clears both limits, and uses it. It builds the eligibility report itself from fresh holder data just before the buy, with the app's own `EligibilityFilter`, so a rate-limited lookup inside the coordinator cannot refuse a mint it already screened.
If none clears, it falls back to the readable mint with the lowest creator share and **waives only the creator and top-10 checks, in the harness's report, logging `WAIVER` lines with the real values**. The app's filter is not changed. A share it could not read is never waived, and neither is any other failed check. The mint is saved in the scratch directory so the crash and recover processes use the same one.

## Status
Written and type-checked, NOT run against devnet: the overnight sandbox proxy returns 403 for api.devnet.solana.com. Running it
offline fails closed at the genesis check (verified). Expect to adjust stage details on the first real run: the exact
`executeTrade` eligibility/sizer outcome for a fresh wallet, and the (f) recovery assertions. Treat any FAIL as a finding, not a harness bug, until read.
