# Devnet Verification Plan — APEX Quant HFT Workstation

Date: 2026-10-09
Scope: verify that the trade paths (buy, partial exit, full exit with rent reclaim, failures and retries) actually land on-chain and reconcile, using **Solana devnet only**.

## Hard safety rules (from Mike)

- No mainnet RPC, no mainnet Jito, no funded mainnet keypair.
- `ALLOW_LIVE_REAL_MONEY_TRADING` is never set to `true` against mainnet.
- Only a fresh throwaway devnet keypair, funded by devnet airdrop.
- Any step that would touch mainnet stops and waits for Mike.

## How the rules are enforced in this run

1. **Never run from the repo root with the repo `.env`.** `server.ts`, `coordinator.ts` and the devnet script all call `dotenv.config({ override: true })`, so the repo `.env` overrides anything set on the command line. The repo `.env` points `SIGNER_KEYPAIR_PATH` at an existing keypair and `JITO_BLOCK_ENGINE_URL` at **mainnet** Jito. Every run here uses a scratch working directory with its own sanitized `.env`:
   - `SOLANA_RPC_URL=https://api.devnet.solana.com`
   - `SIGNER_KEYPAIR_PATH=<scratch>/devnet-throwaway.json` (generated fresh, airdropped)
   - `JITO_BLOCK_ENGINE_URL=http://127.0.0.1:9` (unroutable, so no bundle can leave the machine)
   - `ENABLE_RPC_FALLBACK=true`, `APEX_DB_PATH=<scratch>/devnet.db`
2. **Network guard preload.** A `--require` / `--import` preload wraps `fetch`, `http.request` and `https.request` and throws on any host matching `mainnet`, `jito.wtf`, or `api.mainnet-beta.solana.com`. Every blocked attempt is logged as evidence of where the code tries to reach mainnet.
3. **Genesis check before any signing.** Each harness asserts `getGenesisHash() === EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (devnet) and exits if not.

## Pre-flight findings (before running anything)

| # | Finding | Impact |
|---|---------|--------|
| F1 | `node_modules/@solana/web3.js`, `@solana/spl-token`, `@pump-fun/pump-sdk`, `@pump-fun/pump-swap-sdk` are **hand-written stubs** (3 files, 12–20 KB each, no `resolved`/`integrity` in `.package-lock.json`). The fake `Connection` returns a constant blockhash, `getBalance` = 1 SOL, `sendRawTransaction` = `"5VerBQ...txsignature"`, every signature "confirmed". `VersionedTransaction.serialize()` emits only signatures. `PublicKey.isOnCurve()` is always `true`, so PDA/ATA derivation does not match the real chain. | Unit/E2E tests and the built server run against a fake Solana. Nothing in the current install can produce or land a real transaction. Any "devnet verified" claim made with this install is not real. |
| F2 | `package-lock.json` is not present in the repo (AGENTS.md §6 requires it). | Installs are not reproducible; the stubs could not have been caught by lockfile integrity. |
| F3 | `scripts/test_devnet_execution.ts` calls `connection.getGenesisHash()`, which the stub does not implement. `tsconfig.json` (uncommitted change) now excludes `scripts/`, so typecheck no longer catches it. | The existing devnet script cannot run on the current install. |
| F4 | `PumpCurveService.fetchPumpMarketState` (pumpCurve.ts ~L577) silently falls back to `https://api.mainnet-beta.solana.com` in PAPER mode when the mint is missing on the configured RPC. | Paper mode on devnet can quietly read mainnet state. Read-only, but violates "no mainnet RPC"; blocked by the guard in this run. |
| F5 | `JitoTransport.getTipFloorLamports` always calls mainnet `bundles.jito.wtf`; `probe()` marks Jito `HEALTHY` even when that fetch fails, because errors are swallowed. | Jito "health" in readiness is not a real health signal. |
| F6 | LIVE buys/sells always go to Jito first; the RPC path is only the fallback (`ENABLE_RPC_FALLBACK=true`). Jito has no devnet block engine. | On devnet, every LIVE trade must exercise "Jito fails → retries → RPC fallback". |
| F7 | AGENTS.md §5 says `POST /api/auth/session`; `server.ts` implements `GET /api/auth/session` (login is `POST /api/auth/login`). | Smoke test uses the real routes. |
| F8 | Uncommitted working-tree edits change trade math: buy fee math in `pumpCurve.ts` (net SOL = input − fees, instead of the ceil-division form) and `minBase` in `pumpSwapService.ts` now uses `uiBase`. | Results below are for the working tree as-is. |

