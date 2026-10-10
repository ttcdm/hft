import type { EventEmitter } from 'events';
import type { PumpTradeEvent } from '../solana/pumpFeedListener';

/** H2: the last trades per mint, from decoded Pump TradeEvents. In memory only; empty means "no data", never invented rows. */
export const TAPE_PER_MINT = 100;
export const TAPE_MAX_MINTS = 200;

export interface TapeRow {
  signature: string;
  at: number;
  side: 'BUY' | 'SELL';
  sol: number;
  tokens: number;
  wallet: string;
  walletShort: string;
  creator: boolean;
  own: boolean;
}

export class TradeTape {
  private byMint = new Map<string, TapeRow[]>();
  constructor(private creatorOf: (mint: string) => string | undefined = () => undefined, private ownWallet: () => string | null = () => null) {}

  public record(t: PumpTradeEvent, at = Date.now()): void {
    let rows = this.byMint.get(t.mint);
    if (!rows) {
      if (this.byMint.size >= TAPE_MAX_MINTS) this.byMint.delete(this.byMint.keys().next().value as string);
      rows = [];
      this.byMint.set(t.mint, rows);
    }
    if (rows.some((r) => r.signature === t.signature && r.wallet === t.user && r.side === (t.isBuy ? 'BUY' : 'SELL'))) return;
    const own = this.ownWallet();
    rows.push({
      signature: t.signature, at, side: t.isBuy ? 'BUY' : 'SELL', sol: Number(t.solAmountLamports) / 1e9,
      tokens: Number(t.tokenAmount) / 1e6 /* Pump tokens have 6 decimals */, wallet: t.user, walletShort: `${t.user.slice(0, 4)}…${t.user.slice(-4)}`,
      creator: this.creatorOf(t.mint) === t.user, own: own !== null && own === t.user,
    });
    if (rows.length > TAPE_PER_MINT) rows.shift();
  }

  /** Newest first. */
  public get(mint: string, limit = 50): TapeRow[] {
    return [...(this.byMint.get(mint) ?? [])].reverse().slice(0, limit);
  }

  public attach(listener: EventEmitter): void {
    listener.on('trade_event', (t: PumpTradeEvent) => this.record(t));
  }
}
