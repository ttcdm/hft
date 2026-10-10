import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { parseSecretKey } from './parseSecretKey';
import crypto from 'crypto';
import { SignerStatus } from '../core/types';
import { Logger } from '../middleware/enterprise';

export interface TransactionSigner {
  getPublicKey(): PublicKey;
  getStatus(): SignerStatus;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

// Ed25519 PKCS#8 DER header (16 bytes)
// RFC 8410: id-Ed25519 is 1.3.101.112 -> 06 03 2B 65 70
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class LocalKeypairSigner implements TransactionSigner {
  private keypair: Keypair | null = null;
  private status: SignerStatus = 'NOT_CONFIGURED';
  private keypairPath: string = '';
  private nodePrivateKey: crypto.KeyObject | null = null;

  constructor() {
    this.initializeSigner();
  }

  private initializeSigner() {
    const envPrivateKey = process.env.OPERATOR_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY;
    if (envPrivateKey) {
      try {
        const raw = envPrivateKey.trim();
        const secretKeyBytes = parseSecretKey(raw);
        if (secretKeyBytes.length === 64) {
          this.setKeypair(Keypair.fromSecretKey(secretKeyBytes));
          Logger.info(`Local hot signer loaded securely from environment: ${this.keypair!.publicKey.toBase58().slice(0, 4)}...${this.keypair!.publicKey.toBase58().slice(-4)}`);
          return;
        } else {
          Logger.warn(`Invalid environment private key byte length (${secretKeyBytes.length}). Expected 64.`);
        }
      } catch (err: any) {
        Logger.error(`Failed to load keypair from OPERATOR_PRIVATE_KEY: ${err.message}`);
      }
    }

    const envPath = process.env.SIGNER_KEYPAIR_PATH;
    const defaultPath = path.join(process.cwd(), '.apex_trading_keypair.json');
    const targetPath = envPath || defaultPath;
    this.keypairPath = targetPath;

    try {
      if (fs.existsSync(targetPath)) {
        const raw = fs.readFileSync(targetPath, 'utf8').trim();
        const secretKeyBytes = parseSecretKey(raw);

        if (secretKeyBytes.length === 64) {
          this.setKeypair(Keypair.fromSecretKey(secretKeyBytes));
          Logger.info(`Local hot signer loaded securely: ${this.keypair!.publicKey.toBase58().slice(0, 4)}...${this.keypair!.publicKey.toBase58().slice(-4)}`);
        } else {
          Logger.warn(`Invalid secret key length at ${targetPath}. Expected 64 bytes, got ${secretKeyBytes.length}. Signer locked.`);
          this.status = 'LOCKED';
        }
      } else {
        this.status = 'NOT_CONFIGURED';
      }
    } catch (err: any) {
      Logger.error(`Failed to load keypair from ${targetPath}: ${err.message}`);
      this.status = 'LOCKED';
    }
  }

  private setKeypair(kp: Keypair) {
    this.keypair = kp;
    this.status = 'READY';

    // Derive Node crypto.KeyObject for Ed25519 message signing
    try {
      const seed = Buffer.from(kp.secretKey.slice(0, 32));
      const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
      this.nodePrivateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch (err: any) {
      Logger.error(`Failed to construct Ed25519 crypto KeyObject: ${err.message}`);
      this.nodePrivateKey = null;
    }
  }

  public hasExistingFile(): boolean {
    const targetPath = this.keypairPath || path.join(process.cwd(), '.apex_trading_keypair.json');
    return fs.existsSync(targetPath);
  }

  // Generates a dedicated local low-balance trading keypair file with restricted permissions (0600)
  // Protected against accidental overwriting of existing keypairs with funds
  public generateDedicatedTradingKeypair(forceOverwrite = false): { publicKey: string; path: string } {
    const targetPath = this.keypairPath || path.join(process.cwd(), '.apex_trading_keypair.json');

    if (fs.existsSync(targetPath) && !forceOverwrite) {
      throw new Error(
        `A keypair file already exists at ${targetPath}. Explicit forceOverwrite: true confirmation required to prevent permanent loss of funds.`
      );
    }

    const newKeypair = Keypair.generate();
    const secretArray = Array.from(newKeypair.secretKey);

    fs.writeFileSync(targetPath, JSON.stringify(secretArray), { mode: 0o600 });
    this.setKeypair(newKeypair);

    Logger.info(`Generated new dedicated trading keypair: ${newKeypair.publicKey.toBase58()} at ${targetPath} (mode 0600)`);
    return {
      publicKey: newKeypair.publicKey.toBase58(),
      path: targetPath,
    };
  }

  public importKeypair(secretKeyInput: string, forceOverwrite = false): { publicKey: string; path: string } {
    const targetPath = this.keypairPath || path.join(process.cwd(), '.apex_trading_keypair.json');

    if (fs.existsSync(targetPath) && !forceOverwrite) {
      throw new Error(
        `A keypair file already exists at ${targetPath}. Explicit forceOverwrite: true required.`
      );
    }

    const secretKeyBytes = parseSecretKey(secretKeyInput);

    if (secretKeyBytes.length !== 64) {
      throw new Error(`Invalid secret key length. Expected 64 bytes, got ${secretKeyBytes.length}.`);
    }

    const kp = Keypair.fromSecretKey(secretKeyBytes);
    fs.writeFileSync(targetPath, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    this.setKeypair(kp);

    Logger.info(`Successfully imported keypair: ${kp.publicKey.toBase58()} (mode 0600)`);
    return {
      publicKey: kp.publicKey.toBase58(),
      path: targetPath,
    };
  }

  public exportKeypairSafely(confirmationCode: string): { secretKeyBase58: string } {
    if (confirmationCode !== 'CONFIRM_EXPORT_PRIVATE_KEY') {
      throw new Error('Invalid export confirmation code. Export rejected.');
    }
    if (!this.keypair) {
      throw new Error('No keypair configured to export.');
    }
    return {
      secretKeyBase58: bs58.encode(this.keypair.secretKey),
    };
  }

  public generateNewKeypair(forceOverwrite = false): string {
    return this.generateDedicatedTradingKeypair(forceOverwrite).publicKey;
  }

  public importSecretKey(secretKeyInput: string, forceOverwrite = false): string {
    return this.importKeypair(secretKeyInput, forceOverwrite).publicKey;
  }

  public exportKeypair(): Keypair | null {
    return this.keypair;
  }

  public getPublicKey(): PublicKey {
    if (!this.keypair) {
      throw new Error('Signer not configured or locked. Cannot retrieve public key.');
    }
    return this.keypair.publicKey;
  }

  public getStatus(): SignerStatus {
    return this.status;
  }

  public async signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction> {
    if (!this.keypair || this.status !== 'READY') {
      throw new Error('Local signer is not ready to sign transactions');
    }
    transaction.sign([this.keypair]);
    return transaction;
  }

  public async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.keypair || this.status !== 'READY' || !this.nodePrivateKey) {
      throw new Error('Local signer is not ready to sign messages');
    }
    // Real Ed25519 cryptographic message signature via Node crypto.sign
    const sig = crypto.sign(null, Buffer.from(message), this.nodePrivateKey);
    return new Uint8Array(sig);
  }
}

export const localSigner = new LocalKeypairSigner();
