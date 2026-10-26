import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { probeBadge, probeLatency, hostOfService } from '../src/utils/probeBadge';

/** Q10a: the diagnostics modal showed "200 OK • LIVE" and "HEALTH OK • LIVE" as literals, a hardcoded mainnet RPC host and "100% production live". */
describe('Q10a: connectivity pills come from what the probe returned', () => {
  it('reachable shows the status, unreachable shows why, a probe that did not run shows NOT PROBED', () => {
    expect(probeBadge({ reachable: true, status: 200 }, 'REACHABLE')).toEqual({ text: 'REACHABLE • HTTP 200', ok: true });
    expect(probeBadge({ reachable: true, health: 'ok' }, 'RPC REACHABLE')).toEqual({ text: 'RPC REACHABLE', ok: true });
    expect(probeBadge({ reachable: false, error: 'fetch failed' }, 'REACHABLE')).toEqual({ text: 'UNREACHABLE • fetch failed', ok: false });
    expect(probeBadge({ reachable: false, status: 403 }, 'REACHABLE')).toEqual({ text: 'UNREACHABLE • HTTP 403', ok: false });
    expect(probeBadge({ reachable: false }, 'REACHABLE').text).toBe('UNREACHABLE • no response');
    expect(probeBadge(undefined, 'REACHABLE')).toEqual({ text: 'NOT PROBED', ok: false });
  });

  it('a latency that was not measured is a dash, and the RPC host comes from the server\'s own service string', () => {
    expect(probeLatency(0)).toBe('—');
    expect(probeLatency(undefined)).toBe('—');
    expect(probeLatency(87)).toBe('87ms');
    expect(hostOfService('Solana RPC (api.devnet.solana.com)')).toBe('api.devnet.solana.com');
    expect(hostOfService(undefined)).toBe('unknown');
  });

  it('the modal no longer carries the literals', () => {
    const src = fs.readFileSync('src/components/MemecoinSocialSniperModal.tsx', 'utf8');
    for (const lie of ['200 OK • LIVE', 'HEALTH OK • LIVE', 'api.mainnet-beta.solana.com', '100% production live', '|| 65}ms']) {
      expect(src.includes(lie), lie).toBe(false);
    }
  });
});
