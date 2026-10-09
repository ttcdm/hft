import './hermeticEnv'; // must stay the first import: no .env is loaded, the signer must be a throwaway key given explicitly
import '../server/loadEnv';
import fs from 'fs';
import path from 'path';

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { localSigner } from '../server/solana/signer';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

async function runDevnetVerification() {
  console.log('================================================================');
  console.log('🧪 APEX WORKSTATION — DEVNET ON-CHAIN EXECUTION VERIFICATION');
  console.log('================================================================');

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const keyPath = process.env.SIGNER_KEYPAIR_PATH;
  if (!keyPath || path.resolve(keyPath) === path.resolve('.apex_trading_keypair.json') || !fs.existsSync(keyPath)) {
    throw new Error('Set SIGNER_KEYPAIR_PATH to a throwaway devnet keypair file (not the repo keypair). This script never reads .env.');
  }

  // The RPC URL can carry a provider token, so no part of it is printed.
  console.log('[1/6] Connecting to the configured RPC endpoint (not printed)');
  const connection = new Connection(rpcUrl, 'confirmed');

  // Hard safety invariant: Verify genesis hash to guarantee we NEVER execute on Mainnet
  const genesisHash = await connection.getGenesisHash();
  console.log(`[2/6] Cluster Genesis Hash: ${genesisHash}`);

  if (genesisHash === MAINNET_GENESIS_HASH) {
    console.error('⛔ FATAL: Connected cluster is MAINNET-BETA! Aborting immediately.');
    process.exit(1);
  }

  if (genesisHash !== DEVNET_GENESIS_HASH) {
    console.error(`⛔ FATAL: genesis hash ${genesisHash} is not devnet. This script runs on devnet only.`);
    process.exit(1);
  }
  console.log('✅ SAFETY VERIFIED: Cluster is SOLANA DEVNET.');

  // Verify Signer
  const signerStatus = localSigner.getStatus();
  if (signerStatus !== 'READY') {
    throw new Error(`Local signer is not ready: status is ${signerStatus}`);
  }
  const walletPubkey = localSigner.getPublicKey();
  console.log(`[3/6] Signer Status: READY`);
  console.log(`      Wallet Public Key: ${walletPubkey.toBase58()}`);

  // Check Devnet Balance
  const lamports = await connection.getBalance(walletPubkey, 'confirmed');
  const solBalance = lamports / 1e9;
  console.log(`[4/6] Devnet SOL Balance: ${solBalance} SOL (${lamports} lamports)`);

  if (lamports < 1000000) {
    throw new Error(`Insufficient Devnet balance (${solBalance} SOL). Please airdrop Devnet SOL.`);
  }

  // Construct a clean, real Devnet transaction:
  // Transfer 0.0001 Devnet SOL back to self + compute budget priority micro-fee
  console.log(`[5/6] Building and signing real on-chain Devnet transaction...`);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  console.log(`      Latest Blockhash: ${blockhash.slice(0, 16)}... (valid to height ${lastValidBlockHeight})`);

  const testAmountLamports = 100000n; // 0.0001 Devnet SOL
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 10000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    SystemProgram.transfer({
      fromPubkey: walletPubkey,
      toPubkey: walletPubkey, // Send to self
      lamports: testAmountLamports,
    }),
  ];

  const messageV0 = new TransactionMessage({
    payerKey: walletPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(messageV0);
  const signedTx = await localSigner.signTransaction(versionedTx);
  console.log(`      Transaction signed locally with Ed25519 keypair.`);

  // Simulate first
  const sim = await connection.simulateTransaction(signedTx);
  if (sim.value.err) {
    throw new Error(`Devnet simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`      Devnet pre-broadcast simulation PASSED (Units consumed: ${sim.value.unitsConsumed}).`);

  // Broadcast to QuickNode Devnet
  console.log(`[6/6] Broadcasting transaction to QuickNode Devnet...`);
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  console.log(`      Transaction Broadcast Signature: ${signature}`);

  console.log(`      Awaiting on-chain confirmation...`);
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      blockhash,
      lastValidBlockHeight,
    },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  const postLamports = await connection.getBalance(walletPubkey, 'confirmed');
  const postSolBalance = postLamports / 1e9;
  const networkFeePaidSol = (lamports - postLamports) / 1e9;

  console.log('================================================================');
  console.log('🎉 DEVNET ON-CHAIN TEST TRANSACTION CONFIRMED SUCCESSFULLY!');
  console.log('================================================================');
  console.log(`• Status: CONFIRMED`);
  console.log(`• Network Fee Paid: ${networkFeePaidSol} Devnet SOL`);
  console.log(`• Remaining Balance: ${postSolBalance} Devnet SOL`);
  console.log(`• Devnet Solscan Explorer:`);
  console.log(`  https://solscan.io/tx/${signature}?cluster=devnet`);
  console.log(`• SolanaFM Devnet Explorer:`);
  console.log(`  https://solana.fm/tx/${signature}?cluster=devnet-solana`);
  console.log('================================================================');
}

runDevnetVerification().catch((err) => {
  console.error('❌ Devnet Test Failed:', err.message);
  process.exit(1);
});
