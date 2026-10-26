import { describe, it, expect } from 'vitest';
import { networkPassThroughEnv } from '../scripts/devnet_e2e_steps';

/**
 * Cloud run 28: (o)'s child server.ts got an exact env without the session's proxy settings, so it never read a SOL/USD price. The harness
 * now passes the proxy and CA variables and the parent's `--require` preloads through, and only those.
 */
describe('networkPassThroughEnv', () => {
  it('the Mac (none of them set): nothing, so the child env is exactly what the step builds', () => {
    expect(networkPassThroughEnv({ PATH: '/usr/bin', HOME: '/Users/x', SOLANA_RPC_URL: 'https://rpc', NODE_OPTIONS: '' })).toEqual({});
  });

  it('a cloud session: the proxy, CA and env-proxy variables, and only the --require preloads of NODE_OPTIONS', () => {
    const env = networkPassThroughEnv({
      HTTPS_PROXY: 'http://127.0.0.1:3000', https_proxy: 'http://127.0.0.1:3000', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
      HTTP_PROXY: '', NODE_EXTRA_CA_CERTS: '/ca.crt', NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: '--use-openssl-ca --require /tools/cloud-ws-proxy.cjs --max-old-space-size=4096 -r ./a.cjs --require=./b.cjs',
      SOLANA_RPC_URL: 'https://secret-rpc', SIGNER_KEYPAIR_PATH: '/k.json', PATH: '/usr/bin',
    });
    expect(env).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:3000', https_proxy: 'http://127.0.0.1:3000', NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: '/ca.crt', NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: '--require /tools/cloud-ws-proxy.cjs --require ./a.cjs --require ./b.cjs',
    });
  });

  it('NODE_OPTIONS without a preload is not passed', () => {
    expect(networkPassThroughEnv({ NODE_OPTIONS: '--use-openssl-ca', HTTPS_PROXY: 'http://p' })).toEqual({ HTTPS_PROXY: 'http://p' });
  });
});
