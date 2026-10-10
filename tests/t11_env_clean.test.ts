import { describe, it, expect } from 'vitest';
import os from 'node:os';

// T11/T12: the vitest config pins the environment, so a shell that exports live-trading or notification settings cannot leak in.
describe('T11/T12: tests start from a clean, non-live environment', () => {
  it('no live-trading, auto-snipe, demo or notification setting is inherited', () => {
    for (const k of ['ALLOW_LIVE_REAL_MONEY_TRADING', 'AUTO_SNIPE_ENABLED', 'AUTO_MANAGE_RECOVERED', 'DEMO_MODE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'OPERATOR_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY']) {
      expect(process.env[k] ?? '', k).toBe('');
    }
    expect(process.env.APEX_ENV_FILE).toBe('');
  });
  it('the engine WAL goes to the temp dir, not the checkout', async () => {
    const { EngineWAL } = await import('../server/engine/wal') as any;
    const wal = new EngineWAL();
    expect(String((wal as any).logFilePath).startsWith(os.tmpdir())).toBe(true);
  });
});
