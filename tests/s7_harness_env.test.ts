import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { baseEnv, scratchDir } from './helpers/liveServer';

describe('S7: no harness child can default to a public RPC or to the checkout WAL', () => {
  it('liveServer baseEnv points the RPC at a closed loopback port on the local cluster, and an explicit value still wins', () => {
    const d = scratchDir('s7-');
    const e = baseEnv(d, {});
    expect(e.SOLANA_RPC_URL).toBe('http://127.0.0.1:9');
    expect(e.ALLOWED_CLUSTER).toBe('localnet');
    expect(e.LOCALNET_GENESIS_HASH).toBeTruthy();
    expect(e.APEX_DISABLE_EXTERNAL_FEEDS).toBe('true');
    expect(baseEnv(d, { SOLANA_RPC_URL: 'http://127.0.0.1:1234' }).SOLANA_RPC_URL).toBe('http://127.0.0.1:1234');
    fs.rmSync(d, { recursive: true, force: true });
  });
  it('the e2e script pins the server\'s WAL and checks the checkout\'s WAL did not grow (the check itself is proven by running the script)', () => {
    const src = fs.readFileSync('scripts/localnet/e2e.ts', 'utf8');
    expect(src).toMatch(/APEX_WAL_PATH: path\.join\(scratch, 'app\.wal'\)/);
    expect(src).toMatch(/the checkout apex_engine\.wal was not written by this run/);
  });
});
