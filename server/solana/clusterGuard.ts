import type { Connection } from '@solana/web3.js';

/**
 * Cluster guard. Nothing in this repo may sign or send a transaction unless the
 * RPC endpoint reports the genesis hash of the cluster Mike has explicitly
 * allowed. The default (and only cluster used by tests and the devnet harness)
 * is devnet. Mainnet needs ALLOWED_CLUSTER=mainnet-beta, which nobody sets
 * in this repo.
 */

export type AllowedCluster = 'devnet' | 'mainnet-beta';

export const CLUSTER_GENESIS_HASH: Readonly<Record<AllowedCluster, string>> = {
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
  return env.ALLOWED_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
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
  if (looksLikeMainnetUrl(candidate) && allowedCluster(env) !== 'mainnet-beta') return '';
  return candidate;
}

/** The public Jito tip-floor service is mainnet-only, so it is only reachable when mainnet is allowed. */
export function jitoTipFloorAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return allowedCluster(env) === 'mainnet-beta';
}

/**
 * Throws unless the connection's genesis hash matches the allowed cluster.
 * Called before every signed buy and sell. Any RPC error fails closed.
 */
export async function assertClusterAllowed(
  connection: Pick<Connection, 'getGenesisHash'>,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ cluster: AllowedCluster; genesisHash: string }> {
  const cluster = allowedCluster(env);
  let genesisHash: string;
  try {
    genesisHash = await connection.getGenesisHash();
  } catch (err: any) {
    throw new ClusterGuardError(`could not read genesis hash (${err?.message ?? 'unknown error'}); refusing to send`);
  }
  if (genesisHash !== CLUSTER_GENESIS_HASH[cluster]) {
    throw new ClusterGuardError(
      `genesis hash ${genesisHash} does not match allowed cluster ${cluster} (${CLUSTER_GENESIS_HASH[cluster]}); refusing to send`
    );
  }
  return { cluster, genesisHash };
}
