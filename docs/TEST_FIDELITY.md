# What the tests actually prove

Passing `npm test` means the units behave as specified **against mocks of their collaborators**. It does not mean the system trades correctly on a cluster. Three levels exist:

| Level | Where | Real | Mocked |
|---|---|---|---|
| Unit / module | most of `tests/*.test.ts` | the module under test | RPC, network, sometimes sibling modules |
| Behaviour over HTTP | `tests/behaviour_http.test.ts` | the whole server process (`tsx server.ts`), its HTTP API, auth, coordinator, risk engine, signer, DB, `.env` isolation | the RPC is a loopback stub that answers a few read methods and **records every call**, so a test can assert that nothing was sent; it is not a chain |
| Mock-level "Tier 5" | `tests/e2e/tier5/{jitoMevBundlesAndRpcFallback,liveProductionReadinessGates,liveTradingWorkflowsAndPanicExit,realVsPaperExecutionGuarantees}.test.ts` | coordinator wiring | the signer, the transports, `canExecuteLive`, `riskEngine.evaluateOrder`, the reconciler, curve state. Several of them stub the very gate they are named after, so they certify call wiring, not the gate. |
| Localnet end to end | `npm run localnet:e2e` | HTTP API, auth, RPC client, signer, builder, pump/fee binaries (LiteSVM), reconciler, DB, restart recovery | the validator is LiteSVM, not solana-test-validator; the SOL price is a fixture; the Global account is patched to 30 SOL curves |

Nothing here has run on a real cluster from CI. The devnet harness (`npm run devnet:e2e`) is the only path to that and needs network and a funded throwaway key.

Tests no longer share mutated singleton state: `tests/setup/devnetGuard.ts` snapshots and restores the coordinator's private fields, the pump curve caches and the planted callouts around every test.

## Network hermeticity (K1b)
Under vitest `SOLANA_RPC_URL`, `SOLANA_WS_URL` and `JITO_BLOCK_ENGINE_URL` all point at the closed loopback port 9, and `tests/setup/devnetGuard.ts` refuses every non-loopback `net.Socket.connect` (fetch, node-fetch, ws and tls all end there). A refused connection is recorded, and the `afterEach` hook fails the test that caused it even if the code under test swallowed the error. This is what makes a leak visible on an offline machine; before it, tests that silently reached `api.devnet`, DexScreener, pump.fun or Coinbase passed offline and failed (or hung) on a networked machine. The guard found one real cause: the `pumpFunService` singleton started its WebSocket feed and 5 s HTTP poll on import. It now starts only through `pumpFunService.startBackground()`, called by `startServer`.

## Behaviour tests and what they replaced (M1)
`tests/behaviour_http.test.ts` starts the real server on a scratch database and a throwaway key (`tests/helpers/liveServer.ts`) and asserts outcomes: HTTP status, refusal text, mode, and whether anything reached the RPC as `sendTransaction`/`simulateTransaction`. Where chain state matters (fills, balances, restart recovery) the check is still `npm run localnet:e2e`.

| Rule | Behaviour test | Weak test removed |
|---|---|---|
| An RPC that answers for the wrong cluster can never be armed on (found by this test: it could, the genesis hash was only checked at the first send) | `mainnet guard over HTTP` | none (new) |
| PAPER never sends | `PAPER never sends...` | none (new) |
| Kill switch refuses new trades, disarms LIVE, readiness refuses re-arm until reset | `PAPER never sends...`, `arming policy...` | Tier-5 PRG-10 |
| A halt journaled by one process is enforced by the next after a restart | `a halt journaled by one run...` | none (L8 unit test stays) |
| `ALLOW_LIVE_REAL_MONEY_TRADING` gate, exact confirmation code, disarm returns to PAPER | `arming policy...` | Tier-5 PRG-1, PRG-2, PRG-3 |
| Empty wallet and unreachable RPC make can-arm refuse with the reason | `arming policy...` | Tier-5 PRG-5, PRG-8 |
| LIVE fails closed when the curve cannot be read, and ignores the caller's price | `arming policy...` | Tier-5 RPG-3 |
| Every trading route needs a token and refuses junk / client-chosen provenance | `the real server enforces auth and input validation...` | A3 source walks: "validates its body", "requires operator auth", "no route reads provenance" |
| Every non-public route is 401 in every spelling; signer overwrite refused; no auto-provisioned session | `deny-by-default on the real server` | A1 source checks: gate mounted before the first route, no auto-provision, forceOverwrite text |
| The string "false" is false (`z.coerce.boolean` made `exitAll:"false"` sell everything) | `boolean fields are read strictly` | none (new) |

Still source-text or mock-level, in descending order of how much I would distrust them: the other Tier-5 suites (they stub the readiness gate or the curve, so they certify wiring), `c7_live_path` / `c4_stale_marks` / `k4_signal_timestamp` static checks of `coordinator.ts` / `server.ts` text, `l6_kill_switch_wired` (reads `App.tsx`; the browser check in `scripts/visual/` is the real one), and the WebSocket action checks in A3. They need a LIVE-armed localnet or a DOM environment to replace, which is why they are still here.
