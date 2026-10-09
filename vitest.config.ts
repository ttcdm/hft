import { defineConfig } from 'vitest/config';
import path from 'path';

// Force hermetic test execution: isolate database and keys unconditionally
process.env.TEST_DB_PATH = ':memory:';
process.env.SIGNER_KEYPAIR_PATH = path.resolve(__dirname, '.nonexistent_test_keypair.json');
delete process.env.OPERATOR_PRIVATE_KEY;
delete process.env.SOLANA_PRIVATE_KEY;

export default defineConfig({
  test: {
    env: {
      TEST_DB_PATH: ':memory:',
      SIGNER_KEYPAIR_PATH: path.resolve(__dirname, '.nonexistent_test_keypair.json'),
      OPERATOR_PRIVATE_KEY: '',
      SOLANA_PRIVATE_KEY: '',
      JITO_BLOCK_ENGINE_URL: 'http://127.0.0.1:9',
      ALLOWED_CLUSTER: 'devnet',
      // Hermetic: any Connection built from the default env points at a closed loopback port, never a real cluster.
      SOLANA_RPC_URL: 'http://127.0.0.1:9',
      SOLANA_WS_URL: 'ws://127.0.0.1:9',
    },
    setupFiles: ['./tests/setup/devnetGuard.ts'],
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    server: {
      deps: {
      inline: [/@solana\//, /@pump-fun\//, /bs58/],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      'bs58': path.resolve(__dirname, 'bs58-shim.mjs'),
    },
  },
});
