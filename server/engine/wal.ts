import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WALEntry } from './types';

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  } catch {
    return String(obj);
  }
}

export class EngineWAL {
  private seqId: number = 0;
  private recentEntries: WALEntry[] = [];
  private maxInMemoryEntries: number = 1000;
  private logFilePath: string;
  private fileWriteStream: fs.WriteStream | null = null;
  private lastChecksum: string = '0000000000000000000000000000000000000000000000000000000000000000';

  constructor(filePath?: string) {
    this.logFilePath = filePath || process.env.APEX_WAL_PATH || path.join(process.cwd(), 'apex_engine.wal');
    this.initFileStream();
  }

  private initFileStream() {
    try {
      this.fileWriteStream = fs.createWriteStream(this.logFilePath, {
        flags: 'a',
        encoding: 'utf8',
      });
    } catch (e) {
      console.warn('[EngineWAL] Unable to open disk file for WAL, running in memory-mode:', e);
      this.fileWriteStream = null;
    }
  }

  public record(eventType: WALEntry['eventType'], payload: Record<string, any>): WALEntry {
    this.seqId += 1;
    const nowHrTime = process.hrtime.bigint();
    const isoTime = new Date().toISOString();

    const rawData = `${this.seqId}|${nowHrTime.toString()}|${eventType}|${safeStringify(payload)}|${this.lastChecksum}`;
    const checksum = crypto.createHash('sha256').update(rawData).digest('hex');
    this.lastChecksum = checksum;

    const entry: WALEntry = {
      seqId: this.seqId,
      timestampNs: nowHrTime.toString(),
      timestampIso: isoTime,
      eventType,
      payload,
      checksum,
    };

    // Store in circular memory buffer
    this.recentEntries.push(entry);
    if (this.recentEntries.length > this.maxInMemoryEntries) {
      this.recentEntries.shift();
    }

    // Persist to WAL disk stream
    if (this.fileWriteStream) {
      this.fileWriteStream.write(safeStringify(entry) + '\n');
    }

    return entry;
  }

  public getRecent(limit: number = 100): WALEntry[] {
    return this.recentEntries.slice(-limit);
  }

  public getCurrentSeq(): number {
    return this.seqId;
  }

  public exportJournal(): string {
    return this.recentEntries.map((e) => safeStringify(e)).join('\n');
  }

  public clear() {
    this.recentEntries = [];
    this.seqId = 0;
    this.lastChecksum = '0000000000000000000000000000000000000000000000000000000000000000';
  }
}
