import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
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
  eventsParsed: number;
  tradesParsed: number;
  lastEventTimestamp: number;
  lastEventAgeMs: number;
  averageParseLatencyMs: number;
  activeEndpoint: string;
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
  private eventsParsed: number = 0;
  private tradesParsed: number = 0;
  private lastEventTimestamp: number = 0;
  private totalParseLatencyMs: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDestroyed: boolean = false;

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
    const buf = Buffer.alloc(baseLen);
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
          try {
            const trades = this.parseTradeLogs(logs, ctx);
            const event = this.parseLogs(logs, ctx);
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
            Logger.warn(`PumpFeedListener error processing log: ${err.message}`);
          }
        },
        'processed'
      );

      this.status = 'ACTIVE';
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

    if (this.subscriptionId !== null && this.connection) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch {}
      this.subscriptionId = null;
    }
    this.status = 'DISCONNECTED';
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
      eventsParsed: this.eventsParsed,
      tradesParsed: this.tradesParsed,
      lastEventTimestamp: this.lastEventTimestamp,
      lastEventAgeMs: this.lastEventTimestamp > 0 ? now - this.lastEventTimestamp : -1,
      averageParseLatencyMs:
        this.eventsParsed > 0 ? Number((this.totalParseLatencyMs / this.eventsParsed).toFixed(2)) : 0,
      activeEndpoint: (this.connection as any)?._rpcEndpoint || 'Solana RPC',
    };
  }

  public destroy() {
    this.isDestroyed = true;
    this.stop().catch(() => {});
    this.removeAllListeners();
  }
}

// Global Singleton Instance
export const pumpFeedListener = new PumpFeedListener();
