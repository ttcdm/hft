#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { parseSecretKey } from '../server/solana/parseSecretKey';
import { Keypair } from '@solana/web3.js';

function printUsage() {
  console.log('Usage: npm run signer:import -- <path-to-keypair.json> [--force]');
  console.log('Imports a local Solana keypair file into .apex_trading_keypair.json with 0600 permissions.');
  console.log('The key material never touches HTTP, WebSocket, or browser layers.');
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith('--'));
  const force = args.includes('--force') || args.includes('-f');

  if (!inputPath) {
    printUsage();
    process.exit(1);
  }

  const resolvedInput = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`[ERROR] Input keypair file not found at: ${resolvedInput}`);
    process.exit(1);
  }

  const targetPath = process.env.SIGNER_KEYPAIR_PATH || path.join(process.cwd(), '.apex_trading_keypair.json');

  if (fs.existsSync(targetPath) && !force) {
    console.error(`[ERROR] Target keypair already exists at: ${targetPath}`);
    console.error('Use --force flag if you intend to overwrite the existing keypair.');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(resolvedInput, 'utf8').trim();
    const secretKeyBytes = parseSecretKey(raw);

    if (secretKeyBytes.length !== 64) {
      throw new Error(`Invalid secret key length: expected 64 bytes, got ${secretKeyBytes.length}`);
    }

    const keypair = Keypair.fromSecretKey(secretKeyBytes);
    const secretArray = Array.from(keypair.secretKey);

    fs.writeFileSync(targetPath, JSON.stringify(secretArray), { mode: 0o600 });

    console.log('[SUCCESS] Solana trading keypair imported securely.');
    console.log(`  Public Key:   ${keypair.publicKey.toBase58()}`);
    console.log(`  Target Path:  ${targetPath}`);
    console.log(`  Permissions:  0600 (Owner read/write only)`);
    console.log('  Status:       Ready for local signing without network exposure.');
  } catch (err: any) {
    console.error(`[ERROR] Failed to import keypair: ${err.message}`);
    process.exit(1);
  }
}

main();
