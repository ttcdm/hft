import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { executionConfig } from '../server/solana/executionConfig';
import { socialScanner } from '../server/socialScanner';
import * as pumpfun from '../server/pumpfunService';
import { WalletConfigSchema, ClosePositionSchema } from '../server/middleware/enterprise';
import { SniperConfigPatchSchema } from '../server/execution/tradeInputs';

// S215: the settings Q34 documented as stored-but-unused were removed. These checks keep them from coming back unnoticed.
describe('Q34/S215: the do-nothing settings are gone', () => {
  it('the config objects no longer carry them, and section 6 says so', () => {
    expect((executionConfig.getConfig() as any).enableSyntheticSocial).toBeUndefined();
    const tg = socialScanner.getTelegramConfig() as any;
    for (const k of ['snipeThresholdScore', 'autoForwardAlerts', 'webhookActive']) expect(tg[k], k).toBeUndefined();
    expect((pumpfun as any).isAutoSnipeEnvEnabled).toBeUndefined();
    expect(typeof (pumpfun.pumpFunService as any).toggleCallerAutoSnipe).toBe('undefined');
    // the request schemas drop the removed fields instead of accepting them, and a wallet address is no longer required
    const w = WalletConfigSchema.parse({ walletAddress: 'x', wsRpcEndpoint: 'wss://a', jitoTipAccount: 'y', autoStartTrading: true, enabledStrategies: {},
      riskLimits: { requireConfluenceScore: 90 } }) as any;
    for (const k of ['walletAddress', 'wsRpcEndpoint', 'jitoTipAccount', 'autoStartTrading']) expect(w[k], k).toBeUndefined();
    expect(w.riskLimits.requireConfluenceScore).toBeUndefined();
    expect((ClosePositionSchema.parse({ positionId: 'p', priorityTipSol: 0.01 }) as any).priorityTipSol).toBeUndefined();
    expect(SniperConfigPatchSchema.parse({ minConfidenceScore: 90, requireMintRevoked: false, maxSlippagePct: 5 })).toEqual({ maxSlippagePct: 5 });
    // and KNOWN_RISKS section 6 no longer lists them as present
    const doc = fs.readFileSync('KNOWN_RISKS.md', 'utf8');
    const s6 = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
    for (const k of ['snipeThresholdScore', 'isAutoSnipeEnvEnabled', 'requireMintRevoked', 'minConfidenceScore', 'priorityTipSol']) expect(s6, k).not.toContain(`| \`${k}`);
  });
});
