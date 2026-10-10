import { defineConfig } from 'vitest/config';
import path from 'path';
import os from 'os';

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
      // T12: the engine WAL is a file; tests must not append to the checkout's apex_engine.wal.
      APEX_WAL_PATH: path.join(os.tmpdir(), `apex-vitest-${process.pid}.wal`),
      // T11: nothing the shell exports may turn a test into a live, auto-trading or notifying run. Tests that need a value stub it.
      APEX_ENV_FILE: '',
      ALLOW_LIVE_REAL_MONEY_TRADING: '',
      AUTO_SNIPE_ENABLED: '',
      AUTO_MANAGE_RECOVERED: '',
      DEMO_MODE: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
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
