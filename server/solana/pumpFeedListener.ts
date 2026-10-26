import { Connection, PublicKey, Logs, Context, SlotInfo } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { EventEmitter } from 'events';
import { PUMP_FUN_PROGRAM_ID } from './programs';
import { Logger } from '../middleware/enterprise';
import { executionCoordinator } from '../execution/coordinator';
import { curveVelocityEvaluator } from '../signals/curveVelocityEvaluator';
import { creatorRiskScorer } from '../signals/creatorRiskScorer';

// Anchor CreateEvent 8-byte discriminator: sha256("event:CreateEvent")[0..8]
// Hex: 1b72a94ddeeb6376
export const PUMP_CREATE_EVENT_DISCRIMINATOR = Buffer.from('1b72a94ddeeb6376', 'hex');

// Anchor TradeEvent 8-byte discriminator: sha256("event:TradeEvent")[0..8]
export const PUMP_TRADE_EVENT_DISCRIMINATOR = Buffer.from('bddb7fd34ee661ee', 'hex');

/** Hard cap on how long a create event waits for the creator-history lookup before scoring continues without it. */
export const CREATOR_RISK_TIMEOUT_MS = 300;

/**
 * P4.2 (R1-52): the slot heartbeat. A gap is opened when no slot notification arrived for FEED_SLOT_SILENCE_MS while the feed was
 * ACTIVE (checked every FEED_HEARTBEAT_CHECK_MS, and only once a first slot was seen, so an RPC without slotSubscribe is judged by its
 * socket events alone), or when two consecutive slot notifications are more than FEED_SLOT_JUMP_MAX slots apart (about 10 s of devnet
 * slots: the notifications in between were not delivered, so neither were the logs).
 */
export const FEED_SLOT_SILENCE_MS = 10_000;
export const FEED_HEARTBEAT_CHECK_MS = 2_000;
export const FEED_SLOT_JUMP_MAX = 25;

/** Why the log stream may have missed logs. SOCKET_CLOSED and SLOT_* come from the socket and the heartbeat, ENDPOINT_SWITCH from setRpcEndpoint. */
export type FeedGapReason = 'SOCKET_CLOSED' | 'SLOT_SILENCE' | 'SLOT_JUMP' | 'ENDPOINT_SWITCH';

/** Emitted as 'feed_gap' when logs may have been lost. Every watch candidate active at that moment is released DEAD with FEED_GAP. */
export interface FeedGapEvent {
  reason: FeedGapReason;
  at: number;
  detail: string;
}

/** The quote mints a SOL launch carries: the default key (legacy curves) or wSOL. Any other quote is a non-SOL curve. */
export function isSolQuoteMint(quoteMint: string | undefined): boolean {
  return quoteMint === undefined || quoteMint === PublicKey.default.toBase58() || quoteMint === NATIVE_MINT.toBase58();
}

/** The part of web3.js's private websocket client the gap detector listens to ('open' and 'close'). Absent on a fake without one. */
type SocketEvents = { on(ev: 'open' | 'close', fn: (...a: any[]) => void): unknown; off?(ev: string, fn: (...a: any[]) => void): unknown; removeListener?(ev: string, fn: (...a: any[]) => void): unknown };
function socketOf(conn: Connection | null): SocketEvents | null {
  const ws = (conn as any)?._rpcWebSocket;
  return ws && typeof ws.on === 'function' ? ws : null;
}

/** Anything that announces a new trading Connection (the coordinator's `onConnectionChange`). */
export interface ConnectionChangeSource {
  onConnectionChange(fn: (conn: Connection) => void): () => void;
}

/**
 * Decoded pump.fun TradeEvent (fixed prefix of the IDL in @pump-fun/pump-sdk 1.37:
 * mint, sol_amount, token_amount, is_buy, user, timestamp, virtual/real reserves).
 * UNVERIFIED against live logs: trades may be emitted through a self-CPI that logsSubscribe cannot see.
 */
export interface PumpTradeEvent {
  signature: string;
  slot: number;
  mint: string;
  solAmountLamports: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestampSec: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
}

