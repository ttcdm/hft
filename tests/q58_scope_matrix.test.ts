import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('Q58: the scope matrix does not call mainnet-only sources LIVE on devnet', () => {
  const src = fs.readFileSync('server.ts', 'utf8');
  const matrix = src.slice(src.indexOf('simulationScopeMatrix: ['), src.indexOf("subsystem: 'Telegram Bot API Link'"));
  it('Pump.fun and DexScreener are LIVE only on mainnet-beta', () => {
    expect(matrix).not.toMatch(/nature: 'LIVE',\s*details:\s*\n?\s*'Fetches real new tokens/);
    expect(matrix.match(/NOT_AVAILABLE_ON_THIS_CLUSTER/g)?.length).toBe(2);
    expect(matrix).not.toMatch(/frontend-api-v3\.pump\.fun every 5s/);
  });
  it('has an Auto mode row that states the round-trip cost and the score ceiling', () => {
    expect(matrix).toMatch(/Auto mode/);
    expect(matrix).toMatch(/loses about 3%/);
    expect(matrix).toMatch(/maximum reachable 90/);
  });
});
