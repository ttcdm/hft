/**
 * CreatorRiskScorer - Alpha Pipeline Integration (B14)
 *
 * Inspects creator transaction history using Solana RPC connection.getSignaturesForAddress.
 * Detects burner wallets:
 *   - First transaction funded < 1 hour prior
 *   - Low signature count
 *   - Rapid deploy-and-drain patterns
 *
 * Computes creator risk score:
 *   - Established / seasoned wallet = High score (up to 100, 5/5 confluence)
 *   - Fresh burner wallet = Low / zero score (0/5 confluence, risk flag)
 */

import { Connection, PublicKey } from '@solana/web3.js';

export interface ConfirmedSignatureInfo {
  signature: string;
  slot: number;
  err: any | null;
  memo: string | null;
  blockTime?: number | null;
}

export interface SolanaRpcSignaturesProvider {
  getSignaturesForAddress(
    address: PublicKey,
    options?: { limit?: number; before?: string; until?: string }
  ): Promise<ConfirmedSignatureInfo[]>;
}

export interface CreatorRiskReport {
  creatorAddress: string;
  riskScore: number;         // 0 to 100 (100 = established / safe, 0 = burner / rug risk)
  confluenceScore: number;   // 0 to 5 (scaled factor for ConfluenceEngine)
  isBurner: boolean;         // True if fresh burner or deploy-drain pattern detected
  isFreshWallet: boolean;    // First tx funded < 1 hour prior
  signatureCount: number;    // Number of signatures inspected
  walletAgeSeconds: number;  // Age in seconds from first tx to now
  hasDrainPattern: boolean;  // Rapid deploy-and-drain pattern detected
  failedTxCount: number;     // Number of failed transactions in history
  riskFlags: string[];
  evaluatedAt: number;
  details: string;
}

export class CreatorRiskScorer {
  private cache: Map<string, { report: CreatorRiskReport; expiresAt: number }> = new Map();
  private readonly defaultCacheTtlMs = 120_000; // 2 minutes cache for HFT speed

  /**
   * Inspect creator transaction history via RPC connection.getSignaturesForAddress
   */
  public async evaluateCreator(
    connection: Connection | SolanaRpcSignaturesProvider | any,
    creatorPubkey: PublicKey | string,
    options?: { limit?: number; bypassCache?: boolean; nowSec?: number }
  ): Promise<CreatorRiskReport> {
    const creatorAddress = typeof creatorPubkey === 'string' ? creatorPubkey.trim() : creatorPubkey.toBase58();
    const nowSec = options?.nowSec ?? Math.floor(Date.now() / 1000);
    const limit = options?.limit ?? 50;

    // Check cache
    if (!options?.bypassCache) {
      const cached = this.cache.get(creatorAddress);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.report;
      }
    }