export interface PumpCreateEvent {
  signature: string;
  slot: number;
  mint: string;
  creator: string;
  /** The signer of the create transaction (R14). Usually also makes the dev buy and can differ from `creator` in create_v2. */
  user?: string;
  bondingCurve: string;
  name: string;
  symbol: string;
  uri: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** P4.2 (R1-64): the CreateEvent's quote_mint (base58) when the event is long enough to carry it; undefined on the older, shorter layout (SOL). */
  quoteMint?: string;
  initialPriceSol: number;
  initialMarketCapSol: number;
  receivedAt: number;
  parsedAt: number;
  parseLatencyMs: number;
  source: 'SOLANA_WS_LOGS' | 'RPC_LOGS' | 'TEST_FEED';
}

export interface PumpFeedListenerTelemetry {
  status: 'ACTIVE' | 'CONNECTING' | 'RECONNECTING' | 'DISCONNECTED' | 'ERROR';
  subscriptionId: number | null;
  eventsReceived: number;
  /** S185: logs whose handler threw (counted, then skipped), and the slowest handler seen. A feed that cannot keep up shows here. */
  handlerErrors: number;
  slowestHandlerMs: number;
  eventsParsed: number;
  tradesParsed: number;
  lastEventTimestamp: number;
  lastEventAgeMs: number;
  averageParseLatencyMs: number;
  activeEndpoint: string;
  /** P4.2: gaps seen since boot (socket closes, slot silences and jumps, endpoint switches) and the last one. */
  feedGaps: number;
  lastFeedGap: FeedGapEvent | null;
  /** P4.2 (R1-64): launches not emitted because their quote mint is not SOL. */
  nonSolQuoteSkipped: number;
}

/**
 * Real Solana WebSocket Event Ingestion for Pump.fun V2 CreateEvent (B08)
 * Subscribes to onLogs(PUMP_FUN_PROGRAM_ID, 'processed') and extracts
 * mint address, creator key, bonding curve PDA, and initial reserves within <50ms.
 */
export class PumpFeedListener extends EventEmitter {
  private connection: Connection | null = null;
  private subscriptionId: number | null = null;
  private status: 'ACTIVE' | 'CONNECTING' | 'RECONNECTING' | 'DISCONNECTED' | 'ERROR' = 'DISCONNECTED';
  private eventsReceived: number = 0;
  private handlerErrors: number = 0;
  private slowestHandlerMs: number = 0;
  private eventsParsed: number = 0;
  private tradesParsed: number = 0;
  private lastEventTimestamp: number = 0;
  private totalParseLatencyMs: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false;
  // P4.2: gap detection (socket events plus the slot heartbeat)
  private slotSubscriptionId: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastSlot: number | null = null;
  private lastSlotAt = 0;
  private gapOpen = false;
  /** Why the open gap was opened. An ENDPOINT_SWITCH gap is also closed by the first log from the new subscription. */
  private gapReason: FeedGapReason | null = null;
  private feedGaps = 0;
  private lastFeedGap: FeedGapEvent | null = null;
  private nonSolQuoteSkipped = 0;
  private nonSolMints = new Set<string>();
  private socket: SocketEvents | null = null;
  private readonly onSocketClose = () => this.openGap('SOCKET_CLOSED', 'the websocket closed; logs sent before it reconnects are never redelivered');
  private readonly onSocketOpen = () => {
    this.lastSlot = null; // the first slot after a reconnect is not a jump: the gap is already open
    if (this.lastSlotAt > 0) this.lastSlotAt = Date.now(); // the silence clock restarts, but only once a heartbeat was ever seen
    this.closeGap();
  };
  private unfollow: (() => void) | null = null;

  constructor(connection?: Connection) {
    super();
    if (connection) {
      this.connection = connection;
    }
  }

