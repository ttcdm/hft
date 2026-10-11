import { describe, it, expect, vi, afterEach } from 'vitest';
import { VersionedTransaction, Connection } from '@solana/web3.js';
import { isReadOnly, assertNotReadOnly, readOnlyStartupProblems, assertReadOnlyStartup, ReadOnlyError } from '../server/solana/readOnly';
import { LocalKeypairSigner } from '../server/solana/signer';
import { SolanaRpcTransport, JitoTransport } from '../server/solana/transports';
import { AutoSnipeController } from '../server/auto/controller';
import { executionCoordinator } from '../server/execution/coordinator';
import { watchMaxCandidates, poolStatsMaxMints } from '../server/signals/capacity';
import { WatchWindow } from '../server/signals/watchWindow';
import { readOnlyBannerText } from '../src/utils/tradingMode';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('S185 the flag and the startup refusal', () => {
  it('is off unless APEX_READ_ONLY is exactly "true"', () => {
    expect(isReadOnly({})).toBe(false);
    expect(isReadOnly({ APEX_READ_ONLY: '1' } as any)).toBe(false);
    expect(isReadOnly({ APEX_READ_ONLY: 'true' } as any)).toBe(true);
    expect(() => assertNotReadOnly('x', {})).not.toThrow();
    expect(() => assertNotReadOnly('x', { APEX_READ_ONLY: 'true' } as any)).toThrow(ReadOnlyError);
  });
  it('lists every signing key and the real-money switch as a reason not to start, and nothing when the flag is off', () => {
    expect(readOnlyStartupProblems({ OPERATOR_PRIVATE_KEY: 'k' } as any)).toEqual([]);
    const p = readOnlyStartupProblems({ APEX_READ_ONLY: 'true', OPERATOR_PRIVATE_KEY: 'k', SIGNER_KEYPAIR_PATH: '/x', SOLANA_PRIVATE_KEY: 'z', ALLOW_LIVE_REAL_MONEY_TRADING: 'true' } as any);
    expect(p).toHaveLength(4);
    expect(readOnlyStartupProblems({ APEX_READ_ONLY: 'true', OPERATOR_PRIVATE_KEY: '  ' } as any)).toEqual([]);
  });
  it('exits non-zero with the problems printed', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn((_c: number) => { throw new Error('exit'); }) as any;
    expect(() => assertReadOnlyStartup({ APEX_READ_ONLY: 'true', OPERATOR_PRIVATE_KEY: 'k' } as any, exit)).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toMatch(/OPERATOR_PRIVATE_KEY is set/);
    expect(() => assertReadOnlyStartup({} as any, exit)).not.toThrow();
  });
});

describe('S185 nothing can sign or send', () => {
  it('the signer loads no key even when a key path is configured, and refuses to sign', async () => {
    vi.stubEnv('APEX_READ_ONLY', 'true');
    vi.stubEnv('SIGNER_KEYPAIR_PATH', '/nonexistent/key.json');
    vi.stubEnv('OPERATOR_PRIVATE_KEY', '[1,2,3]');
    const s = new LocalKeypairSigner();
    expect(s.getStatus()).toBe('NOT_CONFIGURED');
    await expect(s.signMessage(new Uint8Array([1]))).rejects.toThrow(/READ_ONLY/);
    await expect(s.signTransaction({} as VersionedTransaction)).rejects.toThrow(/READ_ONLY/);
  });
  it('both network transports throw before they touch the connection or fetch', async () => {
    vi.stubEnv('APEX_READ_ONLY', 'true');
    const conn = { sendRawTransaction: vi.fn(), rpcEndpoint: 'http://127.0.0.1:9' } as unknown as Connection;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network used'));
    const tx = { serialize: () => new Uint8Array([1]), signatures: [new Uint8Array(64)], message: {} } as unknown as VersionedTransaction;
    await expect(new SolanaRpcTransport(conn).submit(tx)).rejects.toThrow(/READ_ONLY/);
    await expect(new JitoTransport(conn, 'http://127.0.0.1:9').submit(tx)).rejects.toThrow(/READ_ONLY/);
    expect((conn as any).sendRawTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('arming live trading is refused, forces PAPER, and live readiness carries the reason', () => {
    vi.stubEnv('APEX_READ_ONLY', 'true');
    const r = executionCoordinator.armLiveTrading(true, 'ANYTHING');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/READ_ONLY/);
    expect(executionCoordinator.getExecutionMode()).toBe('PAPER');
    const c = executionCoordinator.canExecuteLive();
    expect(c.allowed).toBe(false);
    expect(c.reasons[0]).toMatch(/READ_ONLY/);
  });
  it('auto accepts OFF, SHADOW and PAPER and refuses DEVNET_LIVE', async () => {
    vi.stubEnv('APEX_READ_ONLY', 'true');
    vi.stubEnv('AUTO_SNIPE_ENABLED', 'true');
    const c = new AutoSnipeController();
    const live = await c.setMode('DEVNET_LIVE', { confirmationCode: 'CONFIRM_AUTO_DEVNET' });
    expect(live.ok).toBe(false);
    expect(live.error).toMatch(/APEX_READ_ONLY=true allows OFF, SHADOW and PAPER only/);
    expect((await c.setMode('SHADOW')).ok).toBe(true);
    expect((await c.setMode('OFF')).ok).toBe(true);
  });
});

describe('S185 capacity for mainnet volume', () => {
  it('watch window is 60 normally, 250 read-only, overridable within 10..2000', () => {
    expect(watchMaxCandidates({})).toBe(60);
    expect(watchMaxCandidates({ APEX_READ_ONLY: 'true' } as any)).toBe(250);
    expect(watchMaxCandidates({ APEX_WATCH_MAX_CANDIDATES: '500' } as any)).toBe(500);
    expect(watchMaxCandidates({ APEX_WATCH_MAX_CANDIDATES: '5' } as any)).toBe(60);
    expect(watchMaxCandidates({ APEX_WATCH_MAX_CANDIDATES: '9999' } as any)).toBe(60);
    expect(poolStatsMaxMints({})).toBe(300);
    expect(poolStatsMaxMints({ APEX_READ_ONLY: 'true' } as any)).toBe(750);
  });
  it('a full window counts the launches it could not watch', () => {
    const w = new WatchWindow({ maxCandidates: 10 });
    for (let i = 0; i < 25; i++) w.watch(`M${i}`, `C${i}`);
    const cap = w.getSnapshot().capacity;
    expect(cap.active).toBe(10);
    expect(cap.max).toBe(10);
    expect(cap.refusedFull).toBe(15);
  });
});

describe('S185 banner text', () => {
  it('says MAINNET only for mainnet-beta and names the real cluster otherwise', () => {
    expect(readOnlyBannerText({ readOnly: true, cluster: 'mainnet-beta' })).toBe('MAINNET · READ-ONLY · PAPER');
    expect(readOnlyBannerText({ readOnly: true, cluster: 'devnet' })).toBe('DEVNET · READ-ONLY · PAPER');
    expect(readOnlyBannerText({ readOnly: false, cluster: 'mainnet-beta' })).toBeNull();
  });
});
