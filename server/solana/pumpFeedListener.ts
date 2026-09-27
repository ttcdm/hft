import { Connection, PublicKey, Logs, Context } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PUMP_FUN_PROGRAM_ID } from './programs';
import { Logger } from '../middleware/enterprise';
import { executionCoordinator } from '../execution/coordinator';

// Anchor CreateEvent 8-byte discriminator: sha256("event:CreateEvent")[0..8]
// Hex: 1b72a94ddeeb6376
export const PUMP_CREATE_EVENT_DISCRIMINATOR = Buffer.from('1b72a94ddeeb6376', 'hex');

export interface PumpCreateEvent {
  signature: string;
  slot: number;
  mint: string;
  creator: string;
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

    // 8 disc + (4+name) + (4+sym) + (4+uri) + 32 mint + 32 curve + 32 creator
    const baseLen = 8 + 4 + nameBuf.length + 4 + symbolBuf.length + 4 + uriBuf.length + 32 + 32 + 32;
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

    creatorPubkey.toBuffer().copy(buf, offset);
    offset += 32;

    return `Program data: ${buf.toString('base64')}`;
  }

  /**
   * Parse Solana transaction logs synchronously (<1ms hot path)
   */
  public parseLogs(logs: Logs, ctx?: { slot: number }): PumpCreateEvent | null {
    if (logs.err) return null;
    const t0 = performance.now();
    const slot = ctx?.slot ?? 0;
    const signature = logs.signature;

    for (const log of logs.logs) {
      // 1. Binary Anchor Event: Program data: <base64>
      if (log.startsWith('Program data: ')) {
        const b64Data = log.slice('Program data: '.length).trim();
        try {
          const buf = Buffer.from(b64Data, 'base64');
          if (buf.length >= 116) {
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

              // Read user/creator (32 bytes)
              if (offset + 32 > buf.length) continue;
              const creatorPubkey = new PublicKey(buf.subarray(offset, offset + 32));
              offset += 32;

              // Canonical initial reserves for Pump.fun V2 bonding curves
              let virtualTokenReserves = 1_073_000_000_000_000n;
              let virtualSolReserves = 30_000_000_000n;
              let realTokenReserves = 793_100_000_000_000n;
              const realSolReserves = 0n;
              let tokenTotalSupply = 1_000_000_000_000_000n;

              if (offset + 8 <= buf.length) {
                virtualTokenReserves = buf.readBigUInt64LE(offset);
                offset += 8;
              }
              if (offset + 8 <= buf.length) {
                virtualSolReserves = buf.readBigUInt64LE(offset);
                offset += 8;
              }
              if (offset + 8 <= buf.length) {
                realTokenReserves = buf.readBigUInt64LE(offset);
                offset += 8;
              }
              if (offset + 8 <= buf.length) {
                tokenTotalSupply = buf.readBigUInt64LE(offset);
                offset += 8;
              }

              const initialPriceSol = Number(virtualSolReserves) / Number(virtualTokenReserves) / 1000;
              const initialMarketCapSol = (Number(tokenTotalSupply) / 1e6) * initialPriceSol;
              const parseLatencyMs = Number((performance.now() - t0).toFixed(3));

              return {
                signature,
                slot,
                mint: mintPubkey.toBase58(),
                creator: creatorPubkey.toBase58(),
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

      // 2. Structured text log fallback (for simulations, custom RPC log filters, or test fixtures)
      if (log.includes('CreateEvent:') || (log.includes('Instruction: Create') && log.includes('mint='))) {
        const mintMatch = log.match(/mint=([1-9A-HJ-NP-Za-km-z]{32,44})/);
        const creatorMatch = log.match(/(?:creator|user)=([1-9A-HJ-NP-Za-km-z]{32,44})/);
        const curveMatch = log.match(/(?:bonding_curve|curve)=([1-9A-HJ-NP-Za-km-z]{32,44})/);
        const symbolMatch = log.match(/symbol=([A-Za-z0-9_$]+)/);
        const nameMatch = log.match(/name=([^,;]+)/);

        if (mintMatch) {
          const mint = mintMatch[1];
          const creator = creatorMatch ? creatorMatch[1] : '11111111111111111111111111111111';
          const bondingCurve = curveMatch
            ? curveMatch[1]
            : PumpFeedListener.deriveBondingCurvePda(mint).toBase58();
          const symbol = symbolMatch ? symbolMatch[1] : mint.slice(0, 5).toUpperCase();
          const name = nameMatch ? nameMatch[1].trim() : `Token ${symbol}`;
          const parseLatencyMs = Number((performance.now() - t0).toFixed(3));

          return {
            signature,
            slot,
            mint,
            creator,
            bondingCurve,
            name,
            symbol,
            uri: '',
            virtualTokenReserves: 1_073_000_000_000_000n,
            virtualSolReserves: 30_000_000_000n,
            realTokenReserves: 793_100_000_000_000n,
            realSolReserves: 0n,
            tokenTotalSupply: 1_000_000_000_000_000n,
            initialPriceSol: 30 / 1_073_000_000,
            initialMarketCapSol: 27.958993,
            receivedAt: Date.now(),
            parsedAt: Date.now(),
            parseLatencyMs,
            source: 'RPC_LOGS',
          };
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
            const event = this.parseLogs(logs, ctx);
            if (event) {
              this.eventsParsed++;
              this.lastEventTimestamp = Date.now();
              this.totalParseLatencyMs += event.parseLatencyMs;

              // Record real feed freshness in central coordinator
              executionCoordinator.recordPumpFeedEvent('SOLANA_WS_PUMP_CREATE', event.mint);

              // Emit event to subscribers
              this.emit('create_event', event);
            }
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
