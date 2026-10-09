import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { AuthManager, resolveBindHost } from '../server/middleware/auth';

const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const compose = fs.readFileSync('docker-compose.yml', 'utf8');

/** Collect the ENV pairs of the runner stage (the last FROM). */
function runnerEnv(): Record<string, string> {
  const runner = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
  const block = runner.match(/^ENV\s+((?:.*\\\n)*.*)$/m)?.[1] ?? '';
  const env: Record<string, string> = {};
  for (const m of block.replace(/\\\n/g, ' ').matchAll(/(\w+)=(\S+)/g)) env[m[1]] = m[2];
  return env;
}

describe('K2 #29: container and compose defaults', () => {
  it('the runner image binds so a published port works (resolveBindHost with the Dockerfile ENV)', () => {
    const env = runnerEnv();
    expect(env.BIND_HOST).toBe('0.0.0.0');
    const res = resolveBindHost(env as any);
    expect(res.host).toBe('0.0.0.0'); // before: BIND_HOST=0.0.0.0 without ALLOW_PUBLIC_BIND was ignored and the app bound 127.0.0.1 inside the container
  });

  it('the image is devnet-only by default and marked as a container', () => {
    const env = runnerEnv();
    expect(env.ALLOWED_CLUSTER).toBe('devnet');
    expect(env.APEX_CONTAINER).toBe('true');
  });

  it('compose publishes on the host loopback only', () => {
    expect(compose).toMatch(/-\s*'127\.0\.0\.1:3000:3000'/);
    expect(compose).not.toMatch(/-\s*'3000:3000'/);
  });

  it('compose has no mainnet RPC or Jito defaults and the sniper is off by default', () => {
    expect(compose).not.toMatch(/mainnet/i);
    expect(compose).not.toContain('block-engine.jito.wtf');
    expect(compose).toMatch(/SOLANA_RPC_URL=\$\{SOLANA_RPC_URL:-https:\/\/api\.devnet\.solana\.com\}/);
    expect(compose).toMatch(/ALLOWED_CLUSTER=\$\{ALLOWED_CLUSTER:-devnet\}/);
    expect(compose).toMatch(/MEMECOIN_SNIPER_ENABLED=\$\{MEMECOIN_SNIPER_ENABLED:-false\}/);
  });

  it('compose refuses to start without an operator token instead of generating one into the logs', () => {
    expect(compose).toMatch(/OPERATOR_AUTH_TOKEN=\$\{OPERATOR_AUTH_TOKEN:\?/);
  });
});

describe('K2 #29: generated operator token is not printed in a container', () => {
  const saved = { token: process.env.OPERATOR_AUTH_TOKEN, c: process.env.APEX_CONTAINER };
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.token === undefined) delete process.env.OPERATOR_AUTH_TOKEN; else process.env.OPERATOR_AUTH_TOKEN = saved.token;
    if (saved.c === undefined) delete process.env.APEX_CONTAINER; else process.env.APEX_CONTAINER = saved.c;
  });

  const bootAndCapture = () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.OPERATOR_AUTH_TOKEN;
    const mgr = new AuthManager();
    const token = (mgr as any).primaryOperatorToken as string;
    return { out: spy.mock.calls.map((c) => c.join(' ')).join('\n'), token };
  };

  it('outside a container the banner still shows the token', () => {
    delete process.env.APEX_CONTAINER;
    const { out, token } = bootAndCapture();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(out).toContain(token);
  });

  it('in a container (APEX_CONTAINER=true) the token is not in the output, and a hint is', () => {
    process.env.APEX_CONTAINER = 'true';
    const { out, token } = bootAndCapture();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(out).not.toContain(token);
    expect(out).toContain('OPERATOR_AUTH_TOKEN');
  });
});
