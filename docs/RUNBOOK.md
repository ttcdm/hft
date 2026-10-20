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
| `GET /api/system/checks` | cluster, signer, RPC, reconciliation, halt, kill switch and circuit breaker, feed, marks, database, and the open operator alerts (`TRADING_HALTED`, `EXIT_FAILING`, `EXIT_QUOTE_FAILING`, `POSITION_MARK_UNAVAILABLE`, ...) |
| `GET /api/execution/can-arm` | `allowed`, plus every reason arming would fail |
| `GET /api/execution/mode` | coordinator mode and `isLiveArmed` |
| `GET /api/auto/status` | auto mode, session, budgets, kill triggers |
| `GET /api/diagnostics/system` | `systemAudit.killSwitchActive`, `riskControls.circuitBreakerState`, wallet balance, RPC host and latency |
| `GET /api/workstation/positions` | positions; add `?status=ACTIVE` and `&mode=LIVE` to filter |

Operator alerts live in memory only; a restart forgets them (the journal keeps the events).

## 1. Stop everything

There are five different stops. Only stopping the process stops the exits too.

| Control | Stops new buys | Stops LIVE exits | Changes auto mode | Survives a restart |
|---|---|---|---|---|
| Kill switch: the KILL SWITCH button, or `POST /api/execution/kill-switch` `{"activate":true}` | yes, PAPER and LIVE; also disarms LIVE | no | OFF, saved once any buy in flight has finished | the switch: no (memory only); the auto OFF: yes |
| Panic: `POST /api/wallet/panic-liquidate` (also WebSocket `PANIC_LIQUIDATE`, Telegram `/panic_sell`) | as the kill switch, then sells every active position | no | as the kill switch | as the kill switch |
| Auto kill: `POST /api/auto/kill` `{"exitAll":false}` | auto only | no | OFF, saved once any buy in flight has finished | the OFF does |
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

The kill switch runs the shared emergency stop without the sells: kill switch on, auto killed and set OFF once a buy it already had in flight has finished, LIVE disarmed. The reply carries `autoMode`. The switch itself is cleared by a restart; the auto OFF is saved, so a restart comes back OFF. Resetting the switch (`{"activate":false}`) turns nothing back on: auto stays OFF and LIVE stays disarmed until an operator sets them again (DEVNET_LIVE needs `CONFIRM_AUTO_DEVNET` again). A DEVNET_LIVE session that sees LIVE disarmed or the kill switch on by any other route also turns itself OFF. Exits keep running on open positions.

### 1.2 Stop buying and sell everything

```bash
api -X POST $APEX/api/wallet/panic-liquidate
```

What it does, in this order: kill switch on; auto killed (it waits for a buy auto already had in flight, so that position is sold too) and OFF; LIVE disarmed; then a 100% sell of every active position of every mode, RECOVERED balances included, one at a time, with the protective reason `EMERGENCY_PANIC_LIQUIDATION` (it runs during a halt and the dust check does not refuse it). A position whose exit was already in flight (for example a take-profit partial) is waited for, then re-read and the rest of it sold. The active positions are read once more after the loop and any new one is sold too.

Read the reply: `Failed` lists the positions still open, for example one with a sell still being verified (`SELL_PENDING_VERIFICATION`) or one another process is selling (`EXIT_IN_PROGRESS`). Wait a few seconds (up to 100 s for a pending sell) and run panic again until nothing fails. The message also says whether auto was confirmed stopped.

The WebSocket `PANIC_LIQUIDATE` action and Telegram `/panic_sell` run the same stop. Do not rely on Telegram for it: Telegram cannot deliver the command (no webhook is registered with Telegram and nothing polls for updates); it runs only when something posts it to `POST /api/telegram/webhook` with the operator token.

### 1.3 Stop all sending, exits included

