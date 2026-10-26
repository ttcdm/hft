/**
 * Optional OpenTelemetry tracing (S209). OFF unless APEX_TRACING=true.
 *
 * Why: a trace shows every step of a candidate or trade and every network wait inside it, so a slow or repeated call (an uncached
 * genesis-hash lookup before every send was the first one found this way) is visible at a glance in Jaeger.
 *
 * What it does when on:
 *   - starts a Node tracer provider and auto-instruments outbound `http` and undici `fetch`, so web3.js RPC calls, Jito and feed calls become spans;
 *   - exposes `traced()` for manual spans around the pipeline steps. Spans nest by async context, so one candidate or trade is one trace;
 *   - exports spans only to a local OTLP endpoint (loopback or the compose service `jaeger`). It refuses to start with any other endpoint.
 * What it does when off: nothing. No SDK starts, `traced()` calls its function directly and makes no span.
 *
 * Secrets: RPC and Jito URLs can carry an API key in the path or query. Every span leaves through `RedactingExporter`, which cuts URLs
 * down to scheme and host (the same rule as `endpointOrigin` in `server/middleware/enterprise.ts`) and blanks URL paths and queries.
 */
import { trace, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { endpointOrigin } from '../middleware/enterprise';
import { Logger } from '../middleware/enterprise';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
const TRACER_NAME = 'apex';

let active = false;
let shutdownFn: (() => Promise<void>) | null = null;

export function tracingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APEX_TRACING === 'true';
}

/** True once a provider has been started by `startTracing`. */
export function tracingActive(): boolean {
  return active;
}

/** The OTLP endpoint must be local: loopback, or the docker-compose service name `jaeger`. */
export function isLocalOtlpEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === 'jaeger';
  } catch {
    return false;
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)]+/gi;
const BLANKED_KEYS = new Set(['url.path', 'url.query', 'http.target', 'http.route', 'url.fragment']);

/** Replaces every URL inside a string with its scheme and host. */
export function scrubText(text: string): string {
  return text.replace(URL_IN_TEXT, (u) => endpointOrigin(u));
}

export function scrubAttributes(attrs: Attributes | undefined): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (BLANKED_KEYS.has(k)) out[k] = '[REDACTED]';
    else if (typeof v === 'string') out[k] = scrubText(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = (v as string[]).map(scrubText);
    else out[k] = v;
  }
  return out;
}

/** Wraps an exporter so no URL path, query or user-info ever leaves the process. */
export class RedactingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(spans.map((s) => this.clean(s)), done);
  }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
  forceFlush(): Promise<void> { return this.inner.forceFlush?.() ?? Promise.resolve(); }
  private clean(span: ReadableSpan): ReadableSpan {
    const copy = Object.create(span) as { -readonly [K in keyof ReadableSpan]: ReadableSpan[K] };
    Object.defineProperties(copy, {
      attributes: { value: scrubAttributes(span.attributes), enumerable: true },
      events: { value: span.events.map((e) => ({ ...e, attributes: scrubAttributes(e.attributes) })), enumerable: true },
      status: { value: span.status.message ? { ...span.status, message: scrubText(span.status.message) } : span.status, enumerable: true },
    });
    return copy;
  }
}

export interface StartTracingOptions {
  env?: NodeJS.ProcessEnv;
  /** Tests pass an in-memory exporter. It is still wrapped by `RedactingExporter`. */
  exporter?: SpanExporter;
  /** Start even if APEX_TRACING is not true (tests only). */
  force?: boolean;
  /** Skip the outbound http / fetch instrumentation (tests). */
  instrumentNetwork?: boolean;
}

/** Starts tracing when APEX_TRACING=true. Returns whether it started. Safe to call twice. */
export async function startTracing(opts: StartTracingOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (active) return true;
  if (!opts.force && !tracingRequested(env)) return false;

  const endpoint = (env.APEX_TRACING_OTLP_ENDPOINT || DEFAULT_ENDPOINT).trim();
  if (!opts.exporter && !isLocalOtlpEndpoint(endpoint)) {
    Logger.error(`[TRACING] APEX_TRACING_OTLP_ENDPOINT must be loopback or the compose service "jaeger"; refusing to start tracing (got ${endpointOrigin(endpoint)})`);
    return false;
  }

  const [{ NodeTracerProvider }, base, { resourceFromAttributes }] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/resources'),
  ]);
  let inner = opts.exporter;
  if (!inner) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    inner = new OTLPTraceExporter({ url: endpoint });
  }
  const exporter = new RedactingExporter(inner);
  const processor = opts.exporter
    ? new base.SimpleSpanProcessor(exporter)
    : new base.BatchSpanProcessor(exporter, { scheduledDelayMillis: 1000 });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'apex-quant' }),
    spanProcessors: [processor],
  });
  provider.register(); // global provider + async-local-storage context, so nested spans share a trace

  let unregister: () => void = () => undefined;
  if (opts.instrumentNetwork !== false) {
    const [{ registerInstrumentations }, { HttpInstrumentation }, { UndiciInstrumentation }] = await Promise.all([
      import('@opentelemetry/instrumentation'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-undici'),
    ]);
    const otlp = (() => { try { const u = new URL(endpoint); return { host: u.hostname, port: u.port }; } catch { return null; } })();
    unregister = registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation({
          // never trace the exporter's own posts, and skip the UI's polling GETs
          ignoreOutgoingRequestHook: (req) => !!otlp && (req.hostname === otlp.host || req.host === otlp.host) && String(req.port ?? '') === otlp.port,
          ignoreIncomingRequestHook: (req) => req.method === 'GET',
        }),
        new UndiciInstrumentation(),
      ],
    });
  }

  active = true;
  shutdownFn = async () => {
    active = false;
    unregister();
    await provider.shutdown();
    trace.disable();
  };
  Logger.info(`[TRACING] on: spans go to ${opts.exporter ? 'an in-memory exporter' : endpointOrigin(endpoint)}`);
  return true;
}

/** Flushes and stops tracing. Used by tests and on shutdown. */
export async function stopTracing(): Promise<void> {
  const f = shutdownFn;
  shutdownFn = null;
  if (f) await f();
}

function fail(span: Span, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  span.recordException(err instanceof Error ? err : new Error(msg));
  span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
}

/**
 * Runs `fn` inside a span named `name` when tracing is on, and just calls it when off. Works for sync and async functions. An object
 * result with a boolean `success` is recorded as `apex.success`; a thrown error marks the span as failed.
 */
export function traced<T>(name: string, fn: () => T, attrs?: Attributes): T {
  if (!active) return fn();
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes: attrs }, (span) => {
    const done = (v: unknown) => {
      const ok = (v as { success?: unknown } | null)?.success;
      if (typeof ok === 'boolean') span.setAttribute('apex.success', ok);
      span.end();
    };
    let res: T;
    try {
      res = fn();
    } catch (err) {
      fail(span, err);
      span.end();
      throw err;
    }
    if (res && typeof (res as { then?: unknown }).then === 'function') {
      return (res as unknown as Promise<unknown>).then(
        (v) => { done(v); return v; },
        (err) => { fail(span, err); span.end(); throw err; },
      ) as unknown as T;
    }
    done(res);
    return res;
  });
}
