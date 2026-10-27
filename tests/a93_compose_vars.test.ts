import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { executionConfig } from '../server/solana/executionConfig';

/**
 * A93: docker-compose.yml passed the unread BINANCE_* secrets into the container and defaulted DEFAULT_JITO_TIP_SOL to 0.005, 28 times
 * the code's own default. Real executionConfig (a fresh instance built with the variable unset); the compose file is read as text.
 */
const compose = fs.readFileSync('docker-compose.yml', 'utf8');

describe('A93: compose passes only what the code reads, with the code\'s defaults', () => {
  it('no BINANCE_* variable is passed into the container, and the compose default for DEFAULT_JITO_TIP_SOL is the code\'s own default', () => {
    expect(compose).not.toMatch(/BINANCE_/);
    const m = /DEFAULT_JITO_TIP_SOL=\$\{DEFAULT_JITO_TIP_SOL:-([0-9.]+)\}/.exec(compose);
    expect(m).not.toBeNull();
    const saved = { a: process.env.DEFAULT_JITO_TIP_SOL, b: process.env.JITO_TIP_SOL, c: process.env.JITO_DEFAULT_TIP_LAMPORTS };
    delete process.env.DEFAULT_JITO_TIP_SOL; delete process.env.JITO_TIP_SOL; delete process.env.JITO_DEFAULT_TIP_LAMPORTS;
    try {
      const fresh = new (executionConfig.constructor as new () => typeof executionConfig)();
      expect(Number(m![1])).toBe(fresh.getConfig().defaultJitoTipSol);
    } finally {
      for (const [k, v] of [['DEFAULT_JITO_TIP_SOL', saved.a], ['JITO_TIP_SOL', saved.b], ['JITO_DEFAULT_TIP_LAMPORTS', saved.c]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