  /**
   * Helper to derive canonical bonding curve PDA for a token mint
   */
  public static deriveBondingCurvePda(mint: PublicKey | string): PublicKey {
    const mintPubkey = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );
    return pda;
  }

  /**
   * Helper utility to serialize a CreateEvent into Anchor log format (Program data: <base64>)
   * for deterministic unit and benchmark testing.
   */
  public static encodeCreateEventLog(params: {
    name: string;
    symbol: string;
    uri: string;
    mint: PublicKey | string;
    bondingCurve?: PublicKey | string;
    creator: PublicKey | string;
    virtualTokenReserves?: bigint;
    virtualSolReserves?: bigint;
    realTokenReserves?: bigint;
    realSolReserves?: bigint;
    tokenTotalSupply?: bigint;
    /** P4.2: when given, the event carries the newer tail (token_program, is_mayhem_mode, is_cashback_enabled, quote_mint). */
    quoteMint?: PublicKey | string;
  }): string {
    const mintPubkey = typeof params.mint === 'string' ? new PublicKey(params.mint) : params.mint;
    const curvePubkey = params.bondingCurve
      ? typeof params.bondingCurve === 'string' ? new PublicKey(params.bondingCurve) : params.bondingCurve
      : PumpFeedListener.deriveBondingCurvePda(mintPubkey);
    const creatorPubkey = typeof params.creator === 'string' ? new PublicKey(params.creator) : params.creator;

    const nameBuf = Buffer.from(params.name, 'utf8');
    const symbolBuf = Buffer.from(params.symbol, 'utf8');
    const uriBuf = Buffer.from(params.uri, 'utf8');

    // IDL order: 8 disc + (4+name) + (4+sym) + (4+uri) + mint + bonding_curve + user + creator + i64 timestamp + 4 x u64 reserves
    const baseLen = 8 + 4 + nameBuf.length + 4 + symbolBuf.length + 4 + uriBuf.length + 32 * 4 + 8 + 4 * 8;
    const tailLen = params.quoteMint !== undefined ? 32 + 1 + 1 + 32 : 0;
    const buf = Buffer.alloc(baseLen + tailLen);
    let offset = 0;

    PUMP_CREATE_EVENT_DISCRIMINATOR.copy(buf, offset);
    offset += 8;

    buf.writeUInt32LE(nameBuf.length, offset);
    offset += 4;
    nameBuf.copy(buf, offset);
    offset += nameBuf.length;

    buf.writeUInt32LE(symbolBuf.length, offset);
    offset += 4;
    symbolBuf.copy(buf, offset);
    offset += symbolBuf.length;

    buf.writeUInt32LE(uriBuf.length, offset);
    offset += 4;
    uriBuf.copy(buf, offset);
    offset += uriBuf.length;

    mintPubkey.toBuffer().copy(buf, offset);
    offset += 32;

    curvePubkey.toBuffer().copy(buf, offset);
    offset += 32;

    // user (signer of the create) then creator
    creatorPubkey.toBuffer().copy(buf, offset);
    offset += 32;
    creatorPubkey.toBuffer().copy(buf, offset);
    offset += 32;

    buf.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), offset);
    offset += 8;
    for (const v of [
      params.virtualTokenReserves ?? 1_073_000_000_000_000n,
      params.virtualSolReserves ?? 30_000_000_000n,
      params.realTokenReserves ?? 793_100_000_000_000n,
      params.tokenTotalSupply ?? 1_000_000_000_000_000n,
    ]) {
      buf.writeBigUInt64LE(v, offset);
      offset += 8;
    }
    if (params.quoteMint !== undefined) {
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBuffer().copy(buf, offset); // token_program
      offset += 32 + 1 + 1; // then is_mayhem_mode and is_cashback_enabled, both false
      (typeof params.quoteMint === 'string' ? new PublicKey(params.quoteMint) : params.quoteMint).toBuffer().copy(buf, offset);
    }

    return `Program data: ${buf.toString('base64')}`;
  }

  /** Serialize a TradeEvent into Anchor log format. For deterministic tests and log-fixture replay. */
  public static encodeTradeEventLog(params: {
    mint: PublicKey | string;
    solAmountLamports: bigint;
    tokenAmount: bigint;
    isBuy: boolean;
    user: PublicKey | string;
    timestampSec: number;
    virtualSolReserves: bigint;
    virtualTokenReserves: bigint;
    realSolReserves: bigint;
    realTokenReserves: bigint;
  }): string {
    const pk = (k: PublicKey | string) => (typeof k === 'string' ? new PublicKey(k) : k);
    const buf = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 8 + 8 + 8);
    let o = 0;
    PUMP_TRADE_EVENT_DISCRIMINATOR.copy(buf, o); o += 8;
    pk(params.mint).toBuffer().copy(buf, o); o += 32;
    buf.writeBigUInt64LE(params.solAmountLamports, o); o += 8;
    buf.writeBigUInt64LE(params.tokenAmount, o); o += 8;
    buf.writeUInt8(params.isBuy ? 1 : 0, o); o += 1;
    pk(params.user).toBuffer().copy(buf, o); o += 32;
    buf.writeBigInt64LE(BigInt(params.timestampSec), o); o += 8;
    buf.writeBigUInt64LE(params.virtualSolReserves, o); o += 8;
    buf.writeBigUInt64LE(params.virtualTokenReserves, o); o += 8;
    buf.writeBigUInt64LE(params.realSolReserves, o); o += 8;
    buf.writeBigUInt64LE(params.realTokenReserves, o);
    return `Program data: ${buf.toString('base64')}`;
  }


  /**
   * R13: keep a `Program data:` line only when the innermost program running at that point is the pump program. Any program can
   * emit `sol_log_data` with pump's event discriminator in a transaction that merely mentions pump, and logsSubscribe(pump) delivers
   * that transaction; without this check a forged CreateEvent/TradeEvent would set attacker-chosen reserves (price, paper fill, board).
   * Other log lines pass through unchanged.
   */
  public static pumpOwnedLogs(lines: string[]): string[] {
    const pump = PUMP_FUN_PROGRAM_ID.toBase58();
    const stack: string[] = [];
    const out: string[] = [];
    for (const line of lines) {
      const invoke = /^Program (\S+) invoke \[\d+\]/.exec(line);
      if (invoke) { stack.push(invoke[1]); out.push(line); continue; }
      const done = /^Program (\S+) (success|failed)/.exec(line);
      if (done) { if (stack.length && stack[stack.length - 1] === done[1]) stack.pop(); out.push(line); continue; }
      if (line.startsWith('Program data: ')) {
        if (stack.length && stack[stack.length - 1] === pump) out.push(line);
        continue;
      }
      out.push(line);
    }
    return out;
  }

  /** Test helper: the log lines a real pump instruction would produce around one event line. */
  public static asPumpInvocation(eventLine: string): string[] {
    const pump = PUMP_FUN_PROGRAM_ID.toBase58();
    return [`Program ${pump} invoke [1]`, eventLine, `Program ${pump} success`];
  }

  /** Decode every TradeEvent in a transaction's logs (a tx can contain several). Never throws. */
  public parseTradeLogs(logs: Logs, ctx?: { slot: number }): PumpTradeEvent[] {
    if (logs.err) return [];
    const out: PumpTradeEvent[] = [];
    for (const log of PumpFeedListener.pumpOwnedLogs(logs.logs)) {
      if (!log.startsWith('Program data: ')) continue;
      try {
        const buf = Buffer.from(log.slice('Program data: '.length).trim(), 'base64');
        if (buf.length < 129 || !buf.subarray(0, 8).equals(PUMP_TRADE_EVENT_DISCRIMINATOR)) continue;
        let o = 8;
        const mint = new PublicKey(buf.subarray(o, o + 32)).toBase58(); o += 32;
        const solAmountLamports = buf.readBigUInt64LE(o); o += 8;
        const tokenAmount = buf.readBigUInt64LE(o); o += 8;
        const isBuy = buf.readUInt8(o) === 1; o += 1;
        const user = new PublicKey(buf.subarray(o, o + 32)).toBase58(); o += 32;
        const timestampSec = Number(buf.readBigInt64LE(o)); o += 8;
        const virtualSolReserves = buf.readBigUInt64LE(o); o += 8;
        const virtualTokenReserves = buf.readBigUInt64LE(o); o += 8;
        const realSolReserves = buf.readBigUInt64LE(o); o += 8;
        const realTokenReserves = buf.readBigUInt64LE(o);
        out.push({
          signature: logs.signature, slot: ctx?.slot ?? 0, mint, solAmountLamports, tokenAmount, isBuy, user,
          timestampSec, virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves,
        });
      } catch {
        // malformed data: skip
      }
    }
    return out;
  }

  /** Feed one decoded trade into the curve velocity evaluator and notify subscribers. */
  public ingestTradeEvent(trade: PumpTradeEvent): void {
    if (this.nonSolMints.has(trade.mint)) return; // P4.2 (R1-64): a non-SOL curve's sol_amount is not SOL
    const ts = Date.now();
    curveVelocityEvaluator.recordTradeFlow(trade.mint, Number(trade.solAmountLamports) / 1e9, trade.isBuy, ts, trade.slot);
    curveVelocityEvaluator.recordTransition(trade.mint, trade.slot, Number(trade.realSolReserves) / 1e9, ts);
    this.tradesParsed++;
    try {
      this.emit('trade_event', trade);
    } catch (emitErr: any) {
      Logger.warn(`PumpFeedListener trade subscriber error: ${emitErr?.message || emitErr}`);
    }
  }

  /** Mint -> creator for tokens seen in create events, so later scoring can find the creator. */
  private creatorByMint: Map<string, string> = new Map();
  public getCreatorForMint(mint: string): string | undefined {
    return this.creatorByMint.get(mint);
  }

  /**
   * Score a new token's creator from their transaction history, capped at CREATOR_RISK_TIMEOUT_MS. On timeout the
   * lookup keeps running and fills the scorer's per-creator cache, so a later confluence read still sees it.
   * A creator with no report scores 0 creator-risk points (missing is never safe).
   */
  public async scoreCreator(event: PumpCreateEvent): Promise<boolean> {
    this.creatorByMint.set(event.mint, event.creator);
    if (this.creatorByMint.size > 5000) {
      const first = this.creatorByMint.keys().next().value;
      if (first !== undefined) this.creatorByMint.delete(first);
    }
    const conn = this.connection || executionCoordinator.getConnection();
    if (!conn) return false;
    const lookup = creatorRiskScorer.evaluateCreator(conn, event.creator).then(() => true).catch(() => false);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CREATOR_RISK_TIMEOUT_MS));
    return Promise.race([lookup, timeout]);
  }

  /**
   * Parse Solana transaction logs synchronously (<1ms hot path)
   */
  public parseLogs(logs: Logs, ctx?: { slot: number }): PumpCreateEvent | null {
    if (logs.err) return null;
    const t0 = performance.now();
    const slot = ctx?.slot ?? 0;
    const signature = logs.signature;

    for (const log of PumpFeedListener.pumpOwnedLogs(logs.logs)) {
      // 1. Binary Anchor Event: Program data: <base64>
      if (log.startsWith('Program data: ')) {
        const b64Data = log.slice('Program data: '.length).trim();
        try {
          const buf = Buffer.from(b64Data, 'base64');
          if (buf.length >= 8 + 12 + 4 * 32 + 8 + 32) {
            // Verify Anchor discriminator
            const disc = buf.subarray(0, 8);
            if (disc.equals(PUMP_CREATE_EVENT_DISCRIMINATOR)) {
              let offset = 8;

              // Read name
              if (offset + 4 > buf.length) continue;
              const nameLen = buf.readUInt32LE(offset);
              offset += 4;
              if (offset + nameLen > buf.length) continue;
              const name = buf.toString('utf8', offset, offset + nameLen);
              offset += nameLen;

              // Read symbol
              if (offset + 4 > buf.length) continue;
              const symbolLen = buf.readUInt32LE(offset);
              offset += 4;
              if (offset + symbolLen > buf.length) continue;
              const symbol = buf.toString('utf8', offset, offset + symbolLen);
              offset += symbolLen;

              // Read uri
              if (offset + 4 > buf.length) continue;
              const uriLen = buf.readUInt32LE(offset);
              offset += 4;
              if (offset + uriLen > buf.length) continue;
              const uri = buf.toString('utf8', offset, offset + uriLen);
              offset += uriLen;

              // Read mint (32 bytes)
              if (offset + 32 > buf.length) continue;
              const mintPubkey = new PublicKey(buf.subarray(offset, offset + 32));
              offset += 32;

              // Read bondingCurve (32 bytes)
              if (offset + 32 > buf.length) continue;
              const bondingCurvePubkey = new PublicKey(buf.subarray(offset, offset + 32));
              offset += 32;

              // IDL (pump-sdk 1.37) order after the strings: mint, bonding_curve, user, creator, timestamp(i64), then
              // virtual_token_reserves, virtual_sol_reserves, real_token_reserves, token_total_supply (u64 each).
              // The reserves are read, never assumed: an event too short to carry them is skipped, not filled with canonical numbers.
              if (offset + 32 + 32 + 8 + 4 * 8 > buf.length) continue;
              const userPubkey = new PublicKey(buf.subarray(offset, offset + 32));
              offset += 32; // user (the signer of the create; the token creator is the next field)
              const creatorPubkey = new PublicKey(buf.subarray(offset, offset + 32));
              offset += 32;
              offset += 8; // timestamp
              const virtualTokenReserves = buf.readBigUInt64LE(offset);
              offset += 8;
              const virtualSolReserves = buf.readBigUInt64LE(offset);
              offset += 8;
              const realTokenReserves = buf.readBigUInt64LE(offset);
              offset += 8;
              const tokenTotalSupply = buf.readBigUInt64LE(offset);
              offset += 8;
              const realSolReserves = 0n; // a fresh curve holds no SOL; not part of the event
              if (virtualTokenReserves === 0n) continue;
              // P4.2 (R1-64): the newer layout continues with token_program, is_mayhem_mode, is_cashback_enabled, quote_mint (pump-sdk 1.37).
              let quoteMint: string | undefined;
              if (offset + 32 + 1 + 1 + 32 <= buf.length) {
                quoteMint = new PublicKey(buf.subarray(offset + 34, offset + 66)).toBase58();
              }

              const initialPriceSol = Number(virtualSolReserves) / Number(virtualTokenReserves) / 1000;
              const initialMarketCapSol = (Number(tokenTotalSupply) / 1e6) * initialPriceSol;
              const parseLatencyMs = Number((performance.now() - t0).toFixed(3));

              return {
                signature,
                slot,
                mint: mintPubkey.toBase58(),
                creator: creatorPubkey.toBase58(),
                user: userPubkey.toBase58(),
                bondingCurve: bondingCurvePubkey.toBase58(),
                name,
                symbol,
                uri,
                virtualTokenReserves,
                virtualSolReserves,
                realTokenReserves,
                realSolReserves,
                tokenTotalSupply,
                quoteMint,
                initialPriceSol,
                initialMarketCapSol,
                receivedAt: Date.now(),
                parsedAt: Date.now(),
                parseLatencyMs,
                source: 'SOLANA_WS_LOGS',
              };
            }
          }
        } catch {
          // ignore invalid base64 or buffer reads
        }
      }
    }

    return null;
  }

  /**
   * Start listening to Solana WebSocket logs for Pump.fun program
   */
  public async start(): Promise<boolean> {
    if (this.isDestroyed) return false;
    if (this.subscriptionId !== null) return true;

    try {
      this.status = 'CONNECTING';
      const conn = this.connection || executionCoordinator.getConnection();
      if (!conn) {
        this.status = 'ERROR';
        return false;
      }
      this.connection = conn;

      this.subscriptionId = this.connection.onLogs(
        PUMP_FUN_PROGRAM_ID,
        (logs: Logs, ctx: Context) => {
          this.eventsReceived++;
          if (this.gapReason === 'ENDPOINT_SWITCH') this.closeGap(); // the new subscription is delivering
          const handlerStart = performance.now();
          try {
            const trades = this.parseTradeLogs(logs, ctx);
            let event = this.parseLogs(logs, ctx);
            if (event && !isSolQuoteMint(event.quoteMint)) {
              // P4.2 (R1-64): a launch quoted in another mint is not watched, scored or paper-filled, and its trades are dropped too.
              this.nonSolQuoteSkipped++;
              this.nonSolMints.add(event.mint);
              if (this.nonSolMints.size > 5000) this.nonSolMints.delete(this.nonSolMints.values().next().value as string);
              Logger.info(`PumpFeedListener: skipped ${event.mint}, quote mint ${event.quoteMint} is not SOL`);
              event = null;
            }
            if (event) {
              this.eventsParsed++;
              this.lastEventTimestamp = Date.now();
              this.totalParseLatencyMs += event.parseLatencyMs;

              // Record real feed freshness in central coordinator
              try {
                executionCoordinator.recordPumpFeedEvent('SOLANA_WS_PUMP_CREATE', event.mint);
              } catch (coordErr: any) {
                Logger.warn(`PumpFeedListener coordinator record error: ${coordErr?.message || coordErr}`);
              }

              // C2: look the creator up in the background (300ms cap) so the score is cached by the time it is needed
              this.scoreCreator(event).catch(() => {});

              // Emit event to subscribers
              try {
                this.emit('create_event', event);
              } catch (emitErr: any) {
                Logger.warn(`PumpFeedListener subscriber error: ${emitErr?.message || emitErr}`);
              }
            }
            // Q6d: the trades of a create transaction (the dev buy) are ingested AFTER its create event, so a watch started by the
            // create already exists to receive them. Before, they were emitted first and no subscriber was watching yet.
            for (const trade of trades) this.ingestTradeEvent(trade);
          } catch (err: any) {
            this.handlerErrors++;
            Logger.warn(`PumpFeedListener error processing log: ${err.message}`);
          } finally {
            this.slowestHandlerMs = Math.max(this.slowestHandlerMs, Math.round(performance.now() - handlerStart));
          }
        },
        'processed'
      );

      this.status = 'ACTIVE';
      this.armGapDetection(this.connection);
      Logger.info(`PumpFeedListener connected to Solana WebSocket logs (subId: ${this.subscriptionId})`);
      return true;
    } catch (err: any) {
      this.status = 'ERROR';
      Logger.warn(`PumpFeedListener failed to connect: ${err.message}. Scheduling reconnection...`);
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Stop listening and unsubscribe
   */
  public async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const conn = this.connection;
    await this.disarmGapDetection(conn);

    if (this.subscriptionId !== null && conn) {
      try {
        await conn.removeOnLogsListener(this.subscriptionId);
      } catch {}
      this.subscriptionId = null;
    }
    this.status = 'DISCONNECTED';
  }

  /**
   * P4.2 (R1-52): watch the socket ('close' and 'open' on web3.js's websocket client, when the Connection has one) and the slot
   * heartbeat (public `onSlotChange`). web3.js resubscribes by itself after a drop but never redelivers the logs sent meanwhile, so
   * each of these opens a gap; see FEED_SLOT_SILENCE_MS and FEED_SLOT_JUMP_MAX.
   */
  private armGapDetection(conn: Connection): void {
    this.gapOpen = false;
    this.lastSlot = null;
    this.lastSlotAt = 0;
    this.socket = socketOf(conn);
    this.socket?.on('close', this.onSocketClose);
    this.socket?.on('open', this.onSocketOpen);
    if (typeof (conn as any).onSlotChange === 'function') {
      try {
        this.slotSubscriptionId = conn.onSlotChange((info: SlotInfo) => this.onSlot(info));
      } catch (err: any) {
        Logger.warn(`PumpFeedListener: no slot heartbeat (${err?.message || err}); gaps are seen through the socket only`);
      }
    }
    this.heartbeatTimer = setInterval(() => this.checkHeartbeat(), FEED_HEARTBEAT_CHECK_MS);
    this.heartbeatTimer.unref?.();
  }

  private async disarmGapDetection(conn: Connection | null): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const off = (ev: string, fn: () => void) => {
      if (!this.socket) return;
      if (typeof this.socket.off === 'function') this.socket.off(ev, fn);
      else this.socket.removeListener?.(ev, fn);
    };
    off('close', this.onSocketClose);
    off('open', this.onSocketOpen);
    this.socket = null;
    if (this.slotSubscriptionId !== null && conn && typeof (conn as any).removeSlotChangeListener === 'function') {
      try { await conn.removeSlotChangeListener(this.slotSubscriptionId); } catch { /* the socket is going anyway */ }
    }
    this.slotSubscriptionId = null;
    this.gapOpen = false;
    this.gapReason = null;
  }

  private onSlot(info: SlotInfo): void {
    const prev = this.lastSlot;
    this.lastSlot = info.slot;
    this.lastSlotAt = Date.now();
    if (prev !== null && info.slot - prev > FEED_SLOT_JUMP_MAX) {
      // B7: stays RECONNECTING until the next slot shows the stream is delivering in order again
      this.openGap('SLOT_JUMP', `slot notifications jumped from ${prev} to ${info.slot} (more than ${FEED_SLOT_JUMP_MAX})`);
      return;
    }
    this.closeGap(); // a slot arrived in order: the stream is delivering again
  }

  private checkHeartbeat(now = Date.now()): void {
    if (this.status !== 'ACTIVE' || this.lastSlotAt === 0) return;
    if (now - this.lastSlotAt > FEED_SLOT_SILENCE_MS) {
      this.openGap('SLOT_SILENCE', `no slot notification for ${now - this.lastSlotAt} ms (limit ${FEED_SLOT_SILENCE_MS} ms)`);
    }
  }

  /**
   * Open a gap once: status RECONNECTING and a 'feed_gap' event. It closes when the socket reopens or an in-order slot arrives (after
   * SLOT_JUMP, the slot after the jump), and an ENDPOINT_SWITCH gap also on the first log from the new subscription.
   */
  private openGap(reason: FeedGapReason, detail: string): void {
    if (this.gapOpen || this.subscriptionId === null) return;
    this.gapOpen = true;
    this.gapReason = reason;
    this.status = 'RECONNECTING';
    this.emitGap(reason, detail);
  }

  private closeGap(): void {
    if (!this.gapOpen) return;
    this.gapOpen = false;
    this.gapReason = null;
    if (this.subscriptionId !== null) this.status = 'ACTIVE';
    Logger.info('PumpFeedListener: log stream delivering again after a gap');
  }

  private emitGap(reason: FeedGapReason, detail: string): void {
    const gap: FeedGapEvent = { reason, at: Date.now(), detail };
    this.feedGaps++;
    this.lastFeedGap = gap;
    Logger.warn(`PumpFeedListener FEED_GAP (${reason}): ${detail}`);
    try {
      this.emit('feed_gap', gap);
    } catch (emitErr: any) {
      Logger.warn(`PumpFeedListener feed_gap subscriber error: ${emitErr?.message || emitErr}`);
    }
  }

  /**
   * P4.2 (R1-63): move the subscription to a new Connection: unsubscribe on the old one, resubscribe on `conn`. The switch itself is
   * a gap (logs between the two subscriptions are lost), so it is opened as an ENDPOINT_SWITCH gap on the new subscription: status
   * RECONNECTING and 'feed_gap' (B7: before, the status went straight from DISCONNECTED to ACTIVE). The gap closes on the new
   * Connection's first slot, socket open or log. A listener that was not running only takes the new Connection. Creator lookups
   * (`scoreCreator`) use the same Connection, so they move with it.
   */
  public async switchConnection(conn: Connection): Promise<boolean> {
    if (conn === this.connection) return this.isActive();
    const wasRunning = this.subscriptionId !== null || this.reconnectTimer !== null;
    await this.stop();
    this.connection = conn;
    if (!wasRunning || this.isDestroyed) return false;
    const detail = 'the RPC endpoint was switched; logs between the two subscriptions are not seen';
    const started = await this.start();
    if (started) this.openGap('ENDPOINT_SWITCH', detail);
    else this.emitGap('ENDPOINT_SWITCH', detail); // not subscribed (status ERROR or RECONNECTING): watched launches are still released
    return started;
  }

  /** Follow the coordinator's trading Connection: every successful `setRpcEndpoint` moves the subscription (switchConnection). */
  public follow(source: ConnectionChangeSource): void {
    this.unfollow?.();
    this.unfollow = source.onConnectionChange((conn) => {
      this.switchConnection(conn).catch((err: any) => Logger.warn(`PumpFeedListener could not move to the new RPC: ${err?.message || err}`));
    });
  }

  /**
   * Schedule automatic reconnection on connection drops
   */
  private scheduleReconnect() {
    if (this.reconnectTimer || this.isDestroyed) return;
    this.status = 'RECONNECTING';
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isDestroyed) {
        await this.start();
      }
    }, 5000);
  }

  public isActive(): boolean {
    return this.status === 'ACTIVE' && this.subscriptionId !== null;
  }

  public getLastEventTimestamp(): number {
    return this.lastEventTimestamp;
  }

  public getTelemetry(): PumpFeedListenerTelemetry {
    const now = Date.now();
    return {
      status: this.status,
      subscriptionId: this.subscriptionId,
      eventsReceived: this.eventsReceived,
      handlerErrors: this.handlerErrors,
      slowestHandlerMs: this.slowestHandlerMs,
      eventsParsed: this.eventsParsed,
      tradesParsed: this.tradesParsed,
      lastEventTimestamp: this.lastEventTimestamp,
      lastEventAgeMs: this.lastEventTimestamp > 0 ? now - this.lastEventTimestamp : -1,
      averageParseLatencyMs:
        this.eventsParsed > 0 ? Number((this.totalParseLatencyMs / this.eventsParsed).toFixed(2)) : 0,
      activeEndpoint: (this.connection as any)?._rpcEndpoint || 'Solana RPC',
      feedGaps: this.feedGaps,
      lastFeedGap: this.lastFeedGap,
      nonSolQuoteSkipped: this.nonSolQuoteSkipped,
    };
  }

  public destroy() {
    this.isDestroyed = true;
    this.unfollow?.();
    this.unfollow = null;
    this.stop().catch(() => {});
    this.removeAllListeners();
  }
}

// Global Singleton Instance
export const pumpFeedListener = new PumpFeedListener();
