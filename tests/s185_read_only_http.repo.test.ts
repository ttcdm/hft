import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startApp, startRpcStub, scratchDir, baseEnv, LOCALNET_STUB_GENESIS, type AppHandle, type RpcStub } from './helpers/liveServer';

let stub: RpcStub; let app: AppHandle; let dir: string;
beforeAll(async () => {
  stub = await startRpcStub(LOCALNET_STUB_GENESIS);
  dir = scratchDir('s185-');
  // read-only: no signing key anywhere. baseEnv would add a throwaway SIGNER_KEYPAIR_PATH, so it is blanked here.
  app = await startApp(dir, { SOLANA_RPC_URL: stub.url, ALLOWED_CLUSTER: 'localnet', LOCALNET_GENESIS_HASH: LOCALNET_STUB_GENESIS, APEX_READ_ONLY: 'true', SIGNER_KEYPAIR_PATH: '', AUTO_SNIPE_ENABLED: 'true' });
}, 120_000);
afterAll(async () => { await app?.stop(); await stub?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('S185 read-only server over HTTP', () => {
  it('arm and disarm both answer 409 READ_ONLY and mode stays PAPER', async () => {
    const arm = await app.call('POST', '/api/execution/arm', { arm: true, confirmationCode: 'CONFIRM_LIVE_TRADING' });
    expect(arm.status).toBe(409);
    expect(arm.json.error).toBe('READ_ONLY');
    expect((await app.call('POST', '/api/execution/arm', { arm: false })).status).toBe(409);
    const audit = (await app.call('GET', '/api/diagnostics/system')).json;
    expect(audit.systemAudit.readOnly).toBe(true);
    expect(audit.systemAudit.executionMode ?? 'PAPER').toBe('PAPER');
  });
  it('System checks show the read-only row, the capacity row, and a signer that is absent by design', async () => {
    const r = (await app.call('GET', '/api/system/checks')).json;
    const byId = Object.fromEntries(r.checks.map((c: any) => [c.id, c]));
    expect(byId.readonly.value).toBe('LOCALNET · READ-ONLY · PAPER');
    expect(byId.signer.status).toBe('OK');
    expect(byId.signer.value).toMatch(/read-only by design/);
    expect(byId.capacity.value).toMatch(/of 250/);
  });
  it('S186: /api/signer/generate is 409 and writes no key file', async () => {
    const r = await app.call('POST', '/api/signer/generate', {});
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('READ_ONLY');
    expect(fs.existsSync(path.join(dir, '.apex_trading_keypair.json'))).toBe(false);
    const sg = (await app.call('GET', '/api/system/checks')).json.checks.find((c: any) => c.id === 'signer');
    expect(sg.value).toMatch(/read-only by design/);
  });
  it('auto refuses DEVNET_LIVE and allows PAPER, and nothing was sent', async () => {
    const live = await app.call('POST', '/api/auto/mode', { mode: 'DEVNET_LIVE', confirmationCode: 'CONFIRM_AUTO_DEVNET' });
    expect(live.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(live.json)).toMatch(/READ_ONLY|read-only|APEX_READ_ONLY/i);
    expect(stub.count('sendTransaction')).toBe(0);
    expect(stub.methods.filter((m) => /^send|requestAirdrop/.test(m))).toEqual([]);
  });
});

describe('S185 the server refuses to start next to a key', () => {
  const tsxEsm = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx/esm')).href;
  const boot = (extra: Record<string, string>) => {
    const d = scratchDir('s185-boot-');
    try {
      return spawnSync(process.execPath, ['--import', tsxEsm, path.resolve('server.ts')], {
        cwd: d, encoding: 'utf8', timeout: 90_000,
        env: { ...baseEnv(d, { APP_PORT: '0', APEX_READ_ONLY: 'true', ...extra }) },
      });
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  it('exits 1 and names OPERATOR_PRIVATE_KEY', () => {
    const r = boot({ SIGNER_KEYPAIR_PATH: '', OPERATOR_PRIVATE_KEY: '[1,2,3]' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING TO START[\s\S]*OPERATOR_PRIVATE_KEY is set/);
  }, 100_000);
  it('S186: exits 1 when the default .apex_trading_keypair.json sits in the working directory', () => {
    const d = scratchDir('s186-boot-');
    try {
      fs.writeFileSync(path.join(d, '.apex_trading_keypair.json'), '[1,2,3]');
      const r = spawnSync(process.execPath, ['--import', tsxEsm, path.resolve('server.ts')], {
        cwd: d, encoding: 'utf8', timeout: 90_000, env: { ...baseEnv(d, { APP_PORT: '0', APEX_READ_ONLY: 'true', SIGNER_KEYPAIR_PATH: '' }) },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/\.apex_trading_keypair\.json exists/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }, 100_000);
  it('exits 1 and names SIGNER_KEYPAIR_PATH', () => {
    const r = boot({}); // baseEnv sets a throwaway SIGNER_KEYPAIR_PATH
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SIGNER_KEYPAIR_PATH is set/);
  }, 100_000);
});
