/**
 * S209 demo: shows that the genesis-hash lookup before a send is made once per connection, not once per order.
 *
 *   npx tsx scripts/trace_genesis_demo.ts                       # uses SOLANA_RPC_URL, else the public devnet RPC
 *   APEX_TRACING_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces npx tsx scripts/trace_genesis_demo.ts   # also sends to Jaeger
 *
 * It makes two `assertClusterAllowedCached` calls on one Connection inside `traced()` spans, with outbound http instrumented, then prints
 * the spans. The first call has an http child span (the RPC `getGenesisHash` call); the second has none. It signs and sends nothing.
 */
import '../server/loadEnv';
import { Connection } from '@solana/web3.js';
import { InMemorySpanExporter, type SpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { startTracing, stopTracing, traced, tracingRequested } from '../server/observability/tracing';
import { assertClusterAllowedCached, resolveRpcUrl, assertSendClusterAllowed } from '../server/solana/clusterGuard';
import { endpointOrigin } from '../server/middleware/enterprise';

async function main() {
  const memory = new InMemorySpanExporter();
  const tee: SpanExporter = { export: (s, d) => memory.export(s, d), shutdown: () => memory.shutdown(), forceFlush: () => Promise.resolve() };
  // Without APEX_TRACING=true this still runs, printing the spans from memory only.
  const toJaeger = tracingRequested();
  await startTracing({ force: true, exporter: toJaeger ? undefined : tee });
  const url = resolveRpcUrl();
  const conn = new Connection(url, 'confirmed');
  console.log(`RPC: ${endpointOrigin(url)}`);
  for (const n of [1, 2]) {
    await traced(`demo.send${n}`, async () => {
      traced('guard.sendCluster', () => assertSendClusterAllowed());
      await traced('guard.genesis', () => assertClusterAllowedCached(conn));
    });
  }
  await new Promise((r) => setTimeout(r, 200));
  const spans: ReadableSpan[] = memory.getFinishedSpans();
  if (toJaeger) { console.log('Spans were sent to the OTLP endpoint; open http://127.0.0.1:16686 and look for service apex-quant.'); }
  else {
    const t0 = spans.map((s) => s.startTime[0] * 1e3 + s.startTime[1] / 1e6).reduce((a, b) => Math.min(a, b), Infinity);
    for (const s of [...spans].sort((a, b) => (a.startTime[0] - b.startTime[0]) || (a.startTime[1] - b.startTime[1]))) {
      const ms = s.duration[0] * 1e3 + s.duration[1] / 1e6;
      const start = s.startTime[0] * 1e3 + s.startTime[1] / 1e6 - t0;
      console.log(`${start.toFixed(0).padStart(5)} ms  ${ms.toFixed(1).padStart(7)} ms  ${s.parentSpanContext ? '  ' : ''}${s.name}${s.attributes['url.full'] || s.attributes['http.url'] ? ` (${s.attributes['http.request.method'] ?? s.attributes['http.method']} ${String(s.attributes['url.full'] ?? s.attributes['http.url'])})` : ''}`);
    }
    const rpc = (name: string) => spans.filter((s) => s.parentSpanContext && s.name !== 'guard.genesis' && s.name !== 'guard.sendCluster' && spans.some((p) => p.spanContext().spanId === s.parentSpanContext?.spanId && p.name === name)).length;
    console.log(`\nnetwork spans under guard.genesis: ${rpc('guard.genesis')}`);
  }
  await stopTracing();
}
main().catch((e) => { console.error(e); process.exit(1); });
