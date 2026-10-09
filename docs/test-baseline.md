# Test baseline

Measured on `overnight/integration` at A6 (`cf927ea`) plus R0 (`package-lock.json`), Node 22, with the
real `@solana/web3.js`, `@solana/spl-token`, `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk`
from the lockfile (not the hand-written stubs). No `.env`, no network to Solana (the sandbox proxy blocks it).

| Check | Before D1 | After D1 |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | 0 errors |
| `npx eslint .` | 0 errors, 203 warnings | 0 errors, 203 warnings |
| `npx vitest run` | 8 failed / 774 passed (782), 40 files | 4 failed / 778 passed (782) |

## The 8 failures before D1

| # | Test | Class | Cause | Action |
|---|---|---|---|---|
| 1-3 | `adversarialGen2SecurityConcurrencyM1` 5.2, 5.3, 5.6 | broken test | `new ExecutionCoordinator()` probes `Connection.getSlot` on construction. The tests only mocked transaction lookups, so with a real SDK the probe hit the network, RPC health stayed `DISCONNECTED` and `startupReconciliation()` returned `OFFLINE`. The old stub always answered slot 1000, which hid this. | Fixed in D1: the Probe 5 `beforeEach` spies on `Connection.prototype.getSlot` and `getBalance`. |
| 4 | `tier1/features21_25` F25.5 | broken test | Read `.agents/ORIGINAL_REQUEST.md`. `.agents/` is git-ignored, so the file does not exist in a clean checkout. The tracked copy is `ORIGINAL_REQUEST.md` in the repo root. | Fixed in D1: test reads the root file. |
| 5 | `tier2/boundaries16_20` B16.4 | contract conflict (needs Mike) | Asserts the Jito tip economic cap is 25% of notional. `executionConfig.ts` has 15%. A6 reverted the working-tree 25% edit, so code and committed tests disagree. | Not changed. Mike decides 15% or 25%, then the code or the three tests change. |
| 6 | `tier5/jitoMevBundlesAndRpcFallback` JMB-2 | contract conflict (needs Mike) | Same 25% vs 15% cap. | Not changed. |
| 7 | `phase3_stress_challenge` B07/B24 urgency multipliers | contract conflict (needs Mike) | Same 25% vs 15% cap (comment says "25% = 2.5M"). | Not changed. |
| 8 | `phase1_remediation` B16 | bug (code) | The test expects `const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'`. Committed `server.ts` defaults the bind host to `0.0.0.0`, which exposes the unauthenticated API on the LAN. | Fixed by package A1 (bind host resolution, default `127.0.0.1`). |

No failure is a facade. Facade tests (tests that assert on a local stand-in and never import the real module) are
a separate problem: see `scripts/find_facade_tests.ts` and package D2.

## Findings from the run that are not failures

- Tests that construct `ExecutionCoordinator` (about 10 files) start real RPC calls. Without a mock they use
  `SOLANA_RPC_URL` or the code default, so on a machine with a `.env` they talk to whatever cluster it names. Package R1
  removes the mainnet defaults, but tests should still mock the connection. Not fixed here beyond Probe 5.
- `dotenv.config({ override: true })` lets a repo `.env` override the shell. See package R1.
- The old suite result (`5 failed / 808 passed`) in earlier notes was measured on a different base and is not comparable.
