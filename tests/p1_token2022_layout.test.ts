import { describe, it, expect } from 'vitest';
import {
  ExtensionType,
  getMintLen,
  getExtensionTypes,
  MINT_SIZE,
  ACCOUNT_SIZE,
} from '@solana/spl-token';
import {
  inspectToken2022Extensions,
  EXTENSION_TYPE_NAMES,
  ALLOWED_SAFE_EXTENSIONS,
  MINT_BASE_LEN,
  TOKEN_ACCOUNT_BASE_LEN,
} from '../server/solana/pumpCurve';

/** Build a mint the way Token-2022 lays it out, sized with spl-token's own getMintLen. */
function realToken2022Mint(extensions: Array<{ type: number; len: number }>): Buffer {
  // spl-token sizes the known types; numbers it does not know (16, 17, 24...) are sized by hand.
  const manual = 166 + extensions.reduce((n, e) => n + 4 + e.len, 0);
  let total = manual;
  try { total = Math.max(getMintLen(extensions.map((e) => e.type as ExtensionType)), manual); } catch { /* unknown type */ }
  const buf = Buffer.alloc(total);
  buf.writeUInt32LE(0, 0);
  buf.writeUInt8(6, 44); // decimals
  buf.writeUInt8(1, 45); // initialized
  buf[165] = 1; // AccountType::Mint
  let off = 166;
  for (const e of extensions) {
    buf.writeUInt16LE(e.type, off);
    buf.writeUInt16LE(e.len, off + 2);
    off += 4 + e.len;
  }
  return buf;
}

describe('P1: Token-2022 mint layout (critique #1)', () => {
  it('uses the same base sizes as spl-token', () => {
    expect(MINT_BASE_LEN).toBe(MINT_SIZE);
    expect(TOKEN_ACCOUNT_BASE_LEN).toBe(ACCOUNT_SIZE);
  });

  it('every extension number and name matches the installed spl-token enum', () => {
    for (const [name, value] of Object.entries(ExtensionType)) {
      if (typeof value !== 'number') continue;
      if (name === 'InterestBearingConfig') expect(EXTENSION_TYPE_NAMES[value]).toBe('InterestBearingMint');
      else if (name === 'ScaledUiAmountConfig') expect(EXTENSION_TYPE_NAMES[value]).toBe('ScaledUiAmountMint');
      else if (name === 'PausableConfig') expect(EXTENSION_TYPE_NAMES[value]).toBe('Pausable');
      else expect(EXTENSION_TYPE_NAMES[value]).toBe(name);
    }
  });

  it('the safe set is exactly metadata, group and member pointers/data', () => {
    expect([...ALLOWED_SAFE_EXTENSIONS].sort((a, b) => a - b)).toEqual([
      ExtensionType.MetadataPointer,
      ExtensionType.TokenMetadata,
      ExtensionType.GroupPointer,
      ExtensionType.TokenGroup,
      ExtensionType.GroupMemberPointer,
      ExtensionType.TokenGroupMember,
    ]);
  });

  it('accepts a real create_v2-style mint (MetadataPointer + TokenMetadata) and agrees with spl-token', () => {
    const mint = realToken2022Mint([
      { type: ExtensionType.MetadataPointer, len: 64 },
      { type: ExtensionType.TokenMetadata, len: 120 },
    ]);
    expect(getExtensionTypes(mint.subarray(166))).toEqual([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
    const report = inspectToken2022Extensions(mint);
    expect(report.hasCorruptTlv).toBe(false);
    expect(report.detectedExtensionTypes).toEqual([18, 19]);
    expect(report.isSafe).toBe(true);
  });

  it('rejects a real mint carrying TransferFeeConfig, TransferHook or PermanentDelegate', () => {
    const fee = inspectToken2022Extensions(realToken2022Mint([{ type: ExtensionType.TransferFeeConfig, len: 108 }]));
    expect(fee.hasTransferFee).toBe(true);
    expect(fee.isSafe).toBe(false);
    const hook = inspectToken2022Extensions(realToken2022Mint([{ type: ExtensionType.MetadataPointer, len: 64 }, { type: ExtensionType.TransferHook, len: 64 }]));
    expect(hook.hasTransferHook).toBe(true);
    expect(hook.isSafe).toBe(false);
    const pd = inspectToken2022Extensions(realToken2022Mint([{ type: ExtensionType.PermanentDelegate, len: 32 }]));
    expect(pd.hasPermanentDelegate).toBe(true);
    expect(pd.isSafe).toBe(false);
  });

  it('rejects the confidential-fee and scaled-UI extensions that old numbering mislabelled', () => {
    // Under the old table, 16 and 17 were treated as safe metadata. They are the confidential transfer fee extensions.
    for (const t of [16, 17, 24, 25, 26, 27, 28]) {
      const r = inspectToken2022Extensions(realToken2022Mint([{ type: t as ExtensionType, len: 8 }]));
      expect(r.isSafe, `type ${t}`).toBe(false);
      expect(r.unsupportedExtensionTypes).toContain(t);
    }
  });

  it('a plain 82-byte mint is safe with no extensions', () => {
    const r = inspectToken2022Extensions(Buffer.alloc(82));
    expect(r.isSafe).toBe(true);
    expect(r.detectedExtensionTypes).toEqual([]);
  });

  it('data between 83 and 165 bytes, or without the Mint marker, fails closed', () => {
    expect(inspectToken2022Extensions(Buffer.alloc(100)).hasCorruptTlv).toBe(true);
    expect(inspectToken2022Extensions(Buffer.alloc(165)).isSafe).toBe(false);
    const wrongType = realToken2022Mint([{ type: ExtensionType.MetadataPointer, len: 64 }]);
    wrongType[165] = 2; // AccountType::Account
    expect(inspectToken2022Extensions(wrongType).isSafe).toBe(false);
  });

  it('the old bug: TLV written at byte 83 is no longer read as an extension', () => {
    const old = Buffer.alloc(120);
    old.writeUInt16LE(14, 83);
    old.writeUInt16LE(12, 85);
    expect(inspectToken2022Extensions(old).isSafe).toBe(false); // fails closed as a bad layout, not as a hook
    expect(inspectToken2022Extensions(old).hasTransferHook).toBe(false);
  });

  it('zero padding after the last extension ends the TLV without error', () => {
    const mint = realToken2022Mint([{ type: ExtensionType.MetadataPointer, len: 64 }]);
    const padded = Buffer.concat([mint, Buffer.alloc(16)]);
    const r = inspectToken2022Extensions(padded);
    expect(r.hasCorruptTlv).toBe(false);
    expect(r.isSafe).toBe(true);
  });
});
