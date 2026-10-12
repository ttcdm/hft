/**
 * Side-effect module for the server entry point: starts tracing when APEX_TRACING=true (see `tracing.ts`). Import it right after
 * `./server/loadEnv`. When tracing is off this does nothing at all.
 */
import { startTracing, tracingRequested } from './tracing';
import { Logger } from '../middleware/enterprise';

/** Resolves once tracing has started (or immediately when it is off). `startServer` awaits it before opening any connection. */
export const tracingReady: Promise<boolean> = tracingRequested()
  ? startTracing().catch((err) => { Logger.error(`[TRACING] failed to start: ${err?.message ?? err}`); return false; })
  : Promise.resolve(false);
