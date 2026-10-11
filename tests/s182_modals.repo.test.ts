import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Run effects immediately so the real hook can be exercised without a DOM.
let cleanups: Array<void | (() => void)> = [];
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), useEffect: (fn: () => void | (() => void)) => { cleanups.push(fn()); } }));

import { useEscapeToClose, isEscapeKey } from '../src/utils/useEscapeToClose';

const listeners = new Map<string, Set<(e: any) => void>>();
beforeEach(() => {
  cleanups = []; listeners.clear();
  (globalThis as any).window = {
    addEventListener: (t: string, f: any) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(f); },
    removeEventListener: (t: string, f: any) => { listeners.get(t)?.delete(f); },
  };
});
const press = (key: string, defaultPrevented = false) => listeners.get('keydown')?.forEach((f) => f({ key, defaultPrevented }));

describe('S182 Escape closes a dialog', () => {
  it('closes on Escape while open, ignores other keys, and stops listening when it is cleaned up', () => {
    const close = vi.fn();
    useEscapeToClose(true, close);
    press('Enter'); press('a');
    expect(close).not.toHaveBeenCalled();
    press('Escape');
    expect(close).toHaveBeenCalledTimes(1);
    (cleanups[0] as () => void)();
    press('Escape');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('registers nothing while the dialog is closed, and skips an Escape another handler already took', () => {
    const close = vi.fn();
    useEscapeToClose(false, close);
    expect(listeners.get('keydown')?.size ?? 0).toBe(0);
    useEscapeToClose(true, close);
    press('Escape', true);
    expect(close).not.toHaveBeenCalled();
    expect(isEscapeKey({ key: 'Escape', defaultPrevented: false })).toBe(true);
  });

  it('every dialog component uses it, including System checks', () => {
    for (const f of ['SystemChecksModal', 'ExecutionLatencyModal', 'AutoPipelineModal', 'BacktestModal', 'AiDiagnosticsModal', 'EngineConsoleModal', 'AuthModal', 'MemecoinSocialSniperModal', 'PlugAndPlayTradingModal']) {
      const src = fs.readFileSync(`src/components/${f}.tsx`, 'utf8');
      expect(src, f).toContain('useEscapeToClose(isOpen, onClose);');
      // the hook runs before the early return, or React would see a different number of hooks when the dialog opens
      expect(src.indexOf('useEscapeToClose(isOpen, onClose);'), f).toBeLessThan(src.lastIndexOf('if (!isOpen) return null;'));
    }
  });
});

describe('S182 the strategy dialog and its presets are gone', () => {
  it('nothing read the list it fed, so the dialog, the Deploy button and the BTC / NVDA / EUR / gold presets are removed', () => {
    const app = fs.readFileSync('src/App.tsx', 'utf8');
    const header = fs.readFileSync('src/components/Header.tsx', 'utf8');
    expect(fs.existsSync('src/components/DeployBotModal.tsx')).toBe(false);
    for (const gone of ['DeployBotModal', 'INITIAL_BOTS', 'botsRef', 'handleDeployBot', 'Optiver', 'Jump Micro', 'NVDA']) expect(app, gone).not.toContain(gone);
    for (const gone of ['onOpenDeployModal', 'btn-deploy-algorithm', 'Deploy']) expect(header, gone).not.toContain(gone);
    const types = fs.readFileSync('src/types.ts', 'utf8');
    expect(types).not.toMatch(/TradingBot|StrategyArchetype|AssetClass/);
  });
});
