import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PublicKey, Connection } from '@solana/web3.js';
import { ExecutionCoordinator, ExecuteTradeRequest } from '../server/execution/coordinator';
import { localSigner } from '../server/solana/signer';
import { PumpCurveService } from '../server/solana/pumpCurve';
import { txBuilder } from '../server/solana/transactionBuilder';
import { riskEngine } from '../server/risk/riskEngine';
import { TOKEN_PROGRAM_ID } from '../server/solana/programs';
import { CURVE_INITIAL_REAL_TOKENS } from '../server/market/poolStats';

/**
 * Review 2026-10-24, finding 8: a LIVE buy whose fresh curve read gives no progress (token reserves unreadable) is refused with
 * CURVE_PROGRESS_UNREADABLE before any quote, build or sign. The real ExecutionCoordinator in LIVE; the doubles are the curve read (a state
 * the test shapes), the signer and the quote/build calls it watches. Nothing is sent: the build is stubbed to throw if it is ever reached.
 */
describe('Finding 8: a LIVE buy is refused when the curve progress cannot be read', () => {
  const mint = 'CzLSujWBLFsSjncfkh59rQD4NJYsZUMffEFrNJfiBAGS';
  const wallet = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1');
  let coordinator: ExecutionCoordinator;

  const state = (reserves: { realSolReserves?: bigint; realTokenReserves?: bigint }) => ({
    complete: false,
    tokenProgram: TOKEN_PROGRAM_ID,
    bondingCurve: wallet,
    associatedBondingCurve: wallet,
    creator: wallet,
    feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    tokenDecimals: 6,
    virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: 1_000_000_000_000_000n,
    marketDataTimestamp: Date.now(),
    isMintAuthorityRevoked: true,
    isFreezeAuthorityRevoked: true,
    ...reserves,
  });
  const req: ExecuteTradeRequest = {
    signalTimestamp: Date.now(), mint, symbol: 'F8', name: 'Finding 8', amountSol: 0.02, source: 'AUTO_SNIPER', provenance: 'REAL_ONCHAIN',
  };

  beforeEach(() => {
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(10_000_000_000);
    vi.spyOn(txBuilder, 'buildBuyTransaction').mockRejectedValue(new Error('TEST_BUILD_REACHED'));
    process.env.ALLOW_LIVE_REAL_MONEY_TRADING = 'true';
    coordinator = new ExecutionCoordinator();
    (coordinator as any).executionMode = 'LIVE';
    (coordinator as any).isLiveTradingArmed = true;
    (coordinator as any).realWalletBalanceSol = 1.0;
    riskEngine.setKillSwitch(false);
    riskEngine.setCircuitBreaker('CLOSED');
    riskEngine.recordRpcSuccess();
  });

  afterEach(() => {
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  it('SOL reserves read, token reserves not: refused, no quote and no build, reservation back to 0', async () => {
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(state({ realSolReserves: 24_000_000_000n }) as any);
    const quote = vi.spyOn(PumpCurveService, 'calculateBuyQuote');
    const res = await coordinator.executeTrade(req);
    expect(res.success).toBe(false);
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^CURVE_PROGRESS_UNREADABLE: .*token reserves could not be read/);
    expect(quote).not.toHaveBeenCalled();
    expect(txBuilder.buildBuyTransaction).not.toHaveBeenCalled();
    expect((coordinator as any).inFlightReservedSol).toBe(0);
  });

  it('no reserves at all: refused the same way', async () => {
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(state({}) as any);
    const res = await coordinator.executeTrade(req);
    expect(res.lifecycleState).toBe('RISK_REJECTED');
    expect(res.error).toMatch(/^CURVE_PROGRESS_UNREADABLE: .*no readable reserves/);
    expect(txBuilder.buildBuyTransaction).not.toHaveBeenCalled();
  });

  it('control: token reserves readable (12% sold) pass this gate and reach the next one (holder eligibility, fail closed here)', async () => {
    const tok = CURVE_INITIAL_REAL_TOKENS - (CURVE_INITIAL_REAL_TOKENS * 12n) / 100n;
    vi.spyOn(PumpCurveService, 'fetchPumpMarketState').mockResolvedValue(state({ realSolReserves: 3_000_000_000n, realTokenReserves: tok }) as any);
    const res = await coordinator.executeTrade(req);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^ELIGIBILITY_CHECK_FAILED/);
    expect(txBuilder.buildBuyTransaction).not.toHaveBeenCalled();
  });
});