    try {
      const pubkey = typeof creatorPubkey === 'string' ? new PublicKey(creatorAddress) : creatorPubkey;
      let signatures: ConfirmedSignatureInfo[] = [];

      if (typeof connection?.getSignaturesForAddress === 'function') {
        signatures = await connection.getSignaturesForAddress(pubkey, { limit });
      }

      const report = this.evaluateSignatures(creatorAddress, signatures, nowSec);
      this.cache.set(creatorAddress, {
        report,
        expiresAt: Date.now() + this.defaultCacheTtlMs,
      });

      return report;
    } catch (err: any) {
      // On RPC error, return conservative report
      const fallbackReport: CreatorRiskReport = {
        creatorAddress,
        riskScore: 30,
        confluenceScore: 1,
        isBurner: true,
        isFreshWallet: false,
        signatureCount: 0,
        walletAgeSeconds: 0,
        hasDrainPattern: false,
        failedTxCount: 0,
        riskFlags: ['RPC_HISTORY_QUERY_FAILED'],
        evaluatedAt: Date.now(),
        details: `RPC error querying creator history: ${err?.message || err}`,
      };
      return fallbackReport;
    }
  }

  /**
   * Deterministic signature inspection logic
   */
  public evaluateSignatures(
    creatorAddress: string,
    signatures: ConfirmedSignatureInfo[],
    nowSec: number = Math.floor(Date.now() / 1000)
  ): CreatorRiskReport {
    const riskFlags: string[] = [];
    const signatureCount = signatures.length;

    // Edge case: zero transaction history
    if (signatureCount === 0) {
      riskFlags.push('NO_TRANSACTION_HISTORY', 'FRESH_BURNER_WALLET');
      return {
        creatorAddress,
        riskScore: 0,
        confluenceScore: 0,
        isBurner: true,
        isFreshWallet: true,
        signatureCount: 0,
        walletAgeSeconds: 0,
        hasDrainPattern: true,
        failedTxCount: 0,
        riskFlags,
        evaluatedAt: Date.now(),
        details: 'Zero transaction history found on-chain. Highest burner risk.',
      };
    }

    // Signatures from getSignaturesForAddress are ordered newest to oldest
    const newest = signatures[0];
    const oldest = signatures[signatures.length - 1];

    const oldestTime = oldest.blockTime ?? newest.blockTime ?? nowSec;
    const newestTime = newest.blockTime ?? nowSec;

    const walletAgeSeconds = Math.max(0, nowSec - oldestTime);
    const activeSpanSeconds = Math.max(0, newestTime - oldestTime);

    // 1. Detect fresh burner wallet: funded < 1 hour prior (3600 seconds)
    const isFreshWallet = walletAgeSeconds < 3600;
    if (isFreshWallet) {
      riskFlags.push('FRESH_BURNER_WALLET');
    }

    // 2. Low signature count check
    if (signatureCount <= 2) {
      riskFlags.push('EXTREME_LOW_SIGNATURES');
    } else if (signatureCount <= 5) {
      riskFlags.push('LOW_SIGNATURE_COUNT');
    }

    // 3. Rapid deploy-and-drain pattern:
    // Low signature count with very short active lifespan (< 15 minutes) or rapid bursts
    const hasDrainPattern =
      signatureCount <= 6 &&
      (walletAgeSeconds < 1800 || (activeSpanSeconds < 600 && walletAgeSeconds < 7200));

    if (hasDrainPattern) {
      riskFlags.push('RAPID_DEPLOY_AND_DRAIN');
    }

    // 4. Failed transactions check
    const failedTxCount = signatures.filter((s) => s.err !== null).length;
    const failureRate = failedTxCount / signatureCount;
    if (failureRate >= 0.4 && signatureCount >= 4) {
      riskFlags.push('HIGH_FAILURE_RATE');
    }

    const isBurner = isFreshWallet || signatureCount <= 2 || hasDrainPattern;

    // 5. Score calculation (0 - 100)
    // - Age Points (up to 40)
    let agePoints: number;
    if (walletAgeSeconds >= 86400 * 30) {
      agePoints = 40; // > 30 days
    } else if (walletAgeSeconds >= 86400 * 7) {
      agePoints = 35; // > 7 days
    } else if (walletAgeSeconds >= 86400 * 1) {
      agePoints = 25; // > 1 day
    } else if (walletAgeSeconds >= 21600) {
      agePoints = 15; // > 6 hours
    } else if (walletAgeSeconds >= 3600) {
      agePoints = 8;  // > 1 hour
    } else {
      agePoints = 0;  // < 1 hour (fresh)
    }

    // - Signature Volume Points (up to 40)
    let volumePoints: number;
    if (signatureCount >= 50) {
      volumePoints = 40;
    } else if (signatureCount >= 25) {
      volumePoints = 30;
    } else if (signatureCount >= 10) {
      volumePoints = 20;
    } else if (signatureCount >= 6) {
      volumePoints = 10;
    } else if (signatureCount >= 3) {
      volumePoints = 5;
    } else {
      volumePoints = 0;
    }

    // - Reliability & History Points (up to 20)
    let reliabilityPoints: number;
    if (failureRate < 0.1) {
      reliabilityPoints = 20;
    } else if (failureRate < 0.3) {
      reliabilityPoints = 10;
    } else {
      reliabilityPoints = 0;
    }

    let rawScore = agePoints + volumePoints + reliabilityPoints;

    // Penalties and Hard Caps
    if (isBurner) {
      rawScore = Math.min(rawScore, 15);
      if (signatureCount <= 2 || walletAgeSeconds < 600) {
        rawScore = 0;
      }
    }

    if (hasDrainPattern) {
      rawScore = Math.min(rawScore, 10);
    }

    const riskScore = Math.min(100, Math.max(0, rawScore));

    // Convert to ConfluenceEngine creator factor score (0 - 5)
    let confluenceScore: number;
    if (isBurner || riskScore < 20) {
      confluenceScore = 0;
    } else if (riskScore >= 80) {
      confluenceScore = 5;
    } else if (riskScore >= 60) {
      confluenceScore = 4;
    } else if (riskScore >= 40) {
      confluenceScore = 3;
    } else if (riskScore >= 20) {
      confluenceScore = 2;
    } else {
      confluenceScore = 1;
    }

    const ageStr =
      walletAgeSeconds > 86400
        ? `${(walletAgeSeconds / 86400).toFixed(1)} days`
        : walletAgeSeconds > 3600
        ? `${(walletAgeSeconds / 3600).toFixed(1)} hours`
        : `${Math.floor(walletAgeSeconds / 60)} minutes`;

    const details = isBurner
      ? `🚨 Fresh burner wallet detected (${signatureCount} txs, age: ${ageStr}). Risk flags: ${riskFlags.join(', ')}`
      : `Established creator wallet (${signatureCount} txs, age: ${ageStr}). Confluence factor: ${confluenceScore}/5.`;

    return {
      creatorAddress,
      riskScore,
      confluenceScore,
      isBurner,
      isFreshWallet,
      signatureCount,
      walletAgeSeconds,
      hasDrainPattern,
      failedTxCount,
      riskFlags,
      evaluatedAt: Date.now(),
      details,
    };
  }

  /**
   * Helper to evaluate creator risk score directly from parametric overrides
   */
  public static evaluateFromParams(params: {
    walletAgeSeconds?: number;
    signatureCount?: number;
    hasDrainPattern?: boolean;
    isBurner?: boolean;
    failedTxCount?: number;
  }): { riskScore: number; confluenceScore: number; isBurner: boolean } {
    const walletAge = params.walletAgeSeconds ?? 0;
    const count = params.signatureCount ?? 0;
    const isFresh = walletAge < 3600;
    const isBurner = params.isBurner ?? (isFresh || count <= 2 || !!params.hasDrainPattern);

    if (isBurner || count <= 2) {
      return { riskScore: 0, confluenceScore: 0, isBurner: true };
    }

    let agePoints = 0;
    if (walletAge >= 86400 * 30) agePoints = 40;
    else if (walletAge >= 86400 * 7) agePoints = 35;
    else if (walletAge >= 86400) agePoints = 25;
    else if (walletAge >= 21600) agePoints = 15;
    else if (walletAge >= 3600) agePoints = 8;

    let volumePoints = 0;
    if (count >= 50) volumePoints = 40;
    else if (count >= 25) volumePoints = 30;
    else if (count >= 10) volumePoints = 20;
    else if (count >= 6) volumePoints = 10;
    else if (count >= 3) volumePoints = 5;

    const riskScore = Math.min(100, Math.max(0, agePoints + volumePoints + 15));
    let confluenceScore: number;
    if (riskScore >= 80) confluenceScore = 5;
    else if (riskScore >= 60) confluenceScore = 4;
    else if (riskScore >= 40) confluenceScore = 3;
    else if (riskScore >= 20) confluenceScore = 2;
    else confluenceScore = 1;

    return { riskScore, confluenceScore, isBurner: false };
  }

  public clearCache(): void {
    this.cache.clear();
  }
}

export const creatorRiskScorer = new CreatorRiskScorer();
