import './helpers/domGlobals';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDom, removeDom, installFakeServer, FakeServer } from './helpers/domApp';
import { engineClient } from '../src/services/engineClient';

/**
 * R11-8 (client half in engineClient): with the Sniper tip box on "auto" the social-signal snipe passed no tip, and the client's
 * default parameter put a hidden 0.005 SOL tip in the request. No tip given now means no tip sent (the server's dynamic policy decides).
 */
describe('R11-8: the social-signal snipe sends no tip it was not given', () => {
  let server: FakeServer;
  beforeEach(() => { installDom(); server = { calls: [], routes: {}, killSwitchActive: false }; installFakeServer(server); server.routes['/api/social/signals/snipe'] = () => ({ json: { status: 'OK' } }); });
  afterEach(async () => { await removeDom(); });

  it('no tip: the body has none; a tip: it is sent as given', async () => {
    await engineClient.snipeSocialSignal('sig-1', 0.01, undefined, 8);
    await engineClient.snipeSocialSignal('sig-2', 0.01, 0.0007, 8);
    const bodies = server.calls.filter((c) => c.url === '/api/social/signals/snipe').map((c) => c.body);
    expect('jitoTipSol' in bodies[0]).toBe(false);
    expect(bodies[1].jitoTipSol).toBe(0.0007);
  });
});
