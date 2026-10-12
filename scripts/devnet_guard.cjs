// Preloaded with `node --require scripts/devnet_guard.cjs`. Wraps every outbound network entry point,
// logs each attempt, and throws before connecting to anything that looks like mainnet or Jito.
'use strict';
const BLOCK = /mainnet|jito\.wtf/i;
const http = require('http');
const https = require('https');
const log = (kind, target, blocked) =>
  process.stderr.write(`[devnet-guard] ${blocked ? 'BLOCKED' : 'allow  '} ${kind} ${target}\n`);

function targetOf(args) {
  const a = args[0];
  if (typeof a === 'string') return a;
  if (a instanceof URL) return a.href;
  if (a && typeof a === 'object') return `${a.protocol || ''}//${a.hostname || a.host || ''}${a.path || ''}`;
  return String(a);
}
// Only scheme and host are ever printed, and the host of a private RPC (DEVNET_RPC_URL / SOLANA_RPC_URL, read each time because the harness
// sets the second after this file loads) is printed as <rpc>: it names the endpoint, and its path or query carries the key.
function secretHosts() {
  const out = [];
  for (const v of [process.env.DEVNET_RPC_URL, process.env.SOLANA_RPC_URL, process.env.SOLANA_WS_URL]) {
    try {
      const h = new URL(v).host;
      if (h && !/(^|\.)solana\.com$/i.test(h)) out.push(h);
    } catch {}
  }
  return out;
}
function shown(t) {
  try {
    const u = new URL(t);
    return `${u.protocol}//${secretHosts().includes(u.host) ? '<rpc>' : u.host}`;
  } catch {
    return String(t).replace(/[/?].*$/, '');
  }
}
function check(kind, args) {
  const t = targetOf(args);
  const blocked = BLOCK.test(t);
  log(kind, shown(t), blocked);
  if (blocked) throw new Error(`DEVNET_GUARD: refused ${kind} to ${shown(t)}`);
}

const origFetch = globalThis.fetch;
if (origFetch) {
  globalThis.fetch = function (input, init) {
    try {
      check('fetch', [typeof input === 'string' || input instanceof URL ? input : input && input.url]);
    } catch (e) {
      return Promise.reject(e);
    }
    return origFetch.call(this, input, init);
  };
}
for (const [name, mod] of [['http', http], ['https', https]]) {
  for (const fn of ['request', 'get']) {
    const orig = mod[fn];
    mod[fn] = function (...args) {
      check(`${name}.${fn}`, args);
      return orig.apply(this, args);
    };
  }
}
module.exports = { BLOCK };
