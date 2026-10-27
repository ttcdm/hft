import '../suppress-warnings.cjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { ExecutionCoordinator } from '../server/execution/coordinator';
import { RealMarkPriceService, TradeReconciler } from '../server/execution/reconciliation';
import { localSigner } from '../server/solana/signer';
import { TOKEN_2022_PROGRAM_ID } from '../server/solana/programs';
import { workstationDb } from '../server/db/database';

/**
 * R5-1, R8-22, R5-27: tokens anyone sends to the wallet must not become LIVE positions that fill slots or hold the mark feed STALE; a
 * balance found again must not overwrite a closed adopted row; a buy that starts during the scan's mark read owns its mint. Real
 * coordinator and SQLite; the RPC token-account listing and the on-chain mark read are stubbed. Keys are fresh throwaway values.
 */
const acct = (mint: PublicKey, amount: string, decimals = 6) => ({
  pubkey: Keypair.generate().publicKey,
  account: { data: { parsed: { info: { mint: mint.toBase58(), tokenAmount: { amount, decimals } } } } },
});

describe('R5-1 / R8-22 / R5-27: what the untracked-balance scan adopts', () => {
  let coordinator: ExecutionCoordinator;
  let wallet: PublicKey;
  let listing: any[];
  let marks: Record<string, any>;
  let onMarkRead: () => void;

  const bought = (mint: PublicKey) => workstationDb.saveTransaction({
    signature: `c1r51_${Math.random().toString(36).slice(2)}`, orderId: 'o', correlationId: 'c', mint: mint.toBase58(), direction: 'BUY',
    submissionTransport: 'SOLANA_RPC', submissionTime: Date.now() - 60_000, reconciliationState: 'TIMED_OUT', networkFeeLamports: 5000, jitoTipLamports: 0, executionMode: 'LIVE',
  });
  const mark = (mint: PublicKey, price: number) => { marks[mint.toBase58()] = { priceSol: price, source: 'ON_CHAIN_BONDING_CURVE', timestamp: Date.now() }; };
  const rowsFor = (mint: PublicKey) => workstationDb.loadPositions().filter((p) => p.mint === mint.toBase58());

  beforeEach(async () => {
    wallet = Keypair.generate().publicKey;
    TradeReconciler.txFetchRetryDelaysMs = [];
    vi.spyOn(Connection.prototype, 'getTransaction').mockResolvedValue(null);
    listing = [];
    marks = {};
    onMarkRead = () => undefined;
    vi.spyOn(localSigner, 'getPublicKey').mockReturnValue(wallet);
    vi.spyOn(localSigner, 'getStatus').mockReturnValue('READY');
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(1);
    vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(5e9);
    vi.spyOn(Connection.prototype, 'getTokenAccountBalance').mockRejectedValue(new Error('no account'));
    vi.spyOn(Connection.prototype, 'getParsedTokenAccountsByOwner').mockImplementation((async (_o: any, filter: any) => ({
      context: { slot: 1 }, value: filter.programId.equals(TOKEN_2022_PROGRAM_ID) ? [] : listing,
    })) as any);
    vi.spyOn(RealMarkPriceService, 'queryOnChainMarkPrices').mockImplementation((async () => { onMarkRead(); return marks; }) as any);
    coordinator = new ExecutionCoordinator();
    coordinator.orphanRecoveryDelaysMs = [];
    await vi.waitFor(() => expect((coordinator as any).lastStartupReconciliation).toBeTruthy());
  });
  afterEach(() => {
    TradeReconciler.txFetchRetryDelaysMs = [400, 800, 1600, 3200, 6400];
    for (const p of workstationDb.loadPositions('LIVE', 'ACTIVE')) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
    coordinator.cleanup();
    vi.restoreAllMocks();
  });

  it('R5-1: priced tokens of mints this app never bought are not adopted; they raise one UNKNOWN_TOKEN_BALANCE alert', async () => {
    const spam = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    for (const m of spam) { listing.push(acct(m, '1000000')); mark(m, 0.001); }
    const r = await coordinator.scanUntrackedWalletTokens();
    expect(r.adopted).toEqual([]);
    for (const m of spam) expect(rowsFor(m)).toHaveLength(0);
    const alerts = coordinator.getOperatorAlerts().filter((a) => a.code === 'UNKNOWN_TOKEN_BALANCE' && !a.cleared);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/^3 token balance/);
  });

  it('R8-22: a balance found again for a mint whose adopted row is closed is a new row; the closed one keeps its PnL and exit signature', async () => {
    const mint = Keypair.generate().publicKey;
    bought(mint);
    listing.push(acct(mint, '1000000'));
    mark(mint, 0.001);
    await coordinator.scanUntrackedWalletTokens();
    const first = rowsFor(mint)[0];
    workstationDb.savePosition({ ...first, status: 'CLOSED', tokenQuantityRaw: '0', realizedPnLSol: 0.0123, exitTxSignature: 'exit_sig_kept' } as any);
    await coordinator.scanUntrackedWalletTokens(); // the airdrop again
    const closed = workstationDb.loadPositions().find((p) => p.id === first.id)!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.realizedPnLSol).toBeCloseTo(0.0123, 6);
    expect(closed.exitTxSignature).toBe('exit_sig_kept');
    expect(rowsFor(mint).filter((p) => p.status === 'OPEN')).toHaveLength(1);
  });

  it('R5-27: a buy of the mint that starts while the scan reads marks owns the mint; the scan adopts nothing', async () => {
    const mint = Keypair.generate().publicKey;
    bought(mint);
    listing.push(acct(mint, '1000000'));
    mark(mint, 0.001);
    onMarkRead = () => { (coordinator as any).inFlightBuyMints.add(mint.toBase58()); };
    const r = await coordinator.scanUntrackedWalletTokens();
    (coordinator as any).inFlightBuyMints.delete(mint.toBase58());
    expect(r.adopted).toEqual([]);
    expect(rowsFor(mint)).toHaveLength(0);
  });

  it('R5-1: an unpriceable RECOVERED position does not hold the mark feed STALE', async () => {
    const mint = Keypair.generate().publicKey;
    workstationDb.savePosition({
      id: `recovered-${mint.toBase58()}`, mint: mint.toBase58(), symbol: 'RCV', name: 'RECOVERED', tokenDecimals: 6, tokenQuantityRaw: '10',
      entryPriceSol: 0.001, currentPriceSol: 0.001, costBasisLamports: 0, realizedPnLSol: 0, status: 'OPEN', executionMode: 'LIVE',
      entryTxSignature: `RECOVERED:${mint.toBase58()}`, entryTimestamp: Date.now() - 10 * 60_000, lastMarkTimestamp: Date.now() - 10 * 60_000,
    } as any);
    for (const p of workstationDb.loadPositions('LIVE', 'ACTIVE')) if (p.mint !== mint.toBase58()) workstationDb.savePosition({ ...p, status: 'CLOSED', tokenQuantityRaw: '0' } as any);
    vi.spyOn(coordinator as any, 'updatePositionMarkPrices').mockResolvedValue(undefined);
    vi.spyOn(coordinator as any, 'refreshStaleMark').mockResolvedValue(false);
    (coordinator as any).lastPositionMarkTimestamp = 0;
    await coordinator.evaluateAndProcessExits();
    expect((coordinator as any).lastPositionMarkTimestamp).toBe(0); // the exit pass does not start the clock from its entry
    (coordinator as any).lastPositionMarkTimestamp = Date.now() - 100_000; // and the heartbeat resets a clock only it would own
    (coordinator as any).positionMarkHealth = 'STALE';
    clearInterval((coordinator as any).feedHeartbeatInterval);
    (coordinator as any).startMarketFeedHeartbeat();
    await vi.waitFor(() => expect((coordinator as any).positionMarkHealth).toBe('HEALTHY'));
  });
});
