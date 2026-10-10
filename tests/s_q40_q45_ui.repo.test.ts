import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('Q40/Q43/Q44/Q45 source checks', () => {
  const read = (p: string) => fs.readFileSync(p, 'utf8');
  it('no creator link is called "Verified", no sim action claims a server effect, KILL asks first, no blanket error swallowing', () => {
    expect(read('src/components/MemecoinSocialSniperModal.tsx')).not.toMatch(/Verified (Token|Telegram)/);
    expect(read('src/components/PumpFunHotCalloutsView.tsx')).not.toMatch(/title=\{`Verified/);
    expect(read('src/App.tsx')).not.toContain('NEW STRATEGY DEPLOYED');
    expect(read('src/App.tsx')).not.toContain('Subscribed to live');
    expect(read('src/components/AutoPanel.tsx')).toContain('window.confirm');
    expect(read('src/components/PlugAndPlayTradingModal.tsx')).not.toContain('handleEmergencyKillSwitch');
    expect(read('index.html')).not.toContain('event.preventDefault()');
    expect(JSON.parse(read('tsconfig.json')).compilerOptions.strictNullChecks).toBe(true);
    expect(read('src/components/UnitTestModal.tsx')).not.toContain('200 Tests');
  });
});
