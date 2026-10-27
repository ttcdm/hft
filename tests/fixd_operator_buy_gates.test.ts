import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { walletTrader } from '../server/walletTrader';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { executionCoordinator } from '../server/execution/coordinator';
import { solPriceService } from '../server/market/solPriceService';
import { newPumpPool } from './fixtures/auto';

/**
 * R5-40: the Plug & Play buy (POST /api/wallet/snipe, walletTrader.executeLiveSnipe) called executeTrade directly, so it skipped the
 * confluence gate, the aggregator's pool checks and the synthetic-pool refusal, accepted a client confluenceScore and passed no
 * executionMode (so MODE_CHANGED never applied). The real walletTrader and aggregator; executeTrade is the stubbed boundary.
 */
describe('R5-40: the Plug & Play buy runs the same gates as every other manual buy', () => {
  beforeEach(() => solPriceService.setPrice(150, 'TEST_FIXTURE'));
  afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

  const stubTrade = () => vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: true, lifecycleState: 'CONFIRMED', executionMode: 'PAPER', positionId: 'p-r540', txSignature: 'sig-r540', correlationId: 'c' } as any);

  it('a mint below the confluence threshold is refused before anything reaches the coordinator', async () => {
    memecoinAggregator.setConfluenceGating(true);
    const { mint } = newPumpPool('NONE'); // a fresh feed pool: no trades, unknown holders, far below 70
    const trade = stubTrade();
    const r = await walletTrader.executeLiveSnipe({ mint, amountSol: 0.01 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Confluence score/);
    expect(trade).not.toHaveBeenCalled();
  });

  it('a client-sent confluenceScore is refused', async () => {
    const trade = stubTrade();
    const r = await walletTrader.executeLiveSnipe({ mint: Keypair.generate().publicKey.toBase58(), amountSol: 0.01, confluenceScore: 100 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/confluenceScore/);
    expect(trade).not.toHaveBeenCalled();
  });

  it('a mint with only an invented pool is refused (no synthetic pool), PAPER included', async () => {
    vi.spyOn(executionCoordinator, 'getExecutionMode').mockReturnValue('PAPER');
    memecoinAggregator.setConfluenceGating(false);
    const trade = stubTrade();
    const r = await walletTrader.executeLiveSnipe({ mint: Keypair.generate().publicKey.toBase58(), amountSol: 0.01 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/MARKET_DATA_UNAVAILABLE/);
    expect(trade).not.toHaveBeenCalled();
  });

  it('the mode read before the awaits goes with the order (MODE_CHANGED applies), as MANUAL with MANUAL_OPERATOR provenance', async () => {
    memecoinAggregator.setConfluenceGating(false);
    const { mint } = newPumpPool('NONE');
    const trade = stubTrade();
    const r = await walletTrader.executeLiveSnipe({ mint, amountSol: 0.01 });
    expect(r.success, r.error).toBe(true);
    expect(trade.mock.calls[0][0]).toMatchObject({ executionMode: 'PAPER', source: 'MANUAL', provenance: 'MANUAL_OPERATOR', amountSol: 0.01 });
    expect(r.txSignature).toBe('sig-r540');
  });
});

describe('R5-42: Telegram /snipe says what it sent, and is journaled as an operator trade', () => {
  afterEach(() => { vi.restoreAllMocks(); memecoinAggregator.setConfluenceGating(true); });

  it('the reply shows the clamped SOL sent next to the requested USD; provenance is MANUAL_OPERATOR', async () => {
    const { socialScanner } = await import('../server/socialScanner');
    solPriceService.setPrice(150, 'TEST_FIXTURE');
    memecoinAggregator.setConfluenceGating(false);
    const { mint } = newPumpPool('NONE');
    const trade = vi.spyOn(executionCoordinator, 'executeTrade').mockResolvedValue({ success: true, lifecycleState: 'CONFIRMED', executionMode: 'PAPER', positionId: 'p-r542', correlationId: 'c' } as any);
    const r = await socialScanner.processTelegramCommand(`/snipe ${mint} 500`); // $500 asks for far more than 10% of the paper bankroll
    expect(trade.mock.calls[0][0]).toMatchObject({ provenance: 'MANUAL_OPERATOR', source: 'MANUAL' });
    const sentSol = trade.mock.calls[0][0].amountSol;
    expect(sentSol * 150).toBeLessThan(500);
    expect(r.reply).toMatch(/Requested: \$500\.00/);
    expect(r.reply).toContain(`Sent: ${sentSol.toFixed(6)} SOL`);
    expect(r.reply).not.toMatch(/Notional: \$500/);
  });
});
