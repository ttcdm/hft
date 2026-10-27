import { Connection } from '@solana/web3.js';

/**
 * Cluster guard. Nothing in this repo may sign or send a transaction unless the
 * RPC endpoint reports the genesis hash of the cluster Mike has explicitly
 * allowed. The default (and only cluster used by tests and the devnet harness)
 * is devnet. ALLOWED_CLUSTER=mainnet-beta is still accepted so a read-only
 * server can watch mainnet (see readOnly.ts), but `assertSendClusterAllowed`
 * refuses every arm, signed trade and send while it is set: this build never
 * sends on mainnet, whatever the RPC reports.
 */

export type AllowedCluster = 'devnet' | 'mainnet-beta' | 'localnet';
type RealCluster = 'devnet' | 'mainnet-beta';

export const CLUSTER_GENESIS_HASH: Readonly<Record<RealCluster, string>> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

/** Fail-closed default: devnet, never a mainnet URL. */
export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';

const MAINNET_URL_PATTERN = /mainnet|jito\.wtf/i;

export class ClusterGuardError extends Error {
  public readonly code = 'CLUSTER_GUARD';
  constructor(message: string) {
    super(`CLUSTER_GUARD: ${message}`);
    this.name = 'ClusterGuardError';
  }
}

export function allowedCluster(env: NodeJS.ProcessEnv = process.env): AllowedCluster {
  if (env.ALLOWED_CLUSTER === 'mainnet-beta') return 'mainnet-beta';
  if (env.ALLOWED_CLUSTER === 'localnet') return 'localnet';
  return 'devnet';
}

/** Default URL of the local validator / LiteSVM JSON-RPC shim. */
export const DEFAULT_LOCALNET_RPC_URL = 'http://127.0.0.1:8899';

export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Genesis hash expected for the allowed cluster. Localnet has no fixed hash: it comes from LOCALNET_GENESIS_HASH and
 * must differ from both public clusters, so setting it to a real hash can never unlock them.
 */
export function expectedGenesisHash(env: NodeJS.ProcessEnv = process.env): string {
  const cluster = allowedCluster(env);
  if (cluster !== 'localnet') return CLUSTER_GENESIS_HASH[cluster];
  const h = (env.LOCALNET_GENESIS_HASH || '').trim();
  if (!h) throw new ClusterGuardError('ALLOWED_CLUSTER=localnet needs LOCALNET_GENESIS_HASH; refusing to send');
  if (h === CLUSTER_GENESIS_HASH.devnet || h === CLUSTER_GENESIS_HASH['mainnet-beta']) {
    throw new ClusterGuardError('LOCALNET_GENESIS_HASH equals a public cluster genesis hash; refusing to send');
  }
  return h;
}

export function looksLikeMainnetUrl(url: string): boolean {
  return MAINNET_URL_PATTERN.test(url);
}

/**
 * RPC URL to use: explicit value, else SOLANA_RPC_URL, else devnet. A URL that
 * names mainnet is replaced by the devnet default unless mainnet was explicitly
 * allowed. The genesis check in assertClusterAllowed is the authoritative
 * guard; this only stops obvious mistakes from reaching the wire at all.
 */
export function resolveRpcUrl(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = (explicit || env.SOLANA_RPC_URL || '').trim();
  if (allowedCluster(env) === 'localnet') {
    return candidate && isLoopbackUrl(candidate) ? candidate : DEFAULT_LOCALNET_RPC_URL;
  }
  if (!candidate) return DEFAULT_RPC_URL;
  if (looksLikeMainnetUrl(candidate) && allowedCluster(env) !== 'mainnet-beta') {
    return DEFAULT_RPC_URL;
  }
  return candidate;
}

/**
 * Jito block engine URL, or '' when Jito is disabled. There is no default:
 * Jito is off unless a URL is configured, and a URL that names mainnet is
 * refused unless mainnet was explicitly allowed.
 */