Devnet facts checked by raw JSON-RPC (no repo code): genesis `EtWTRABZ…krZBG`; Pump.fun program `6EF8rr…wF6P` deployed with live traffic today; Pump global `4wTV1Y…xnjf` exists; PumpSwap AMM `pAMMBa…fXEA` and fee program `pfeeUx…ojVZ` deployed. No Jito block engine on devnet.

## What can and cannot be proven on devnet

| Path | Provable on devnet? | Notes |
|------|--------------------|-------|
| Build, typecheck, lint, unit/E2E suite | Yes (local) | But tests run on stubs (F1), so they prove logic against fakes, not chain behaviour. |
| Boot `dist/server.cjs`, HTTP + WS smoke | Yes (local) | Same caveat: the binary links the stub web3.js. |
| Signed SOL transfer lands + confirms | Yes, **only with real `@solana/web3.js`** | |
| Pump.fun bonding-curve BUY lands + reconciles | Yes, **only with real libs** and a live devnet bonding curve (pick one with recent trades, or create a token on devnet) | |
| Partial SELL (e.g. 50%) + remaining tokens reconcile | Yes, real libs | |
| Full SELL with ATA close + rent reclaim (~0.00204 SOL) | Yes, real libs | Verify ATA closed and SOL delta includes rent. |
| Jito bundle submit / landing / bundle status | **No** | No devnet block engine. Only the failure + retry + fallback behaviour is provable. |
| Jito failure → bounded retries → RPC fallback, no double fill | Yes | Jito URL is unroutable, so retries fail deterministically. |
| Reverted tx (slippage / min-out violated) recorded as REVERTED | Yes | Force with an impossible `minSolOutput` / tiny slippage. |
| Restart recovery of a PENDING tx | Yes | Kill after submit, restart, check `startupReconciliation`. |
| PumpSwap (graduated pool) sells | Maybe | Needs a graduated devnet pool; best-effort only. |
| Mainnet economics (tip floor, competition, MEV, real slippage) | **No** | Out of scope by rule. |

## Steps

### Phase A — local, safe, no code changes
1. `npm run typecheck`, `npx eslint .`, `npx vitest run` (full suite, unfiltered).
2. `npm run build` → `dist/server.cjs`.
3. Boot `node dist/server.cjs` from scratch cwd with sanitized `.env`, `PORT=3001`, network guard preloaded. Check startup logs (no unhandled rejections, no `ERR_INVALID_ARG_VALUE`, no module errors), `GET /`, `GET /api/health`, `POST /api/auth/login` + `GET /api/auth/session`, WS `ws://127.0.0.1:3001/ws/engine` auth handshake, clean SIGTERM.

### Phase B — devnet E2E (needs Mike's go-ahead, see Decision)
Requires the real Solana/Pump libraries. Proposed: copy the repo (minus `node_modules`, `.env`, DBs, keypairs) into a scratch folder, `npm install` the exact versions already in `package.json` there, and run everything from that copy. The repo itself is not touched.

4. Generate throwaway keypair in scratch, airdrop 2 devnet SOL, assert genesis.
5. Run `scripts/test_devnet_execution.ts` (self-transfer) → signature.
6. Pick a live devnet Pump.fun bonding curve (recent `buy` activity on `6EF8…`).
7. Harness drives the real `ExecutionCoordinator` (production module, no mocks): arm LIVE in-process only after the devnet genesis assert, then:
   - BUY 0.01 SOL → expect Jito attempts fail → RPC fallback → `CONFIRMED`, position `OPEN`, `tokenQuantityRaw` equals on-chain ATA balance, cost basis equals SOL delta minus fee.
   - `closePosition(id, 50)` → `PARTIALLY_CLOSED`, remaining tokens equal on-chain ATA.
   - `closePosition(id, 100)` → `CLOSED`, ATA account closed (getAccountInfo null), SOL delta includes ~0.00203928 rent.
   - Failure: BUY with slippage forced to fail → `REVERTED`, no position written, no double submit (one RPC signature per order id).
   - Retry/idempotency: same order id resubmitted → skipped as already landed.
   - Recovery: submit, kill process before reconcile, restart → `startupReconciliation` recovers position from chain.
8. Cross-check every signature with `getTransaction` (devnet) and list Solscan devnet links.

### Phase C — report
Evidence: command output excerpts, devnet signatures, DB rows vs on-chain balances, list of mainnet calls blocked by the guard.

## Decision needed from Mike

The installed Solana/Pump packages are fakes, so Phase B cannot run on the current install. Options:
1. **Scratch copy with real packages (recommended).** Install the versions already pinned in `package.json` into a throwaway copy; the repo and its `node_modules` stay untouched.
2. Reinstall real packages in the repo itself and commit a `package-lock.json`. This changes your working tree and will likely make many tests that relied on the stubs fail.
3. Skip devnet E2E; report Phase A only.
