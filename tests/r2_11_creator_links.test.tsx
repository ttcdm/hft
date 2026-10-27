import './helpers/domGlobals';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { installDom, removeDom, installFakeServer, flush, type FakeServer } from './helpers/domApp';
import { mount } from './helpers/mountDom';
import { MemecoinSocialSniperModal } from '../src/components/MemecoinSocialSniperModal';
import { pumpFunService } from '../server/pumpfunService';
import { autoSnipeController } from '../server/auto/controller';
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
  afterEach(async () => { await removeDom(); (pumpFunService as any).hotCallouts = []; (pumpFunService as any).rawTokensCache = []; });
  it('the callout card says creator-supplied, not Official', async () => {
    installDom();
    const server: FakeServer = { calls: [], routes: {}, killSwitchActive: false };
    installFakeServer(server);
    vi.spyOn(autoSnipeController, 'getMode').mockReturnValue('OFF');
    const t = Date.now();
    pumpFunService.handleOnChainCreateEvent({
      signature: 'sig', slot: 1, mint: Keypair.generate().publicKey.toBase58(), creator: Keypair.generate().publicKey.toBase58(), bondingCurve: Keypair.generate().publicKey.toBase58(),
      name: 'R211', symbol: 'R211', uri: '', virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n,
      realSolReserves: 0n, tokenTotalSupply: 1_000_000_000_000_000n, initialPriceSol: 2.8e-8, initialMarketCapSol: 28, receivedAt: t, parsedAt: t, parseLatencyMs: 1, source: 'TEST_FEED',
    } as any);
    // a real callout of the service, with the X handle its creator put in the token metadata
    const callouts = pumpFunService.getHotCallouts().map((c) => ({ ...c, token: { ...c.token, twitter: 'https://x.com/dev_r211' } }));
    server.routes['/api/pumpfun/callouts'] = () => ({ json: { status: 'OK', feedStatus: 'ONLINE', callouts, leaderboard: [], autoSnipeRules: pumpFunService.getAutoSnipeRules() } });
    const { container, unmount } = await mount(<MemecoinSocialSniperModal isOpen onClose={() => {}} />);
    await flush(10);
    const x = [...container.querySelectorAll('a')].find((a) => a.getAttribute('href') === 'https://x.com/dev_r211');
    expect(x).toBeTruthy();
    expect(x!.getAttribute('title')).toContain('supplied by the token creator (unverified)');
    expect(x!.textContent).toContain('creator-supplied');
    expect(container.textContent).not.toContain('Official');
    await unmount();
  });
  it('the token image is not requested until the operator clicks', () => {
    const html = renderToStaticMarkup(<TokenImage uri="https://creator.example/img.png" symbol="ABC" />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('creator.example/img.png"');
    expect(html).toContain('data-testid="token-image-click"');
  });
});
