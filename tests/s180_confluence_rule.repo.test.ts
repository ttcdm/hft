import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { CONFLUENCE_RULE_LABEL, CONFLUENCE_RULE_NOTE, CONFLUENCE_RULE_MIN_SCORE } from '../src/utils/calloutRuleText';
import { MIN_CONFLUENCE_SCORE } from '../server/signals/confluenceEngine';

const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('S180 confluence rule wording matches the code', () => {
  it('the score in the text is the engine\'s real minimum', () => {
    expect(CONFLUENCE_RULE_MIN_SCORE).toBe(MIN_CONFLUENCE_SCORE);
    expect(CONFLUENCE_RULE_NOTE).toContain(`${MIN_CONFLUENCE_SCORE}+`);
  });

  it('the old claims are gone from the screen and the text', () => {
    const view = read('src/components/PumpFunHotCalloutsView.tsx');
    for (const old of ['Auto-Snipe on 2x+ Confluence', 'verified callers call the same coin within 3 minutes']) {
      expect(view).not.toContain(old);
      expect(CONFLUENCE_RULE_NOTE).not.toContain(old);
    }
    expect(CONFLUENCE_RULE_LABEL).not.toMatch(/2x/);
    expect(view).toContain('{CONFLUENCE_RULE_LABEL}');
    expect(view).toContain('{CONFLUENCE_RULE_NOTE}');
  });

  it('the code still does what the text says', () => {
    const svc = read('server/pumpfunService.ts');
    // confluence = velocity feed AND boosted list
    expect(svc).toMatch(/if \(inPumpVelocity && isBoosted\) \{\s*confluenceCount = hasOrderFlowSurge \? 3 : 2;/);
    // the rule widens the trigger to (caller stats) OR (confluence and score), and forces the score at execution
    expect(svc).toMatch(/rules\.autoSnipeOnConfluence &&\s*callout\.confluenceCount >= 2 &&\s*isConfluenceScorePassed/);
    expect(svc).toContain('((meetsCallerWinRate && meetsAvgMultiple) || meetsConfluence)');
    expect(svc).toContain('enforceConfluence: rules.autoSnipeOnConfluence');
    // nothing is evaluated while the controller is OFF
    expect(svc).toContain("if (autoSnipeController.getMode() === 'OFF') return;");
  });
});
