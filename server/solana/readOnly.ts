import fs from 'fs';

/**
 * S185: read-only mode (APEX_READ_ONLY=true). The app watches a cluster and paper trades against what it sees; it cannot sign or send
 * anything. It is strictly additive: with the flag off nothing here changes behaviour, and no existing cluster rule is relaxed.
 *
 * What it guarantees while on:
 *  - startup refuses if any signing key is configured (OPERATOR_PRIVATE_KEY, SOLANA_PRIVATE_KEY, SIGNER_KEYPAIR_PATH, or a default .apex_trading_keypair.json), or real-money
 *    trading is enabled, so a leftover key can never sit next to a mainnet RPC;
 *  - the signer loads no key at all, refuses to sign, and refuses to generate or import one (so no key can appear while running);
 *  - every transport (RPC send, Jito bundle) throws before it touches the network;
 *  - arming live trading is refused (HTTP 409);
 *  - auto allows only OFF, SHADOW and PAPER.
 * It works on any cluster, so it is tested on localnet and devnet; the banner names the cluster it runs on.
 */
export class ReadOnlyError extends Error {
  public readonly code = 'READ_ONLY';
  constructor(what: string) {
    super(`READ_ONLY: ${what}. APEX_READ_ONLY=true: this server watches and paper trades only; it cannot sign or send a transaction.`);
    this.name = 'ReadOnlyError';
  }
}

export function isReadOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.APEX_READ_ONLY === 'true';
}

/** Throws ReadOnlyError while read-only mode is on. Called at every point that could sign or send. */
export function assertNotReadOnly(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isReadOnly(env)) throw new ReadOnlyError(`${what} refused`);
}

/** Reasons the server must not start in read-only mode. Empty when it may. */
export function readOnlyStartupProblems(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  if (!isReadOnly(env)) return [];
  const problems: string[] = [];
  for (const name of ['OPERATOR_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY', 'SIGNER_KEYPAIR_PATH'] as const) {
    if ((env[name] ?? '').trim() !== '') problems.push(`${name} is set. Remove it: a read-only server must not have a signing key anywhere it can read.`);
  }
  if (defaultKeyFileExists(cwd)) problems.push(`${cwd}/.apex_trading_keypair.json exists. Move it away: a read-only server must not have a signing key anywhere it can read.`);
  if (env.ALLOW_LIVE_REAL_MONEY_TRADING === 'true') problems.push('ALLOW_LIVE_REAL_MONEY_TRADING=true contradicts APEX_READ_ONLY=true. Remove it.');
  return problems;
}

/** Called once at boot. Prints every problem and exits non-zero rather than start next to a key. */
export function assertReadOnlyStartup(env: NodeJS.ProcessEnv = process.env, exit: (code: number) => never = (c) => process.exit(c), cwd: string = process.cwd()): void {
  const problems = readOnlyStartupProblems(env, cwd);
  if (problems.length === 0) return;
  console.error(`[APEX QUANT HFT] REFUSING TO START (read-only mode):\n  - ${problems.join('\n  - ')}`);
  exit(1);
}

/** Whether a default key file sits where a non-read-only server would load it. Read-only never reads it, and refuses to start while it exists. */
export function defaultKeyFileExists(cwd: string = process.cwd()): boolean {
  try { return fs.existsSync(`${cwd}/.apex_trading_keypair.json`); } catch { return false; }
}
