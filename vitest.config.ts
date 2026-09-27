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
    },
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
