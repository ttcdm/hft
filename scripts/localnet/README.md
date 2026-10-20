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

## Test controls

Extra JSON-RPC methods (not part of the Solana RPC surface) let a test inject chain-level faults. Call them on the validator's
URL like any other method (`tests/helpers/localnetChain.ts` `v.rpc(...)`, or `rpcCall` in the scripts):

| Method | Params | Effect |
|---|---|---|
| `localnet_failNextSends` | `[count, message?]` | The next `count` sendTransaction calls fail with JSON-RPC error -32002 before reaching the bank (nothing lands). |
| `localnet_landThenFailNextSend` | `[]` | The next sendTransaction that reaches the bank is executed there (it lands, or fails on chain and pays its fee), then the HTTP reply is `502 Bad Gateway` with an HTML body. web3.js `sendRawTransaction` throws `502 Bad Gateway: ...`. One-shot; if that send is refused before the bank (a failed-send control, an expired blockhash) the control stays armed for the next one. Signatures are listed in `localnet_stats.landedThenFailed`. |
| `localnet_holdNextResponse` | `[]` | The next sendTransaction lands, but no HTTP reply is ever sent (process-kill tests). Signatures in `localnet_stats.held`. |
| `localnet_failNextReads` | `[count, method, address?, mode?]` | The next `count` calls of the read method `method` fail like an overloaded RPC. With `address` (base58) only calls whose params mention it count. `mode` `'jsonrpc'` (default): HTTP 200 with JSON-RPC error `-32005` ("node is behind / overloaded"); web3.js throws at once (`getBalance` → `failed to get balance of account ...`, `getSignatureStatuses` → `failed to get signature status`). `mode` `'http429'`: HTTP 429 with a JSON-RPC error body; web3.js retries a 429 itself (5 attempts, 0.5/1/2/4 s apart) and only throws `429 Too Many Requests` when every attempt failed or the `Connection` was built with `disableRetryOnRateLimit: true`; each attempt consumes one count. Rules for different methods or addresses stack; a new rule for the same method and address replaces the old one; `count` 0 clears it. Sends are refused (use `localnet_failNextSends`). |
| `localnet_frontrunNext` | `[base64Tx]` | That signed transaction lands immediately before the app's next sendTransaction. |
| `localnet_expireBlockhash` | `[]` | Expires the current blockhash (BLOCKHASH_EXPIRED paths). |
| `localnet_setAccount` | `[pubkey, {lamports, dataBase64, owner}]` | Writes an account straight into the bank (test setup only). |
| `localnet_stats` | `[]` | `{held, landedThenFailed, methods, unsupported, txs, slot}`. |

`tests/long/fault_controls.longtest.ts` proves each fault control against the app's real `SolanaRpcTransport`.
