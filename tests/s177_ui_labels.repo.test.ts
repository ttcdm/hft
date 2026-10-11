import { describe, it, expect } from 'vitest';
import fs from 'fs';

const header = fs.readFileSync('src/components/Header.tsx', 'utf8');

describe('S177: Quant Tools menu labels state facts', () => {
  it('the checks entry reads live state: no 700-check suite and no TOY MATH label to explain away', () => {
    expect(header).not.toMatch(/700 (Tests|Checks|Self)/);
    expect(header).toMatch(/System checks/);
    expect(header).not.toMatch(/TOY MATH/);
  });
  it('no assumed co-location latency in the menu: the latency entry is measured from the journal', () => {
    expect(header).not.toMatch(/>1\.15ms</);
    expect(header).not.toMatch(/Co-Loc|ASSUMED/);
    expect(header).toMatch(/Execution latency/);
  });
  it('badges are counts, modes or sources, not adjectives', () => {
    for (const adjective of ['ASYNC', '2 MO', 'ACTIVE', 'REQUIRED']) expect(header).not.toContain(`>${adjective}<`);
    expect(header).toContain('from journal');
    expect(header).toMatch(/mode \$\{autoStatus\.mode\}/);
  });
});
