/**
 * TEST ENTRY (not part of the app): boots the real server (server.ts) with `fetch` refusing every host that is not loopback, and writes
 * each refused host and path to the file named by APEX_TEST_FETCH_LOG. A child server is outside the vitest network guard, so this is how a test
 * runs the server with external feeds on and still never reaches the internet. Loopback calls (the RPC stub) pass through unchanged.
 */
import fs from 'node:fs';

const realFetch = globalThis.fetch;
const log = process.env.APEX_TEST_FETCH_LOG;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (log) fs.appendFileSync(log, `${url.hostname}${url.pathname}\n`);
  throw new TypeError(`OFFLINE_TEST: ${url.hostname} refused`);
}) as typeof fetch;

await import('../../server');
