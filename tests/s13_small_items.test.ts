import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WorkstationDatabase } from '../server/db/database';
import { socialScanner } from '../server/socialScanner';
import { memecoinAggregator } from '../server/memecoinAggregator';
import { ExecutionCoordinator } from '../server/execution/coordinator';

afterEach(() => { vi.restoreAllMocks(); socialScanner.setPanicHook(null); });

describe('S13', () => {
  it('"Trading venue … cannot be resolved" is a non-attempt exit error', () => {
    const f = (ExecutionCoordinator as any).isNonAttemptExitError;
    expect(f('Trading venue for mint X cannot be resolved or migrated to unknown DEX')).toBe(true);
    expect(f('RPC timeout while sending')).toBe(false);
  });

  it('Telegram /panic_sell runs the panic hook (kill switch, disarm, stop auto) even with nothing open, and says so', async () => {
    const hook = vi.fn(async () => {});
    socialScanner.setPanicHook(hook);
    vi.spyOn(memecoinAggregator, 'getPositions').mockReturnValue([] as any);
    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(r.reply).toContain('auto stopped');
  });

  it('a failing panic hook is reported, not hidden', async () => {
    socialScanner.setPanicHook(async () => { throw new Error('boom'); });
    vi.spyOn(memecoinAggregator, 'getPositions').mockReturnValue([] as any);
    const r = await socialScanner.processTelegramCommand('/panic_sell');
    expect(r.reply).toContain('Could not stop new entries: boom');
  });

  it('the realized_events backfill skips adopted (RECOVERED) balances', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's13-')), 's13.db');
    const db = new WorkstationDatabase(file);
    const raw = (db as any).db;
    const mint = Keypair.generate().publicKey.toBase58();
    raw.exec(`INSERT INTO positions (id,mint,symbol,name,token_decimals,token_quantity_raw,cost_basis_lamports,entry_price_sol,current_price_sol,realized_pnl_lamports,entry_tx_signature,entry_timestamp,execution_mode,status,updated_at)
      VALUES ('r1','${mint}','R','R',6,'0',0,1,1,5000000,'RECOVERED:r1',1,'LIVE','CLOSED',1),('n1','${mint}','N','N',6,'0',1,1,1,-3000000,'sig-n1',1,'LIVE','CLOSED',1)`);
    raw.exec('DELETE FROM realized_events');
    new WorkstationDatabase(file); // reopening runs the backfill because the table is empty
    const ids = (raw.prepare('SELECT position_id FROM realized_events').all() as any[]).map((r) => r.position_id);
    expect(ids).toEqual(['n1']);
  });
});
