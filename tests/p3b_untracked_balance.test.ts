import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { RealMarkPriceService, TradeReconciler } from '../server/execution/reconciliation';
import { localSigner } from '../server/solana/signer';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../server/solana/programs';
import { workstationDb } from '../server/db/database';

/**
 * P3b (critique #3, startup scan): tokens in the wallet with no position must get exit coverage. Real coordinator and SQLite;
 * RPC token-account listing and the on-chain mark read are stubbed. Wallet and mints are fresh throwaway keys.
 */
const acct = (mint: PublicKey, amount: string, decimals = 6) => ({
  pubkey: Keypair.generate().publicKey,
  account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount, decimals } } } } },
});

describe('P3b: untracked wallet token balances', () => {
  let coordinator: ExecutionCoordinator;
  let wallet: PublicKey;
  let listing: { spl: any[]; t22: any[] };
  let marks: Record<string, any>;

  beforeEach(async () => {
    wallet = Keypair.generate().publicKey;
    TradeReconciler.txFetchRetryDelaysMs = [];
    vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue(null);
    listing = { spl: [], t22: [] };
    marks = {};
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(5e9);
    // startup reconciliation re-verifies positions left in the shared DB by earlier tests: answer instead of reaching for a network
    vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockRejectedValue(new Error('no account'));
    vi.spyOn(Connection.prototype, 'getParsedTokenAccountsByOwner').mockImplementation((async (_o: any, filter: any) => ({
      context: { slot: 1 },
      value: filter.programId.equals(TOKEN_2022_PROGRAM_ID) ? listing.t22 : listing.spl,
    })) as any);
    vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockImplementation((async () => marks) as any);
    coordinator = new ExecutionCoordinator();
    coordinator.orphanRecoveryDelaysMs = [];
    await vi.waitFor(() => expect((coordinator as any).lastStartupReconciliation).toBeTruthy());
  });
  afterEach(() => {
    TradeReconciler.txFetchRetryDelaysMs = [400, 800, 1600, 3200, 6400];
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  const posFor = (mint: PublicKey) => workstationDb.loadPositions().find((p) => p.mint === mint.toBase58() && p.status !== 'CLOSED');
  const mark = (mint: PublicKey, price: number) => { marks[mint.toBase58()] = { priceSol: price, source: 'ON_CHAIN_BONDING_CURVE', timestamp: Date.now() }; };

  it('adopts a priced untracked SPL balance: OPEN position, entry price = mark, cost basis unknown, alert raised', async () => {
    const mint = Keypair.generate().publicKey;
    listing.spl.push(acct(mint, '5000000000'));
    mark(mint, 0.00002);
    const r = await coordinator.scanUntrackedWalletTokens();
    expect(r.adopted).toEqual([mint.toBase58()]);
    const p = posFor(mint)!;
    expect(p.status).toBe('OPEN');
    expect(p.executionMode).toBe('LIVE');
    expect(p.tokenQuantityRaw).toBe('5000000000');
    expect(p.entryPriceSol).toBe(0.00002);
    expect(p.costBasisLamports).toBe(0);
    expect(p.name).toMatch(/RECOVERED/);
    expect(p.baseTokenProgram).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'UNTRACKED_TOKEN_BALANCE')).toBe(true);
  });

  it('a Token-2022 balance keeps its token program', async () => {
    const mint = Keypair.generate().publicKey;
    listing.t22.push(acct(mint, '777', 9));
    mark(mint, 0.001);
    await coordinator.scanUntrackedWalletTokens();
    const p = posFor(mint)!;
    expect(p.baseTokenProgram).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(p.tokenDecimals).toBe(9);
  });

  it('does nothing for a mint that already has an active LIVE position, a zero balance, or a buy awaiting recovery', async () => {
    const tracked = Keypair.generate().publicKey, zero = Keypair.generate().publicKey, pending = Keypair.generate().publicKey;
    workstationDb.savePosition({
      id: `p3b_tracked_${Date.now()}`, mint: tracked.toBase58(), symbol: 'T', name: 'T', tokenDecimals: 6, tokenQuantityRaw: '10',
      entryPriceSol: 0.1, currentPriceSol: 0.1, costBasisLamports: 1, realizedPnLSol: 0, status: 'OPEN', executionMode: 'LIVE',
      entryTxSignature: 'x', entryTimestamp: Date.now(), updatedAt: Date.now(), recordUpdatedAt: Date.now(),
    } as any);
    workstationDb.saveTransaction({
      signature: `p3b_pending_${Date.now()}`, orderId: 'o', correlationId: 'c', mint: pending.toBase58(), direction: 'BUY',
      submissionTransport: 'SOLANA_RPC', submissionTime: Date.now(), reconciliationState: 'RECONCILIATION_REQUIRED',
      networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
    });
    listing.spl.push(acct(tracked, '10'), acct(zero, '0'), acct(pending, '999'));
    for (const m of [tracked, zero, pending]) mark(m, 0.01);
    const r = await coordinator.scanUntrackedWalletTokens();
    expect(r.untracked).toEqual([]);
    expect(posFor(zero)).toBeUndefined();
    expect(workstationDb.loadPositions().filter((p) => p.mint === pending.toBase58())).toHaveLength(0);
  });

  it('a balance with no readable pump price is alerted but never turned into a position', async () => {
    const mint = Keypair.generate().publicKey;
    listing.spl.push(acct(mint, '123'));
    const r = await coordinator.scanUntrackedWalletTokens();
    expect(r.untracked).toEqual([mint.toBase58()]);
    expect(r.adopted).toEqual([]);
    expect(posFor(mint)).toBeUndefined();
    expect(coordinator.getOperatorAlerts().some((a) => a.code === 'UNTRACKED_TOKEN_BALANCE')).toBe(true);
  });

  it('is idempotent: a second scan finds the adopted position and adds nothing', async () => {
    const mint = Keypair.generate().publicKey;
    listing.spl.push(acct(mint, '42'));
    mark(mint, 0.5);
    await coordinator.scanUntrackedWalletTokens();
    const second = await coordinator.scanUntrackedWalletTokens();
    expect(second.untracked).toEqual([]);
    expect(workstationDb.loadPositions().filter((p) => p.mint === mint.toBase58())).toHaveLength(1);
  });

  it('the adopted position is covered by the exit engine: a -50% mark triggers STOP_LOSS', async () => {
    const mint = Keypair.generate().publicKey;
    listing.spl.push(acct(mint, '1000000'));
    mark(mint, 0.001);
    await coordinator.scanUntrackedWalletTokens();
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    const p = posFor(mint)!;
    p.currentPriceSol = 0.0005;
    p.lastMarkTimestamp = Date.now();
    workstationDb.savePosition(p);
    const close = vi.spyOn(coordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0 });
    await coordinator.evaluateAndProcessExits();
    expect(close.mock.calls.some((c) => c[0] === p.id && c[2] === 'STOP_LOSS')).toBe(true);
  });

  describe('RECOVERED positions get the hard stop only', () => {
    const setup = async () => {
      const mint = Keypair.generate().publicKey;
      listing.spl.push(acct(mint, '1000000'));
      mark(mint, 0.001);
      await coordinator.scanUntrackedWalletTokens();
      vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
      const p = posFor(mint)!;
      return { p, close: vi.spyOn(coordinator, 'closePosition').mockResolvedValue({ success: true, pnlSol: 0 }) };
    };
    const reprice = (p: any, price: number, ageMs = 0) => {
      p.currentPriceSol = price;
      p.lastMarkTimestamp = Date.now();
      p.entryTimestamp = Date.now() - ageMs;
      workstationDb.savePosition(p);
    };

    it('a +40% mark does not take profit and a 31-minute-old flat position is not sold as stale', async () => {
      const { p, close } = await setup();
      reprice(p, 0.0014);
      await coordinator.evaluateAndProcessExits();
      reprice(p, 0.001, 31 * 60_000);
      await coordinator.evaluateAndProcessExits();
      expect(close.mock.calls.filter((c) => c[0] === p.id)).toEqual([]);
    });

    it('AUTO_MANAGE_RECOVERED=true opts back into the full exit engine', async () => {
      vi.stubEnv('AUTO_MANAGE_RECOVERED', 'true');
      const { p, close } = await setup();
      reprice(p, 0.0014);
      await coordinator.evaluateAndProcessExits();
      expect(close.mock.calls.some((c) => c[0] === p.id && /TAKE_PROFIT/.test(String(c[2])))).toBe(true);
      vi.unstubAllEnvs();
    });
  });

  it('startup reconciliation runs the scan and mentions it', async () => {
    const mint = Keypair.generate().publicKey;
    listing.spl.push(acct(mint, '31337'));
    mark(mint, 0.003);
    const res = await coordinator.startupReconciliation();
    expect(posFor(mint)?.status).toBe('OPEN');
    expect(res.details).toMatch(/1 wallet token balance/);
    // an adopted balance is reported in the details but does not by itself count as a mismatch (the DB is shared with earlier tests, so the overall status is not asserted)
    expect(res.mismatchesCount).toBe(res.details.split('; ').filter((d) => /have no position record|recorded active|Failed to verify|confirmed but/.test(d)).length);
  });
  it('a failed wallet scan is not "all clear": startup reconciliation reports a mismatch and arming stays blocked', async () => {
    vi.mocked(Connection.prototype.getParsedTokenAccountsByOwner).mockRejectedValue(new Error('rpc refused'));
    const r = await coordinator.startupReconciliation();
    expect(r.status).toBe('RECONCILIATION_MISMATCH');
    expect(r.details).toMatch(/Wallet token scan failed/);
    expect(coordinator.canExecuteLive().reasons.join(' ')).toMatch(/Startup reconciliation has unresolved issues/);
  });
});
