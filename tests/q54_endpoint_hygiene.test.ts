import { describe, it, expect } from 'vitest';
import { endpointOrigin } from '../server/middleware/enterprise';

describe('Q54: an RPC / Jito URL never carries its key into a log or a reply', () => {
  it.each([
    ['https://mainnet.helius-rpc.com/?api-key=SECRET123', 'https://mainnet.helius-rpc.com'],
    ['https://solana-devnet.g.alchemy.com/v2/SECRET123', 'https://solana-devnet.g.alchemy.com'],
    ['https://user:SECRET123@rpc.example.com:8899/path?x=1', 'https://rpc.example.com:8899'],
    ['http://127.0.0.1:8899', 'http://127.0.0.1:8899'],
  ])('%s -> %s', (url, out) => {
    expect(endpointOrigin(url)).toBe(out);
    expect(endpointOrigin(url)).not.toContain('SECRET123');
  });
  it('empty stays empty and garbage is not echoed', () => {
    expect(endpointOrigin(undefined)).toBe('');
    expect(endpointOrigin('not a url SECRET123')).toBe('[unparseable endpoint]');
  });
});
