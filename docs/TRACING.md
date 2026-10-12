# Tracing

Optional OpenTelemetry tracing for the server. It shows every step of a candidate or trade and every network wait inside it, so a slow or repeated call stands out. The first thing it found was a genesis-hash lookup made before every send (fixed in S208).

**Off by default.** Nothing runs and nothing is sent unless `APEX_TRACING=true`. Spans go only to a local endpoint (loopback, or the compose service `jaeger`); any other `APEX_TRACING_OTLP_ENDPOINT` makes tracing refuse to start. See [`ENV.md`](ENV.md) for both variables.

## Turn it on

1. Start the viewer: `docker compose up jaeger`. Its UI is at <http://127.0.0.1:16686> and it listens on `127.0.0.1:4318` for spans. Both are bound to host loopback only.
2. Run the server with tracing on: `APEX_TRACING=true npm run dev`. (In the compose app container the endpoint already points at the `jaeger` service; set `APEX_TRACING=true` in your shell or `.env` next to the compose file.)
3. Open Jaeger, pick the service `apex-quant`, and search. One trace is one candidate or one trade.

## What you see

| Span | Where |
|---|---|
| `auto.candidate` | root of an auto candidate (`submitCandidate`) |
| `watch.release` | the watch-window verdict for the candidate |
| `snipe.execute` | pool-level checks in `executeSnipe` |
| `gate.confluence` | the confluence score |
| `trade.execute` | the coordinator's trade (root of a manual trade's trace) |
| `gate.eligibility` | the on-chain eligibility verdict |
| `risk.evaluateOrder` | the risk engine |
| `tx.build`, `tx.sign` | building and signing the transaction |
| `guard.blockhash` | the optional independent blockhash check (`APEX_VERIFY_BLOCKHASH`) |
| `guard.sendCluster`, `guard.genesis` | the mainnet refusal and the genesis-hash check before a send |
| `tx.submit`, `tx.confirm` | the transport (Jito or RPC) and confirmation, with `apex.transport` |
| `tx.reconcile` | reading the fill back from the chain |
| `exit.close` | an exit (`closePosition`) |

Outbound http and `fetch` calls (web3.js RPC, Jito, feeds) appear as `POST` and `GET` spans under whichever step made them. Incoming `GET` requests are not traced, so UI polling does not flood the list.

## What it never shows

RPC and Jito URLs can carry an API key. Every span is cut down to scheme and host before it leaves the process, URL paths and queries are blanked, and the same applies to error messages inside spans (`server/observability/tracing.ts`, `RedactingExporter`). `tests/s209_tracing.test.ts` checks this.

## Try it without the server

`npx tsx scripts/trace_genesis_demo.ts` makes two guard checks on one connection (against `SOLANA_RPC_URL`, else public devnet) and prints the spans: the first has a `POST` child, the second has none. It signs and sends nothing. A run against a local stand-in RPC is saved at `overnight/evidence/209-genesis-trace-local-fake-rpc.txt`; the same run against real devnet is still to be done on the Mac.

## Cost

With tracing off, `traced()` is a flag check and a direct call. With it on, each span costs microseconds; the spans are batched and exported once a second.
