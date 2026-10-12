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
// Only scheme and host are ever printed: a private RPC URL carries its key in the path or query.
function shown(t) {
  try {
    const u = new URL(t);
    return `${u.protocol}//${u.host}`;
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
