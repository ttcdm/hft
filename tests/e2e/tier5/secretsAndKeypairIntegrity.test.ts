import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import bs58 from 'bs58';
import { LocalKeypairSigner } from '../../../server/solana/signer';
import { AuthManager } from '../../../server/middleware/auth';

// RFC 8410: id-Ed25519 SPKI public key DER prefix (12 bytes)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519Signature(message: Buffer | Uint8Array, signature: Buffer | Uint8Array, publicKeyBytes: Buffer | Uint8Array): boolean {
  try {
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]);
    const keyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), keyObj, Buffer.from(signature));
  } catch {
    return false;
  }
}

describe('Tier 5: Production Readiness — Secrets, Keypair Management & Cryptographic Signer Invariants', () => {
  let tempKeyDir: string;

  beforeEach(() => {
    tempKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex_keys_test_'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      if (fs.existsSync(tempKeyDir)) {
        fs.rmSync(tempKeyDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // =========================================================================
  // 1. Dedicated Keypair Generation & Permissions Security
  // =========================================================================
  describe('Dedicated Keypair Generation & Permissions Security', () => {
    it('SKI-1: generates dedicated trading keypair with mode 0o600 on disk and sets status to READY', () => {
      const targetPath = path.join(tempKeyDir, 'trading_key.json');
      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      const result = signer.generateDedicatedTradingKeypair(false);
      expect(result.publicKey).toBeDefined();
      expect(result.path).toBe(targetPath);
      expect(signer.getStatus()).toBe('READY');
      expect(signer.getPublicKey().toBase58()).toBe(result.publicKey);

      // Verify file existence and content
      expect(fs.existsSync(targetPath)).toBe(true);
      const rawContent = fs.readFileSync(targetPath, 'utf8');
      const parsedBytes = JSON.parse(rawContent);
      expect(Array.isArray(parsedBytes)).toBe(true);
      expect(parsedBytes.length).toBe(64);

      // Verify POSIX file permissions: mode 0o600 (read/write only for owner)
      const stats = fs.statSync(targetPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('SKI-2: prevents accidental overwrite and throws if keypair already exists without forceOverwrite: true', () => {
      const targetPath = path.join(tempKeyDir, 'existing_key.json');
      fs.writeFileSync(targetPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });

      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      expect(() => {
        signer.generateDedicatedTradingKeypair(false);
      }).toThrow(/already exists.*forceOverwrite: true confirmation required/);
    });

    it('SKI-3: allows replacing existing keypair when forceOverwrite: true is explicitly provided', () => {
      const targetPath = path.join(tempKeyDir, 'overwrite_key.json');
      const initialKp = Keypair.generate();
      fs.writeFileSync(targetPath, JSON.stringify(Array.from(initialKp.secretKey)), { mode: 0o600 });

      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      const result = signer.generateDedicatedTradingKeypair(true);
      expect(result.publicKey).not.toBe(initialKp.publicKey.toBase58());
      expect(signer.getPublicKey().toBase58()).toBe(result.publicKey);
      expect(signer.getStatus()).toBe('READY');
    });
  });

  // =========================================================================
  // 2. Secret Key Ingestion & Multi-Format Validation
  // =========================================================================
  describe('Secret Key Ingestion & Multi-Format Validation', () => {
    it('SKI-4: imports keypair from JSON array [1, 2, ...] format with mode 0o600', () => {
      const targetPath = path.join(tempKeyDir, 'import_array.json');
      const kp = Keypair.generate();
      const jsonArrayStr = JSON.stringify(Array.from(kp.secretKey));

      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      const result = signer.importKeypair(jsonArrayStr, false);
      expect(result.publicKey).toBe(kp.publicKey.toBase58());
      expect(signer.getStatus()).toBe('READY');
      expect(signer.getPublicKey().equals(kp.publicKey)).toBe(true);

      const stats = fs.statSync(targetPath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('SKI-5: imports keypair from Base58 string with whitespace trimming', () => {
      const targetPath = path.join(tempKeyDir, 'import_base58.json');
      const kp = Keypair.generate();
      const base58Str = `   ${bs58.encode(kp.secretKey)}   \n`;

      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      const result = signer.importKeypair(base58Str, false);
      expect(result.publicKey).toBe(kp.publicKey.toBase58());
      expect(signer.getStatus()).toBe('READY');
    });

    it('SKI-6: strictly rejects secret keys with byte length !== 64 (truncated or padded keys)', () => {
      const targetPath = path.join(tempKeyDir, 'invalid_len.json');
      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      // 32-byte seed (not full 64-byte secret key)
      const truncated = JSON.stringify(Array.from(new Uint8Array(32)));
      expect(() => {
        signer.importKeypair(truncated, false);
      }).toThrow(/Invalid secret key length\. Expected 64 bytes, got 32/);

      // 65-byte invalid key
      const oversized = JSON.stringify(Array.from(new Uint8Array(65)));
      expect(() => {
        signer.importKeypair(oversized, false);
      }).toThrow(/Invalid secret key length\. Expected 64 bytes, got 65/);
    });

    it('SKI-7: rejects corrupt non-base58 and non-json secret key inputs', () => {
      const targetPath = path.join(tempKeyDir, 'corrupt.json');
      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;

      expect(() => {
        signer.importKeypair('NOT_A_VALID_KEY_STRING_!!!', false);
      }).toThrow();
    });
  });

  // 3. Export of the private key: removed (108). `exportKeypairSafely` had no caller in server/, src/, scripts/ or any route; the
  // key can only leave the process by the operator reading the key file. Its three tests (SKI-8, SKI-9, SKI-10) went with it.
  // =========================================================================
  // 4. Cryptographic Signer Isolation & Fail-Closed Invariants
  // =========================================================================
  describe('Cryptographic Signer Isolation & Fail-Closed Invariants', () => {
    it('SKI-11: getPublicKey() throws when signer is NOT_CONFIGURED or LOCKED', () => {
      const signer = new LocalKeypairSigner();
      expect(signer.getStatus()).toBe('NOT_CONFIGURED');
      expect(() => signer.getPublicKey()).toThrow(/Signer not configured or locked/);
    });

    it('SKI-12: signTransaction() throws when signer is NOT_CONFIGURED or LOCKED', async () => {
      const signer = new LocalKeypairSigner();
      const dummyPayer = Keypair.generate().publicKey;
      const dummyTx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: dummyPayer,
          recentBlockhash: '11111111111111111111111111111111',
          instructions: [],
        }).compileToV0Message()
      );

      await expect(signer.signTransaction(dummyTx)).rejects.toThrow(/Local signer is not ready to sign transactions/);
    });

    it('SKI-13: signMessage() throws when signer is NOT_CONFIGURED or LOCKED', async () => {
      const signer = new LocalKeypairSigner();
      const message = Buffer.from('test_message');
      await expect(signer.signMessage(message)).rejects.toThrow(/Local signer is not ready to sign messages/);
    });

    it('SKI-14: real Ed25519 message signature via Node crypto.sign DER-wrapped key is cryptographically valid', async () => {
      const targetPath = path.join(tempKeyDir, 'crypto_sign.json');
      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;
      const { publicKey } = signer.generateDedicatedTradingKeypair(true);

      const messageBytes = Buffer.from('APEX_QUANT_HFT_ORDER_AUTHORIZATION_123456');
      const signatureBytes = await signer.signMessage(messageBytes);

      // Verify signature byte length is exactly 64 bytes
      expect(signatureBytes.length).toBe(64);

      // Verify cryptographic signature against public key using Node.js crypto
      const pubkeyBytes = new PublicKey(publicKey).toBytes();
      const isValid = verifyEd25519Signature(messageBytes, signatureBytes, pubkeyBytes);
      expect(isValid).toBe(true);

      // Verify tampered message fails cryptographic verification
      const tamperedMessage = Buffer.from('APEX_QUANT_HFT_ORDER_AUTHORIZATION_TAMPERED');
      const isTamperedValid = verifyEd25519Signature(tamperedMessage, signatureBytes, pubkeyBytes);
      expect(isTamperedValid).toBe(false);
    });

    it('SKI-15: real Ed25519 transaction signing sets primary signature matching keypair public key', async () => {
      const targetPath = path.join(tempKeyDir, 'tx_sign.json');
      const signer = new LocalKeypairSigner();
      (signer as any).keypairPath = targetPath;
      signer.generateDedicatedTradingKeypair(true);

      const payer = signer.getPublicKey();
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: payer,
          recentBlockhash: '4Nd1mBQtrMJVYVfKf2PJy9NZWsWC89S2qMTrE57sR8Q1',
          instructions: [],
        }).compileToV0Message()
      );

      // Before signing, signature is all zeros
      expect(tx.signatures[0].every((b) => b === 0)).toBe(true);

      const signedTx = await signer.signTransaction(tx);
      expect(signedTx.signatures[0].length).toBe(64);
      expect(signedTx.signatures[0].every((b) => b === 0)).toBe(false);

      // Verify transaction signature against message serialization
      const serializedMessage = signedTx.message.serialize();
      const isValid = verifyEd25519Signature(
        serializedMessage,
        signedTx.signatures[0],
        payer.toBytes()
      );
      expect(isValid).toBe(true);
    });
  });

  // =========================================================================
  // 5. AuthManager Operator Secrets & Zero Disk Exposure
  // =========================================================================
  describe('AuthManager Operator Secrets & Zero Disk Exposure', () => {
    it('SKI-16: AuthManager generates high-entropy volatile token with zero disk persistence', () => {
      const auth = new AuthManager();
      const primaryToken = auth.getPrimaryToken();

      expect(typeof primaryToken).toBe('string');
      expect(primaryToken.length).toBe(64); // 32 bytes hex encoded = 64 characters

      // Invariant: Zero credential persistence to disk
      const legacyPath = path.join(process.cwd(), '.operator_session');
      expect(fs.existsSync(legacyPath)).toBe(false);

      // Token validates correctly
      expect(auth.validateToken(primaryToken)).toBe(true);
    });

    it('SKI-17: token rotation revokes old token and generates new active volatile token', () => {
      const auth = new AuthManager();
      const token1 = auth.getPrimaryToken();
      expect(auth.validateToken(token1)).toBe(true);

      const token2 = auth.rotateOperatorToken();
      expect(token2).not.toBe(token1);
      expect(token2.length).toBe(64);

      // Old token is immediately revoked
      expect(auth.validateToken(token1)).toBe(false);
      // New token is immediately active
      expect(auth.validateToken(token2)).toBe(true);
    });

    it('SKI-18: strictly rejects invalid, empty, or whitespace tokens', () => {
      const auth = new AuthManager();
      expect(auth.validateToken(null)).toBe(false);
      expect(auth.validateToken(undefined)).toBe(false);
      expect(auth.validateToken('')).toBe(false);
      expect(auth.validateToken('   ')).toBe(false);
      expect(auth.validateToken('invalid_token_attempt_12345')).toBe(false);
    });
  });
});
