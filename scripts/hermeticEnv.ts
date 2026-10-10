/**
 * Import this FIRST in any script that signs or spawns the server. It names an empty env file, so `server/loadEnv` loads no
 * `.env` at all: a script can never pick up the real wallet key, RPC URL or API keys by accident. Pass what the script needs
 * (a throwaway key path, an RPC URL) through the process environment instead.
 */
if (process.env.APEX_ENV_FILE === undefined) process.env.APEX_ENV_FILE = '';
// T9/T10: an exported private key beats SIGNER_KEYPAIR_PATH in the signer, so a script that believes it signs with its throwaway
// keypair could sign with the shell's key. A script gets its key from SIGNER_KEYPAIR_PATH only.
delete process.env.OPERATOR_PRIVATE_KEY;
delete process.env.SOLANA_PRIVATE_KEY;
