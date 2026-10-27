import { describe, it, expect } from 'vitest';
import fs from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sanitizeTwitterUrl, sanitizeTelegramUrl, sanitizeXProfileUrl, getTokenExternalLinks } from '../src/utils/tokenLinks';
import { TokenImage } from '../src/components/PumpFunHotCalloutsView';

/**
 * Round 1 #12 and R2-11 (haiku-attack 2026-10-26): a creator-supplied X handle was labelled "Official", social links accepted any
 * host, and the creator-hosted token image loaded in the operator's browser (an IP and timing beacon to the creator).
 */
describe('R2-11: creator-supplied links go only to the host they claim', () => {
  it('an X link on another host is not followed; the search link is used instead', () => {
    expect(sanitizeXProfileUrl('https://evil.example/x.com/dev')).toBeUndefined();
    expect(sanitizeTwitterUrl('https://evil.example/login', 'ABC')).toMatch(/^https:\/\/x\.com\/search\?q=/);
    expect(sanitizeTwitterUrl('https://twitter.com/dev', 'ABC')).toBe('https://twitter.com/dev');
    expect(sanitizeTwitterUrl('@dev_1', 'ABC')).toBe('https://x.com/dev_1');
    expect(sanitizeXProfileUrl('javascript:alert(1)')).toBeUndefined();
  });
  it('a Telegram link on another host is dropped', () => {
    expect(sanitizeTelegramUrl('https://t.me/group')).toBe('https://t.me/group');
    expect(sanitizeTelegramUrl('https://tracker.example/t.me')).toBeUndefined();
    expect(sanitizeTelegramUrl('not a handle!')).toBeUndefined();
  });
  it('a creator website is labelled with the host it goes to', () => {
    const items = getTokenExternalLinks({ mintOrCa: 'So11111111111111111111111111111111111111112', symbol: 'ABC', website: 'https://shady.example/page' } as any);
    const site = items.find((i) => i.id === 'website')!;
    expect(site.name).toBe('Creator-supplied site: shady.example');
  });
});

describe('Round 1 #12 / R2-11: no "Official" label, no auto-loaded creator image', () => {
  it('the callout card says creator-supplied, not Official', () => {
    const src = fs.readFileSync('src/components/PumpFunHotCalloutsView.tsx', 'utf8');
    expect(src).not.toContain('Official 𝕏');
    expect(src).toContain('supplied by the token creator (unverified)');
  });
  it('the token image is not requested until the operator clicks', () => {
    const html = renderToStaticMarkup(<TokenImage uri="https://creator.example/img.png" symbol="ABC" />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('creator.example/img.png"');
    expect(html).toContain('data-testid="token-image-click"');
  });
});
