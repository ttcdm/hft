import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { baseEnv, scratchDir } from './helpers/liveServer';

describe('S7: no harness child can default to a public RPC', () => {
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
});
