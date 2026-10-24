import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TradeReconciler } from '../server/execution/reconciliation';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';

/**
 * S260 (P2.3, R1-88/R1-138/N-26): the pre-trade snapshot turned every token-balance error into a balance of 0. For a LIVE buy into a wallet
 * that already holds the token, a 0 baseline lets the landed check read the old balance as this buy's fill. Real TradeReconciler; the
 * Connection is a stub answering like the RPC does.
 */
afterEach(() => vi.restoreAllMocks());
const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const conn = (tokenErr: string) => ({
  getBalance: vi.fn(async () => 1_000_000_000),
  getTokenAccountBalance: vi.fn(async () => { throw new Error(tokenErr); }),
}) as any;

describe('S260: an unreadable token balance is unknown, not 0, for a LIVE buy', () => {
  it('LIVE: a 429 on the token balance throws PRE_TRADE_SNAPSHOT_FAILED', async () => {
    await expect(TradeReconciler.capturePreTradeSnapshot(conn('429 : {"code":-32007,"message":"15/second request limit reached"}'), wallet, mint, TOKEN_PROGRAM_ID, 'LIVE'))
      .rejects.toThrow(/PRE_TRADE_SNAPSHOT_FAILED/);
  });

  it('LIVE: an account that does not exist is a balance of 0', async () => {
    const s = await TradeReconciler.capturePreTradeSnapshot(conn('failed to get token account balance: Invalid param: could not find account'), wallet, mint, TOKEN_PROGRAM_ID, 'LIVE');
    expect(s.tokenBalanceRaw).toBe('0');
    expect(s.walletSolLamports).toBe(1_000_000_000);
  });

  it('without LIVE (the sell path) a read error still gives 0, so a stop-loss is not blocked on it', async () => {
    const s = await TradeReconciler.capturePreTradeSnapshot(conn('fetch failed'), wallet, mint, TOKEN_PROGRAM_ID);
    expect(s.tokenBalanceRaw).toBe('0');
  });
});
