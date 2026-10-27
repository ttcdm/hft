# Operator runbook: emergency procedures

What to do when something goes wrong, and what each control does in the code today, including where it does less than you would expect. **Devnet and localnet only**, on a throwaway devnet key funded from the faucet (`KNOWN_RISKS.md` 4.1). Explorer links, if you use one, must carry `?cluster=devnet`. Run one server per database and per wallet: a second server on the same database, port or signing key prints `INSTANCE_LOCKED` (or the listen error) and exits with code 1 before it trades (README, "One server per database and per wallet").

## 0. Setup for every procedure

The server binds to loopback (`127.0.0.1`) unless `BIND_HOST` and `ALLOW_PUBLIC_BIND=true` say otherwise. Every `/api` route except `GET /api/health` and `POST /api/auth/login` needs the operator token.

```bash
export APEX=http://127.0.0.1:3000          # APP_PORT / PORT if you changed it
export TOK=...                              # OPERATOR_AUTH_TOKEN, or a session token from POST /api/auth/login
api() { curl -sS -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' "$@"; }
```

Where to look:

| Route | Shows |
|---|---|
| `GET /api/system/checks` | cluster, signer, RPC, reconciliation, halt, kill switch and circuit breaker, feed, marks, database, and the open operator alerts (`TRADING_HALTED`, `HALT_NOT_PERSISTED`, `KILL_SWITCH_WAS_ON`, `EXIT_FAILING`, `EXIT_QUOTE_FAILING`, `EXIT_RATE_LIMITED`, `RPC_AUTH_REJECTED`, `EXIT_NO_SIGNER`, `SELL_ADOPTED`, `UNTRACKED_TOKEN_BALANCE`, `POSITION_NOT_PERSISTED`, `POSITION_MARK_UNAVAILABLE`, ...). The capacity row also shows how many seller funder lookups ended unread |
| `GET /api/execution/can-arm` | `allowed`, plus every reason arming would fail |
| `GET /api/execution/mode` | coordinator mode and `isLiveArmed` |
| `GET /api/execution/readiness` | every readiness component, the same list `can-arm` is built from |
| `GET /api/auto/status` | auto mode, session, budgets, kill triggers |
| `GET /api/diagnostics/system` | `systemAudit.killSwitchActive`, `riskControls.circuitBreakerState`, wallet balance, RPC host and latency |
| `GET /api/workstation/positions` | positions; add `?status=ACTIVE` and `&mode=LIVE` to filter |

Operator alerts live in memory only; a restart forgets them (the journal keeps the events).

## 1. Stop everything

There are five different stops. Only stopping the process stops the exits too.

| Control | Stops new buys | Stops LIVE exits | Changes auto mode | Survives a restart |
|---|---|---|---|---|
| Kill switch: the KILL SWITCH button, or `POST /api/execution/kill-switch` `{"activate":true}` | yes, PAPER and LIVE; also disarms LIVE | no | OFF, saved before it waits for any buy in flight | the switch: no (memory only); the auto OFF: yes |
| Panic: `POST /api/wallet/panic-liquidate` (also WebSocket `PANIC_LIQUIDATE`, Telegram `/panic_sell`) | as the kill switch, then sells every active position | no | as the kill switch | as the kill switch |
| Auto kill: `POST /api/auto/kill` `{"exitAll":false}` | auto only | no | OFF, saved with the kill reason before it waits for a buy in flight (3E) | the OFF does: after a restart `GET /api/auto/status` shows `mode` `OFF`, `killed` true and `killReason`; setting a mode clears it |
| Halt (set by the DEVNET_LIVE wallet audit; no operator route sets it) | yes | take-profit and stale exits only | OFF | yes (saved in the database) |
| Stop the process | yes | yes, all of them | n/a | n/a |

Disarming LIVE, the kill switch and the halt do not stop a LIVE stop-loss, trailing stop, manual close or panic sell. A LIVE sell needs a READY signer, not read-only mode, a non-mainnet `ALLOWED_CLUSTER` and a matching genesis hash; it does not need LIVE to be armed.

Older notes name a `/api/live/disarm` route: it does not exist (404). To disarm LIVE without the kill switch, send `POST /api/execution/arm` with `{"arm":false}`.

### 1.1 Stop buying, keep protecting open positions (the normal emergency stop)

