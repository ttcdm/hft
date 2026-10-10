# Local validator end-to-end (K9)

`npm run localnet:e2e` starts three things and drives them:

1. `scripts/localnet/validator.ts`, a JSON-RPC server (plus a minimal `logsSubscribe` WebSocket) on 127.0.0.1 backed by **LiteSVM**.
   The real pump.fun, pump fee and PumpSwap program binaries and config accounts, dumped from devnet, are in
   `scripts/localnet/accounts/` (public chain data, no keys). It is **not** `solana-test-validator`: one in-process bank, a slot
   per transaction, everything final, no lookup tables. It refuses to bind anything but loopback.
2. The app itself (`server.ts`), booted with `ALLOWED_CLUSTER=localnet`, the validator's genesis hash, the validator's URL,
   an empty `APEX_ENV_FILE` (the real `.env` is never read), a throwaway key and a scratch database.
3. The driver, which calls the app's authenticated HTTP API (`/api/execution/arm`, `/trade`, `/close`, ...) and checks
   the database against the chain.

Safety: the faucet is the local validator's `requestAirdrop`; no remote host is contacted by the validator or the driver;
mainnet stays blocked by the cluster guard (`tests/k9_localnet_guard.test.ts`). `LOCALNET_SOL_PRICE_USD` supplies a labelled
`LOCALNET_FIXED` SOL/USD price because a local validator has no market.

The Global account is patched to production-sized curves (30 SOL initial virtual reserves, offset 81); set
`LOCALNET_INITIAL_VIRTUAL_SOL_LAMPORTS=1000000000` to keep the devnet value (curves complete after ~3.4 SOL).

The validator runs as its own process on purpose. Do not import the app's server modules into the same process as a
LiteSVM bank that has executed programs.
