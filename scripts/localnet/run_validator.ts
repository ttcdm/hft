/**
 * Standalone local validator process: `npx tsx scripts/localnet/run_validator.ts [port]`.
 * Prints one JSON line {url, genesisHash} on stdout when ready. Loopback only. Never contacts a remote cluster.
 * Kept in its own process on purpose: LiteSVM's native allocator crashes ("bad_alloc") when the app's server
 * modules are imported into the same process after a program has executed.
 */
import { LocalnetValidator } from './validator';

const port = Number(process.argv[2] || process.env.LOCALNET_PORT || 8899);
const v = new LocalnetValidator();
v.listen(port, '127.0.0.1').then((url) => {
  console.log(JSON.stringify({ url, genesisHash: v.genesisHash, wsPort: v.port + 1 }));
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => v.close().finally(() => process.exit(0)));