```bash
api -X POST $APEX/api/execution/kill-switch -d '{"activate":true}'  # refuses every buy, stops auto (OFF, saved), disarms LIVE
api $APEX/api/execution/mode                                         # expect isLiveArmed: false
api $APEX/api/execution/can-arm                                      # reasons include "Emergency risk kill switch is active"
api $APEX/api/auto/status                                            # expect mode OFF, killed: true
```

The kill switch runs the shared emergency stop without the sells: kill switch on, auto killed (OFF and the kill reason are saved first, before it waits for a buy already in flight), LIVE disarmed. The reply carries `autoMode`. The switch itself is cleared by a restart; the auto OFF is saved, so a restart comes back OFF. After such a restart the `KILL_SWITCH_WAS_ON` alert is raised and LIVE refuses to arm (can-arm lists it) until it is cleared with `POST /api/auto/resume {"clearHalt":true}`. Resetting the switch (`{"activate":false}`) turns nothing back on: auto stays OFF and LIVE stays disarmed until an operator sets them again (DEVNET_LIVE needs `CONFIRM_AUTO_DEVNET` again). A DEVNET_LIVE session that sees LIVE disarmed or the kill switch on by any other route also turns itself OFF. Exits keep running on open positions. A LIVE buy already past the gate that lands after the switch is sold at once (see 1.2, a buy that lands after a panic or kill switch).

### 1.2 Stop buying and sell everything

```bash
api -X POST $APEX/api/wallet/panic-liquidate
```

What it does, in this order: kill switch on; auto killed (it waits for a buy auto already had in flight, so that position is sold too) and OFF; LIVE disarmed; then it waits up to 30 s (`PANIC_BUY_SETTLE_WAIT_MS`) for every other LIVE buy already past the risk gate (a manual buy, a callout or Telegram snipe), so the position that buy opens is sold too; then a 100% sell of every active position of every mode, RECOVERED balances included, one at a time, with the protective reason `EMERGENCY_PANIC_LIQUIDATION` (it runs during a halt and the dust check does not refuse it). A position whose exit was already in flight (for example a take-profit partial) is waited for, then re-read and the rest of it sold. The active positions are read once more after the loop and any new one is sold too.

Read the reply: `Failed` lists the positions still open, for example one with a sell still being verified (`SELL_PENDING_VERIFICATION`) or one another process is selling (`EXIT_IN_PROGRESS`), and a LIVE buy still being sent or confirmed when the panic ended (`BUY_IN_FLIGHT`, listed as `buy-<mint>`; if it lands after the reply the app sells it at once, see the next paragraph; run the panic again to be sure). Since R5-9 the panic itself retries a position whose earlier sell is still being verified, every 2 s for up to 90 s (`PANIC_PENDING_SELL_WAIT_MS`, about one blockhash life), and sells the rest of a position whose close only adopted an earlier partial; any LIVE position still open after all that is listed as `STILL_OPEN`. Run panic again until nothing fails. The message also says whether auto was confirmed stopped.

