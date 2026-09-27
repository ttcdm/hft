# APEX Quant HFT Workstation — Engineering & Testing Invariants

All agents operating in this repository must strictly adhere to the following architectural, bundling, and testing rules:

## 1. Module Bundling & ES/CJS Imports
- **Never use `createRequire(import.meta.url)` in TypeScript source code.** When the backend is bundled to CommonJS via `esbuild --bundle --format=cjs --packages=external`, `import.meta.url` compiles to `undefined`, causing `createRequire(undefined)` to throw fatal `ERR_INVALID_ARG_VALUE` at runtime.
- **Use standard static ES imports** (e.g., `import { ... } from '@pump-fun/pump-sdk';`). Esbuild cleanly transforms static imports to CommonJS `require()` calls without runtime warnings or errors.

## 2. Hermetic Test Isolation & Singleton Hygiene
- **Never rely on ambient environment state in unit tests.** Tests asserting negative readiness or unconfigured signers must never assume the host machine lacks private keys. Always isolate with deterministic test spies:
  ```typescript
  const signerSpy = vi.spyOn(localSigner, 'getStatus').mockReturnValue('NOT_CONFIGURED');
  ```
- **Never mutate private singleton properties directly.** Do not execute `(localSigner as any).setKeypair(dummySigner)`. Instead, use `vi.spyOn` mocks that are automatically restored in `afterEach(() => vi.restoreAllMocks())` to prevent state leakage when `fileParallelism: false`.
- **Maintain environment sanitation in `vitest.config.ts`.** Ensure `process.env.TEST_DB_PATH = ':memory:'` and delete ambient keypair variables (`OPERATOR_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`) so tests execute in an isolated sandbox.

## 3. Deterministic Functional Assertions (No Timing Flakiness)
- **Never assert execution time deltas in functional test suites.** Microbenchmark timing assertions (e.g., `expect(duration2).toBeLessThanOrEqual(duration1 + 1ms)`) are vulnerable to CPU scheduling jitter under multi-core load.
- **Assert deterministic invariants instead.** Verify functional correctness using deterministic PDA equality (`expect(pda1.equals(pda2)).toBe(true)`), state transitions, or cryptographic signature verifications.

## 4. Test Suite Integrity (Zero-Facade Policy)
- **Never test local mock lambdas.** Unit and E2E tests must never implement local arithmetic or dummy functions that simulate production logic inside the test body.
- **Always invoke real production modules.** Tests must import and exercise production classes (`CapitalSizer`, `ExitEngine`, `HardenedRiskEngine`, `PumpCurveService`, `EligibilityFilter`, `JitoTransport`) with realistic mock state.
