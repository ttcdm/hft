import { describe, it, expect } from 'vitest';
import { isReadOnly, parseReadOnlyFlag, readOnlyStartupProblems, assertReadOnlyStartup } from '../server/solana/readOnly';
import { scratchDir } from './helpers/liveServer';

/**
 * R2-7: APEX_READ_ONLY was matched with a strict === 'true', so `True`, `yes` or `1` silently left the server able to sign, and a typo
 * said nothing. Now it is matched trimmed and in any case against a fixed set, and any other value refuses to start. Real readOnly module.
 */
describe('R2-7: APEX_READ_ONLY is parsed strictly and fails closed', () => {
  it('true, 1, yes in any case (trimmed) turn it on; empty, false, 0, no turn it off', () => {
    for (const v of ['true', 'TRUE', 'True', ' yes ', 'YES', '1']) expect(isReadOnly({ APEX_READ_ONLY: v } as any), v).toBe(true);
    for (const v of [undefined, '', '  ', 'false', 'FALSE', 'No', '0']) expect(isReadOnly({ APEX_READ_ONLY: v } as any), String(v)).toBe(false);
  });

  it('any other value is invalid: read-only is on (fail closed) and startup is refused with a reason that names the value', () => {
    const cwd = scratchDir('r27-'); // no default key file here
    for (const v of ['ture', 'on', 'off', 'y', '2', 'true!']) {
      expect(parseReadOnlyFlag(v)).toBe('invalid');
      expect(isReadOnly({ APEX_READ_ONLY: v } as any)).toBe(true);
      const problems = readOnlyStartupProblems({ APEX_READ_ONLY: v } as any, cwd);
      expect(problems.join('\n')).toMatch(new RegExp(`APEX_READ_ONLY="${v.replace('!', '\\!')}" is not a value it accepts`));
    }
    let code: number | null = null;
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { errs.push(a.join(' ')); };
    try {
      assertReadOnlyStartup({ APEX_READ_ONLY: 'Ture' } as any, ((c: number) => { code = c; }) as any, cwd);
    } finally {
      console.error = origErr;
    }
    expect(code).toBe(1);
    expect(errs.join('\n')).toMatch(/REFUSING TO START/);
  });

  it('a valid on value with no key configured starts', () => {
    expect(readOnlyStartupProblems({ APEX_READ_ONLY: 'YES' } as any, scratchDir('r27-'))).toEqual([]);
  });
});