**A buy that lands after a panic or kill switch is sold at once.** A LIVE buy that was already past the risk gate when the panic or kill switch ran (a manual buy, a callout or Telegram snipe, or auto's own), and whose position is saved after it (it confirmed late, or it came back UNCONFIRMED and orphan recovery adopted it later), is sold 100% right away through the normal sell path with `EMERGENCY_PANIC_LIQUIDATION`. The kill switch does not hold this sell (it blocks buys, not exits). The journal gets a `LATE_BUY_EXIT` row and the alert `LATE_BUY_SOLD` is raised; if the sell fails, `LATE_BUY_NOT_SOLD` is raised and the position stays open with its stop-loss, so run the panic again or close it by hand. This lives in memory: a buy adopted after a restart is not sold this way.

**A landed buy with no position (`POSITION_NOT_PERSISTED`, or a buy left unresolved by a restart).** Its tokens have no stop-loss until orphan recovery rebuilds the position from chain data. Recovery retries in the background (5, 15, 45, 120 and 300 s, then every 300 s while it stays unresolved), and covers buys left `PENDING` as well as `RECONCILIATION_REQUIRED`. While any is unresolved, LIVE readiness names it and LIVE buys are refused. If it does not clear, run Reconcile; if the transaction can never be read, sell the tokens by hand.

**A LIVE position recorded for another wallet (`POSITION_WALLET_MISMATCH`).** Each LIVE position remembers the wallet that bought it (rows from before this was stored are matched to the fee payer of their own buy transaction, read from chain, the first time it matters). An empty token account read with any other signing key proves nothing, so startup reconciliation and the exit path leave such a position open, book no loss, and raise this alert (readiness stays at MISMATCH). It means the key changed, the key file is not the one that traded, or the database was copied. Load the key of the wallet the alert names to manage those positions; do not edit the database to close them. When the buy transaction of an older row cannot be read, the alert says `WALLET_BINDING_UNKNOWN` and the position is held the same way.

**Tokens in the wallet with no position (`UNTRACKED_TOKEN_BALANCE`, `UNKNOWN_TOKEN_BALANCE`).** The startup wallet scan adopts a balance as a RECOVERED position (hard stop only, cost basis unknown) only when this app once sent a LIVE buy of that mint, so its record was lost. A token the app never bought (anyone can send any token to the wallet) is listed in one `UNKNOWN_TOKEN_BALANCE` alert and is never adopted or traded; sell it by hand if you want it gone. RECOVERED positions do not count toward the auto loop's open-position cap and do not drive the position mark feed's health.

The WebSocket `PANIC_LIQUIDATE` action and Telegram `/panic_sell` run the same stop. Do not rely on Telegram for it: Telegram cannot deliver the command (no webhook is registered with Telegram and nothing polls for updates); it runs only when something posts it to `POST /api/telegram/webhook` with the operator token.

### 1.3 Stop all sending, exits included

1. Do 1.1 (or 1.2 if you want to be flat).
2. Check what is open, and accept that it will have no stop-loss once the process is down: `api "$APEX/api/workstation/positions?status=ACTIVE&mode=LIVE"`.
3. Stop the process (Ctrl-C, or `docker compose down`).
4. Before starting it again, decide whether it may send. On a restart LIVE is disarmed and no buy can happen until someone arms, but exits of open LIVE positions resume at once with the loaded key. A sell claim left by the process that was stopped does not hold the stop-loss up: the claim owner carries a per-run id, so a claim from another run of the same pid (PID 1 in Docker) counts as dead. To keep it from sending at all, start it without a signer (no `OPERATOR_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, or keypair file at `SIGNER_KEYPAIR_PATH` / `./.apex_trading_keypair.json`); keep the throwaway key file somewhere safe rather than deleting it. With no signer, LIVE exits fail with `Signer is not configured or locked` and the `EXIT_NO_SIGNER` alert is raised for each LIVE position (it names read-only mode when that is the cause, and clears on a fill).

### 1.4 Move devnet SOL off the throwaway key

```bash
solana transfer --url devnet --keypair <throwaway.json> <another devnet address> ALL
```

Always pass `--url devnet`: the Solana CLI's default cluster is not devnet. The destination is another devnet key you control (add `--allow-unfunded-recipient` if it has never held SOL).

## 2. The kill switch is on

Find out which one:
- `api $APEX/api/diagnostics/system`: `systemAudit.killSwitchActive` and `riskControls.circuitBreakerState`.
  - Kill switch on and breaker `OPEN`: three wallet-balance reads failed in a row, which opened the circuit breaker and set the kill switch. Every buy, PAPER included, is refused while it is open. To close it, fix the RPC, wait for a wallet-balance read to succeed (one runs every 10 s; System checks shows when the latest one succeeded), then reset the kill switch: `POST /api/execution/kill-switch` with `{"activate":false}`. A reset while the latest read still fails leaves the breaker `OPEN` and says why in `circuitBreakerReset.reason`.
  - Kill switch on, breaker `CLOSED`: the operator button or route, or a panic.
- `api $APEX/api/auto/status`: an auto kill trigger (`DAILY_LOSS_LIMIT`, `NEGATIVE_EXPECTANCY`, `LOSS_STREAK`, `SLIPPAGE_BREACHES`, `READINESS_RED`, `WALLET_LOW`, `WALLET_UNKNOWN`) drops auto to SHADOW and, from DEVNET_LIVE, disarms LIVE. It does not set the risk-engine kill switch. `NEGATIVE_EXPECTANCY` and `LOSS_STREAK` judge the last 20 closed trades auto opened (in the same mode, across sessions and restarts, never a trade you opened by hand), so a new session does not wipe them; after one trips, setting PAPER or DEVNET_LIVE is refused until you acknowledge (section 6). `WALLET_UNKNOWN` fires only after no good wallet balance read for more than 10 s (`READINESS_RED_LIMIT_MS`).
- A halt (`TRADING_HALTED` alert, "All trading is halted" in `can-arm`) is something else: section 3.

Facts to keep in mind:
- The kill switch lives in memory only. A restart clears it, and auto starts OFF at every start: the saved mode is not restored, so after any restart you set the mode again (DEVNET_LIVE also needs LIVE armed and its confirmation code). A kill saved by the last run (`auto.kill`) keeps auto OFF and killed until you set a mode. An unattended restart therefore stops auto trading until you notice.
- Resetting it closes an open circuit breaker only when the latest wallet-balance read succeeded, and never clears a halt; the reply carries `circuitBreaker`, `circuitBreakerReset` (whether it closed, and why not) and `haltReason` so you can see which are still set.

To recover:
1. Fix the cause (RPC, wallet balance, losses).
2. `api -X POST $APEX/api/execution/kill-switch -d '{"activate":false}'`.
3. If the reply says `circuitBreakerReset` did not close the breaker, wait for a wallet-balance read to succeed (System checks shows when the latest one did) and send the reset again. A restart also closes it, because the breaker is held in memory only.
4. Re-arm only when `can-arm` is clean: `api -X POST $APEX/api/execution/arm -d '{"arm":true,"confirmationCode":"CONFIRM_LIVE_TRADING_RISK"}'`.
5. Set the auto mode yourself: `api -X POST $APEX/api/auto/mode -d '{"mode":"DEVNET_LIVE","confirmationCode":"CONFIRM_AUTO_DEVNET"}'` (or `SHADOW` / `PAPER`).

## 3. All trading halted (wallet audit)

In DEVNET_LIVE the auto controller compares the wallet's SOL every 5 s with what the decision journal says moved. A difference above 0.0005 SOL plus allowances halts the coordinator, sets auto OFF, disarms LIVE and saves the kill (so a restart comes back OFF and disarmed). While the halt is set, `POST /api/auto/mode` refuses `DEVNET_LIVE` (`TRADING_HALTED`). The halt refuses every buy and the take-profit and stale exits; stop-loss, trailing stop, manual close and panic still run (a LIVE manual close of a position too small to cover its fees is still refused as dust). The halt is saved in the database and survives a restart.

Only an unexplained fall halts. SOL arriving that the journal does not explain (a deposit, your own top-up, a stranger's transfer, the proceeds of a sell whose row is not written yet) is logged as a `WALLET_INFLOW` decision row and never halts; with nothing pending the audit's baseline moves to the new balance, and while a LIVE sell or buy is unresolved the old baseline is kept until its row arrives. A fall still fires on SOL moves the journal has no row for, which are not theft: for example a SOL transfer you made by hand. Since 3B every landed LIVE buy, manual or auto, writes a `LIVE_BUY_FILLED` row with its whole wallet delta, so a buy no longer trips the audit, and while a LIVE buy is sent and unresolved a wallet drop up to its worst case is held as that buy's (no halt) until recovery journals it. A drop larger than that still halts.

To recover:
1. Do not move SOL or tokens by hand yet. Open positions are still protected by their stop-loss.
2. Compare the wallet's history on a devnet explorer (`?cluster=devnet`) with what the app recorded. Explain every move.
3. If every move is explained: `api -X POST $APEX/api/auto/resume -d '{"clearHalt":true}'`. It clears the halt only and never turns auto back on. A read-only server (`APEX_READ_ONLY=true`) refuses it (`clearHaltRefused` in the reply): clear the halt from the server that signs. Then arm and set the mode (section 2 steps 4-5).
4. If a move is not explained, treat the key as compromised: panic (1.2), stop the process (1.3), move what is left (1.4) and generate a new throwaway devnet key.

## 4. Buys refused with DAILY_LOSS_LIMIT (the net daily PnL floor)

The risk engine refuses a buy as `DAILY_LOSS_LIMIT` when the net PnL of the last 24 hours (realized, plus open unrealized, minus unbooked fees; not since UTC midnight) has reached the floor, or when the new order plus every open position going to zero would break it. The floor is `MAX_DAILY_LOSS_USD` converted at the SOL price (see [`ENV.md`](ENV.md) for the stale-price rule). It is a separate control from the halt in section 3 and from the auto kill trigger of the same name (which drops auto to SHADOW; section 2).

Two different refusals:
- **Latched.** The message starts `Net daily PnL floor latched at ...` or says `latched until an operator clears it`. The refusal holds for that mode (LIVE and PAPER are latched separately) even after the losses leave the 24 h window, until you clear it. The message ends with when the oldest loss in the window leaves it.
- **Worst case.** The message says `if this order and the open positions (... SOL at risk) went to zero, net PnL over 24 h would be ...`. Nothing is latched; the buy passes again once an open position closes or the window moves. If it says `MAX_DAILY_LOSS_USD (... SOL) is smaller than this ... SOL order with its costs`, no buy of that size can ever pass: raise `MAX_DAILY_LOSS_USD` or lower the order size, and restart (the floor comes from the environment, not from `POST /api/wallet/config`, which refuses `riskLimits.maxDailyLossUsd`).

To resume:
1. Find out why the losses happened (`api "$APEX/api/workstation/positions?status=CLOSED"`, the decision journal). Do not clear the latch to get around a losing strategy.
2. `api -X POST $APEX/api/auto/resume -d '{"clearDailyLossLatch":true}'`. This clears the latch of the mode the coordinator is in now (LIVE when LIVE is armed, else PAPER; the reply's `dailyLossLatchCleared` names it), not both; `clearHalt` does not clear it, and this flag does not clear a halt. Send both flags in one request to clear both.
3. If the 24 h window still holds net losses at or beyond the floor, the next buy is refused and latches again. Wait for the window to move (the message says when), or raise `MAX_DAILY_LOSS_USD` in the environment and restart.

The latch is saved in the database and survives a restart; only the clear above lifts it.

## 5. A buy is refused as LIVE_NOT_READY (or ENTRY_REVOKED)

Every LIVE buy re-reads a short readiness list (section 3 of [`ARCHITECTURE.md`](ARCHITECTURE.md)), not only the arm. The reply names each failing item:

| Message says | Meaning | What to do |
|---|---|---|
| `the RPC is not on the allowed cluster (...)` | the heartbeat saw a wrong or unreadable genesis hash, or the database's cluster stamp is unreadable (`DB_CLUSTER_STAMP_UNREADABLE`) | fix the endpoint; the heartbeat clears it on its next passing check (10 s) |
| `Solana RPC is DISCONNECTED` | no working connection (`DEGRADED`, over 800 ms, does not refuse a buy) | fix the RPC |
| `the workstation database is not writable` | a real test write failed, or less than 32 MiB is free on the database's disk | free disk space or fix the database; a pass is cached for 1 s. Below 128 MiB free the System checks database row is WARN and a `DISK_SPACE_LOW` alert is up, while buys still go on. The launch recorder, which writes into the same database, already stopped below 256 MiB (`APEX_RECORD_MIN_FREE_MB`; one `[RECORDER] stopped recording` log line, and one `recording resumed` line when space is back) |
| `startup reconciliation is ...` | not `EXECUTION_READY`: `RECONCILIATION_MISMATCH`, or not finished | resolve the rows it names, then `api -X POST $APEX/api/execution/reconcile`; this blocks buys only, exits keep running |
| `the risk circuit breaker is OPEN` | three failed wallet-balance reads | section 2 |
| `the position mark feed is STALE` | no fresh position marks | check the RPC; open positions have no price meanwhile |
| `DEMO_MODE=true (...)` | the demo switch is on | unset `DEMO_MODE` and restart; LIVE cannot be armed while it is on |

`ENTRY_REVOKED: ... after the order was approved; nothing was sent` means one of these (or a disarm, a halt or the kill switch) happened between approval and the send; the signed transaction was dropped unsent. Sells are never refused for these reasons.

## 6. Auto refuses PAPER or DEVNET_LIVE with LOSS_TRIGGERS_NEED_ACK (3E)

`POST /api/auto/mode` answers 409 with an error starting `LOSS_TRIGGERS_NEED_ACK:` when the last 20 closed trades auto opened in that mode (PAPER, or LIVE for DEVNET_LIVE) trip `NEGATIVE_EXPECTANCY` or `LOSS_STREAK`. Only auto's own trades count: positions in the current session, or with a `BOUGHT` journal row, closed after the last acknowledgement.

1. Look at those trades (`api $APEX/api/auto/status`, the journal) and decide whether the losses are understood.
2. Acknowledge: `api -X POST $APEX/api/auto/resume -d '{"ackLossTriggers":true}'`. The reply adds `lossTriggersAcked`; `false` means it could not be saved and nothing changed. Trades closed before now stop counting, in both modes; it is one timestamp (`app_settings` key `auto.lossTriggerAck`). It does not change the mode.
3. Set the mode again (section 2, steps 4-5, for DEVNET_LIVE).

There is no button for this in the UI yet (the 3E notes say so); the API is the only way. An acknowledgement that cannot be read back counts as none, so every trade counts.