export function resolveJitoUrl(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = (explicit ?? env.JITO_BLOCK_ENGINE_URL ?? '').trim().replace(/\/$/, '');
  if (!candidate) return '';
  if (allowedCluster(env) === 'localnet') return '';
  if (looksLikeMainnetUrl(candidate) && allowedCluster(env) !== 'mainnet-beta') return '';
  return candidate;
}

/** The public Jito tip-floor service is mainnet-only, so it is only reachable when mainnet is allowed. */
export function jitoTipFloorAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return allowedCluster(env) === 'mainnet-beta';
}

/**
 * Throws when ALLOWED_CLUSTER is mainnet-beta. Called wherever the app could arm LIVE, sign or send, so that a mainnet setting can only
 * ever be used for watching and paper trading. `assertClusterAllowed` is not changed: readiness uses it to check the RPC, and a read-only
 * server watching mainnet must keep passing that check.
 */
export function assertSendClusterAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (allowedCluster(env) === 'mainnet-beta') {
    throw new ClusterGuardError('ALLOWED_CLUSTER=mainnet-beta: this build never arms LIVE, signs or sends on mainnet (devnet and localnet only); refusing');
  }
}

/**
 * Throws unless the connection's genesis hash matches the allowed cluster.
 * Called before every signed buy and sell. Any RPC error fails closed.
 */
export async function assertClusterAllowed(
  connection: Pick<Connection, 'getGenesisHash'> & { rpcEndpoint?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ cluster: AllowedCluster; genesisHash: string }> {
  const cluster = allowedCluster(env);
  if (cluster === 'localnet') {
    if (!connection.rpcEndpoint || !isLoopbackUrl(connection.rpcEndpoint)) {
      throw new ClusterGuardError('localnet requires a loopback RPC endpoint; refusing to send');
    }
  }
  const expected = expectedGenesisHash(env);
  let genesisHash: string;
  try {
    genesisHash = await connection.getGenesisHash();
  } catch (err: any) {
    throw new ClusterGuardError(`could not read genesis hash (${err?.message ?? 'unknown error'}); refusing to send`);
  }
  if (genesisHash !== expected) {
    throw new ClusterGuardError(
      `genesis hash ${genesisHash} does not match allowed cluster ${cluster} (${expected}); refusing to send`
    );
  }
  return { cluster, genesisHash };
}

/** S208: how long a passed genesis check is trusted for the same Connection object. */
export const GENESIS_CHECK_TTL_MS = 60_000;

type GenesisCheck = { cluster: AllowedCluster; expected: string; at: number };
const passedGenesisChecks = new WeakMap<object, GenesisCheck>();

/** Record that `connection` just passed `assertClusterAllowed`, so the next sends can skip the genesis RPC call for GENESIS_CHECK_TTL_MS. */
export function rememberGenesisCheck(connection: object, env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  passedGenesisChecks.set(connection, { cluster: allowedCluster(env), expected: expectedGenesisHash(env), at: now });
}

/**
 * R1-1/N-27: drop a remembered pass for `connection`, so the next send asks the RPC for its genesis hash again. Called when the heartbeat's
 * cluster check fails (`verifyCluster`), when the RPC endpoint is switched, and when the send-path check itself fails.
 */
export function forgetGenesisCheck(connection: object): void {
  passedGenesisChecks.delete(connection);
}

/**
 * `assertClusterAllowed` for the send path, without a genesis RPC call on every order. A pass is remembered per Connection object for
 * GENESIS_CHECK_TTL_MS. A new Connection (RPC change or failover), a changed ALLOWED_CLUSTER or an expired entry checks again, a failure is never
 * remembered, and a failed check anywhere (`forgetGenesisCheck`) removes the pass. The localnet loopback check is cheap and always runs. The mainnet-beta refusal is `assertSendClusterAllowed`, which stays uncached.
 */
export async function assertClusterAllowedCached(
  connection: Pick<Connection, 'getGenesisHash'> & { rpcEndpoint?: string },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): Promise<{ cluster: AllowedCluster; genesisHash: string }> {
  const cluster = allowedCluster(env);
  const hit = passedGenesisChecks.get(connection);
  if (hit && hit.cluster === cluster && hit.expected === expectedGenesisHash(env) && now - hit.at < GENESIS_CHECK_TTL_MS) {
    if (cluster === 'localnet' && (!connection.rpcEndpoint || !isLoopbackUrl(connection.rpcEndpoint))) {
      throw new ClusterGuardError('localnet requires a loopback RPC endpoint; refusing to send');
    }
    return { cluster, genesisHash: hit.expected };
  }
  let res: { cluster: AllowedCluster; genesisHash: string };
  try {
    res = await assertClusterAllowed(connection, env);
  } catch (err) {
    forgetGenesisCheck(connection);
    throw err;
  }
  rememberGenesisCheck(connection, env, now);
  return res;
}

/** S210: opt-in second opinion on the cluster. Off unless APEX_VERIFY_BLOCKHASH=true. */
export function blockhashCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APEX_VERIFY_BLOCKHASH === 'true';
}

