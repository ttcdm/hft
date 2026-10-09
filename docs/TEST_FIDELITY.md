# What the tests actually prove

Passing `npm test` means the units behave as specified **against mocks of their collaborators**. It does not mean the system trades correctly on a cluster. Three levels exist:

| Level | Where | Real | Mocked |
|---|---|---|---|
| Unit / module | most of `tests/*.test.ts` | the module under test | RPC, network, sometimes sibling modules |
| Mock-level "Tier 5" | `tests/e2e/tier5/{jitoMevBundlesAndRpcFallback,liveProductionReadinessGates,liveTradingWorkflowsAndPanicExit,realVsPaperExecutionGuarantees}.test.ts` | coordinator wiring | the signer, the transports, `canExecuteLive`, `riskEngine.evaluateOrder`, the reconciler, curve state. Several of them stub the very gate they are named after, so they certify call wiring, not the gate. |
| Localnet end to end | `npm run localnet:e2e` | HTTP API, auth, RPC client, signer, builder, pump/fee binaries (LiteSVM), reconciler, DB, restart recovery | the validator is LiteSVM, not solana-test-validator; the SOL price is a fixture; the Global account is patched to 30 SOL curves |

Nothing here has run on a real cluster from CI. The devnet harness (`npm run devnet:e2e`) is the only path to that and needs network and a funded throwaway key.

Tests no longer share mutated singleton state: `tests/setup/devnetGuard.ts` snapshots and restores the coordinator's private fields, the pump curve caches and the planted callouts around every test.

## Network hermeticity (K1b)
Under vitest `SOLANA_RPC_URL`, `SOLANA_WS_URL` and `JITO_BLOCK_ENGINE_URL` all point at the closed loopback port 9, and `tests/setup/devnetGuard.ts` refuses every non-loopback `net.Socket.connect` (fetch, node-fetch, ws and tls all end there). A refused connection is recorded, and the `afterEach` hook fails the test that caused it even if the code under test swallowed the error. This is what makes a leak visible on an offline machine; before it, tests that silently reached `api.devnet`, DexScreener, pump.fun or Coinbase passed offline and failed (or hung) on a networked machine. The guard found one real cause: the `pumpFunService` singleton started its WebSocket feed and 5 s HTTP poll on import. It now starts only through `pumpFunService.startBackground()`, called by `startServer`.
