import bs58 from 'bs58';

/**
 * Parse secret-key material (a JSON byte array or base58). Any failure throws a fixed message and never echoes the input:
 * on newer Node versions `JSON.parse` / bs58 error messages quote part of the text they choked on, which here is a secret key (R7s).
 */
export function parseSecretKey(raw: string): Uint8Array {
  const text = raw.trim();
  try {
    if (text.startsWith('[') && text.endsWith(']')) {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return Uint8Array.from(parsed);
    }
    return bs58.decode(text);
  } catch {
    throw new Error('Secret key is not a valid JSON byte array or base58 string (the input is not shown)');
  }
}