export type BlockhashVerdict =
  | { ok: true; skipped?: string }
  | { ok: false; reason: string; /** true when the reference RPC answered "not valid"; false when it could not be asked */ definite: boolean };

export interface BlockhashCheckDeps {
  isValid?: (blockhash: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

let referenceConnection: Connection | null = null;
async function referenceIsValid(blockhash: string): Promise<boolean> {
  referenceConnection ??= new Connection(DEFAULT_RPC_URL, 'processed');
  return (await referenceConnection.isBlockhashValid(blockhash, { commitment: 'processed' })).value;
}

/**
 * R3-6: how long a SELL waits on a "no" before calling it definite. The public reference node can lag the configured RPC by a few slots
 * (a fresh blockhash is a slot or two old), and a definite "no" refuses the sell, a stop-loss included. So a SELL asks again after each of
 * these delays (6.5 s in all, bounded) and is refused only if every answer is "no". A BUY keeps the single retry after 500 ms: refusing
 * a buy costs nothing.
 */
export const SELL_BLOCKHASH_RECHECK_DELAYS_MS = [500, 1000, 2000, 3000] as const;
const BUY_BLOCKHASH_RECHECK_DELAYS_MS = [500] as const;

/**
 * Asks an INDEPENDENT RPC (the public devnet endpoint, not the configured one) whether the order's blockhash exists on devnet. An RPC that
 * claims devnet but is really mainnet hands out blockhashes devnet has never seen, so this catches it where the genesis check cannot. A "no"
 * is asked again (once after 500 ms for a BUY; for a SELL after each of SELL_BLOCKHASH_RECHECK_DELAYS_MS, R3-6), because the public node can
 * lag a few slots behind the configured one. A lookup that fails is never definite.
 * Skipped when the flag is off, on localnet (its blockhashes are local) and on mainnet-beta (sends are refused before this point).
 */
export async function verifyBlockhashIndependently(
  blockhash: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: BlockhashCheckDeps = {},
  side: 'BUY' | 'SELL' = 'BUY'
): Promise<BlockhashVerdict> {
  if (!blockhashCheckEnabled(env)) return { ok: true, skipped: 'APEX_VERIFY_BLOCKHASH is not true' };
  const cluster = allowedCluster(env);
  if (cluster !== 'devnet') return { ok: true, skipped: `not checked on ${cluster}` };
  const isValid = deps.isValid ?? referenceIsValid;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = side === 'SELL' ? SELL_BLOCKHASH_RECHECK_DELAYS_MS : BUY_BLOCKHASH_RECHECK_DELAYS_MS;
  try {
    if (await isValid(blockhash)) return { ok: true };
    for (const ms of delays) {
      await sleep(ms);
      if (await isValid(blockhash)) return { ok: true };
    }
    const waitedMs = delays.reduce((a, b) => a + b, 0);
    return { ok: false, definite: true, reason: `blockhash ${blockhash} is not known to the independent devnet RPC after ${delays.length + 1} checks over ${waitedMs} ms; the configured RPC may not be on devnet` };
  } catch (err: any) {
    return { ok: false, definite: false, reason: `could not ask the independent devnet RPC about the blockhash (${err?.message ?? 'unknown error'})` };
  }
}