1. Do 1.1 (or 1.2 if you want to be flat).
2. Check what is open, and accept that it will have no stop-loss once the process is down: `api "$APEX/api/workstation/positions?status=ACTIVE&mode=LIVE"`.
3. Stop the process (Ctrl-C, or `docker compose down`).
4. Before starting it again, decide whether it may send. On a restart LIVE is disarmed and no buy can happen until someone arms, but exits of open LIVE positions resume at once with the loaded key. To keep it from sending at all, start it without a signer (no `OPERATOR_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, or keypair file at `SIGNER_KEYPAIR_PATH` / `./.apex_trading_keypair.json`); keep the throwaway key file somewhere safe rather than deleting it. With no signer, LIVE exits fail with `Signer is not configured or locked`.

### 1.4 Move devnet SOL off the throwaway key

```bash
solana transfer --url devnet --keypair <throwaway.json> <another devnet address> ALL
```

Always pass `--url devnet`: the Solana CLI's default cluster is not devnet. The destination is another devnet key you control (add `--allow-unfunded-recipient` if it has never held SOL).

## 2. The kill switch is on

Find out which one:
- `api $APEX/api/diagnostics/system`: `systemAudit.killSwitchActive` and `riskControls.circuitBreakerState`.
  - Kill switch on and breaker `OPEN`: three wallet-balance reads failed in a row, which opened the circuit breaker and set the kill switch. Every buy, PAPER included, is refused until a restart; no route closes the breaker.
  - Kill switch on, breaker `CLOSED`: the operator button or route, or a panic.
- `api $APEX/api/auto/status`: an auto kill trigger (`DAILY_LOSS_LIMIT`, `NEGATIVE_EXPECTANCY`, `LOSS_STREAK`, `SLIPPAGE_BREACHES`, `READINESS_RED`, `WALLET_LOW`, `WALLET_UNKNOWN`) drops auto to SHADOW and, from DEVNET_LIVE, disarms LIVE. It does not set the risk-engine kill switch.
- A halt (`TRADING_HALTED` alert, "All trading is halted" in `can-arm`) is something else: section 3.

Facts to keep in mind:
- The kill switch lives in memory only. A restart clears it, and the saved auto mode (at most PAPER; a saved DEVNET_LIVE comes back as SHADOW) comes back with a fresh session.
- Resetting it does not close an open circuit breaker or clear a halt; the reply carries `circuitBreaker` and `haltReason` so you can see which are still set.

To recover:
1. Fix the cause (RPC, wallet balance, losses).
2. `api -X POST $APEX/api/execution/kill-switch -d '{"activate":false}'`.
3. If the breaker is `OPEN`, restart the server.
4. Re-arm only when `can-arm` is clean: `api -X POST $APEX/api/execution/arm -d '{"arm":true,"confirmationCode":"CONFIRM_LIVE_TRADING_RISK"}'`.
5. Set the auto mode yourself: `api -X POST $APEX/api/auto/mode -d '{"mode":"DEVNET_LIVE","confirmationCode":"CONFIRM_AUTO_DEVNET"}'` (or `SHADOW` / `PAPER`).

## 3. All trading halted (wallet audit)

In DEVNET_LIVE the auto controller compares the wallet's SOL every 5 s with what the decision journal says moved. A difference above 0.0005 SOL plus allowances halts the coordinator and sets auto OFF. The halt refuses every buy and the take-profit and stale exits; stop-loss, trailing stop, manual close and panic still run (a LIVE manual close of a position too small to cover its fees is still refused as dust). The halt is saved in the database and survives a restart.

It also fires on SOL moves the journal has no row for, which are not theft: for example a manual LIVE buy while DEVNET_LIVE runs.

To recover:
1. Do not move SOL or tokens by hand yet. Open positions are still protected by their stop-loss.
2. Compare the wallet's history on a devnet explorer (`?cluster=devnet`) with what the app recorded. Explain every move.
3. If every move is explained: `api -X POST $APEX/api/auto/resume -d '{"clearHalt":true}'`. It clears the halt only and never turns auto back on. Then arm and set the mode (section 2 steps 4-5).
4. If a move is not explained, treat the key as compromised: panic (1.2), stop the process (1.3), move what is left (1.4) and generate a new throwaway devnet key.
