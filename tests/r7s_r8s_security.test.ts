import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { LocalKeypairSigner } from '../server/solana/signer';
import { parseSecretKey } from '../server/solana/parseSecretKey';
import { walletTrader } from '../server/walletTrader';
import { riskEngine } from '../server/risk/riskEngine';
import { executionConfig } from '../server/solana/executionConfig';

// R7s: a malformed key file must not put any of its text in the logs (Node's JSON.parse errors quote the input).
describe('R7s: malformed keypair material never reaches the logs', () => {
  // Starts the bad token at the front of the text: Node's JSON.parse error quotes the first ~10 characters around the failure.
  const MARKER = 'Q7Q7Q7Q7Q7Q7';
  let dir: string;
  let logged: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7s-'));
    logged = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a key file with broken JSON locks the signer and logs nothing from the file', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, `[${MARKER},34,56,78]`, { mode: 0o600 });
    vi.stubEnv('SIGNER_KEYPAIR_PATH', file);
    const signer = new LocalKeypairSigner();
    expect(signer.getStatus()).toBe('LOCKED');
    const out = logged.join('\n');
    expect(out).toMatch(/Failed to load keypair/); // it did log the failure ...
    expect(out).not.toContain(MARKER); // ... without the key text
    expect(out).not.toContain('Q7Q7');
  });

  it('bad key material in OPERATOR_PRIVATE_KEY is not echoed either', () => {
    vi.stubEnv('OPERATOR_PRIVATE_KEY', `[${MARKER},2]`);
    vi.stubEnv('SIGNER_KEYPAIR_PATH', path.join(dir, 'absent.json'));
    new LocalKeypairSigner();
    expect(logged.join('\n')).not.toContain(MARKER);
  });

  it('importKeypair (the HTTP/CLI import path) throws a message without the input', () => {
    vi.stubEnv('SIGNER_KEYPAIR_PATH', path.join(dir, 'absent.json'));
    const signer = new LocalKeypairSigner();
    let msg = '';
    try { signer.importKeypair(`[${MARKER},2]`, true); } catch (e: any) { msg = String(e.message); }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(MARKER);
  });

  it('parseSecretKey still accepts a JSON array and base58', () => {
    expect(parseSecretKey('[1, 2, 3]')).toEqual(Uint8Array.from([1, 2, 3]));
    expect(parseSecretKey('2NEpo7TZRRrLZSi2U')).toBeInstanceOf(Uint8Array);
    expect(() => parseSecretKey('{"a":1}')).toThrow(/not a valid/);
    expect(() => parseSecretKey('[1,2,3')).toThrow(/not a valid/);
    expect(() => parseSecretKey('[]')).not.toThrow();
  });
});

// R8s: the HTTP-reachable config may lower the trade size, never raise it past the environment's ceiling.
describe('R8s: /api/wallet/config cannot raise maxPositionSizeSol past MAX_POSITION_SIZE_SOL', () => {
  // updateConfig ends with a balance sync that starts price feeds; this file is about the limit, so keep it offline
  beforeEach(() => { vi.spyOn(walletTrader as any, 'syncRpcBalance').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  it('refuses a raise to 50 SOL, changes nothing, and still allows lowering', async () => {
    const ceiling = executionConfig.getConfig().maxPositionSizeSol;
    const before = (riskEngine as any).limits.maxPositionSol;
    const cfgBefore = walletTrader.getConfig().riskLimits.maxPositionSizeSol;
    await expect(walletTrader.updateConfig({ riskLimits: { ...walletTrader.getConfig().riskLimits, maxPositionSizeSol: 50 } })).rejects.toThrow(/exceeds the configured ceiling/);
    expect((riskEngine as any).limits.maxPositionSol).toBe(before);
    expect(walletTrader.getConfig().riskLimits.maxPositionSizeSol).toBe(cfgBefore);

    const lower = Math.max(0.005, ceiling / 2);
    await walletTrader.updateConfig({ riskLimits: { ...walletTrader.getConfig().riskLimits, maxPositionSizeSol: lower } });
    expect((riskEngine as any).limits.maxPositionSol).toBe(lower);
    await walletTrader.updateConfig({ riskLimits: { ...walletTrader.getConfig().riskLimits, maxPositionSizeSol: ceiling } }); // exactly the ceiling is fine
    expect((riskEngine as any).limits.maxPositionSol).toBe(ceiling);
  });

  it('a refused request is atomic: other fields in the same body are not applied', async () => {
    const alloc = walletTrader.getConfig().allocatedSol;
    await expect(walletTrader.updateConfig({ allocatedSol: alloc + 1, riskLimits: { ...walletTrader.getConfig().riskLimits, maxPositionSizeSol: 50 } })).rejects.toThrow();
    expect(walletTrader.getConfig().allocatedSol).toBe(alloc);
  });
});
