# Test baseline

Measured on the `snapshot/integration-3f890ed` tree (commit `13c4570`, the cloud integration with the feed watchdog, the late-buy sell, the child proxy pass-through and the harness clean-up applied), Node 22, with the real `@solana/web3.js`, `@solana/spl-token`, `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk` from the lockfile, on 2026-10-26. No `.env`, and no network to Solana from the test processes (the test guard refuses it).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npx eslint .` | 0 errors, 145 warnings |
| `npm test` (`vitest run`) | 306 files, 2725 passed, 0 skipped, 0 failed |
| `npm run test:long` | 13 files, 47 passed |
| `npm run localnet:e2e` | 48/48 steps passed |
| `npm run test:facades` | 181 facade tests found, 181 in `tests/facade-baseline.json`, 0 new |

The same tree passed the Stage 3 gate on devnet on 2026-10-26 (harness steps l, m, n, o and p, and a 50-minute DEVNET_LIVE session); the report is in the project folder (`notes/stage3-gate-report.md`). `README.md` ("Status") says what that does and does not prove.

## How to read these numbers

- Facade tests (tests that assert on a local stand-in and never import the real module) are counted by `scripts/find_facade_tests.ts`, and a new one fails `npm run test:facades`.
- Tests that construct `ExecutionCoordinator` start real RPC calls unless the connection is mocked; the hermetic test config closes RPC, websocket and Jito on a loopback port so no test reaches a cluster. See `docs/TEST_FIDELITY.md`.
- Environment loading uses dotenv's default (a variable already set in the real environment wins, `server/loadEnv.ts`), and `vitest.config.ts` sets `APEX_ENV_FILE` to an empty value, so a real `.env` cannot change a result.
- The first baseline of this file (at A6, `cf927ea`) listed 8 failing tests and the causes; all of them have been fixed or removed since, and the table is not kept.
