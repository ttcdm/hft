import fs from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Round-3 visual pass (headless Chromium, scripts/visual/): layout is checked by that harness (no DOM environment here),
 * these pin the label and class fixes it found so they cannot quietly come back.
 */
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('V1/V2: labels match what the control really is', () => {
  const header = read('src/components/Header.tsx');
  it('the self-check button and menu entry do not call toy math a live unit-test suite', () => {
    expect(header).not.toMatch(/700 Tests|700 Unit Tests|700 High-Stakes/);
    expect(header).toMatch(/700 Self-Checks/);
    expect(header).toMatch(/TOY MATH/);
  });
  it('Plug & Play carries no static LIVE badge (the mode pill shows the real mode)', () => {
    expect(header).not.toMatch(/LIVE ⚡/);
  });
  it('the assumed 1.15ms co-location latency is labelled ASSUMED in the menu', () => {
    expect(header).not.toMatch(/>1\.15ms</);
    expect(header).toMatch(/ASSUMED/);
  });
  it('the Deploy button does not claim a CME / NY4 engine', () => {
    expect(read('src/components/DeployBotModal.tsx')).not.toMatch(/CME \/ NY4/);
  });
});

describe('V1: header fits at 1280px (kill switch must never be pushed off screen)', () => {
  const header = read('src/components/Header.tsx');
  it('the wide-only nav badge and the AUTH label are hidden below their breakpoints', () => {
    expect(header).toMatch(/hidden min-\[1536px\]:inline[^"]*"[^>]*>\s*HOT/);
    expect(header).toMatch(/hidden min-\[1440px\]:inline">\{isOperatorAuthenticated/);
  });
});

describe('V3: board column headers align with their cells', () => {
  const board = read('src/components/TokenBoard.tsx');
  it('left-aligned headers do not also carry text-right (CSS order made the right one win)', () => {
    expect(board).not.toMatch(/\$\{head\} text-left/);
    expect(board.match(/className=\{headLeft\}/g)?.length).toBe(3);
  });
});

describe('V4: the hot-callouts status line shows what the server reported, never an invented default', () => {
  const view = read('src/components/PumpFunHotCalloutsView.tsx');
  it('no 30 / 120 / 85 / 142 fallbacks for tokens monitored and latency', () => {
    expect(view).not.toMatch(/tokensTrackedCount \|\| 30|syncLatencyMs \|\| (120|85)|syncLatencyMs: 142|tokensTrackedCount: 30/);
    expect(view).toMatch(/tokensTrackedCount \?\? 0/);
  });
});
