import { existsSync, readFileSync } from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export let SOLANA_KEYPAIR_FILE_PATH = "/data/.secrets/solana_keypair.json";

// Test-support only: overrides the key file path for unit tests. Not for runtime use.
export function setKeypairFilePath(path: string): void {
  SOLANA_KEYPAIR_FILE_PATH = path;
}

export function getSolanaConnection(): Connection {
  const heliusRpcUrl = process.env.HELIUS_RPC_URL?.trim();
  if (!heliusRpcUrl) throw new Error("HELIUS_RPC_URL environment variable is not set");
  return new Connection(heliusRpcUrl, "confirmed");
}

export function getSolanaPublicKey(): PublicKey {
  return loadSolanaKeypair().publicKey;
}

export function loadSolanaKeypair(): Keypair {
  let rawKey: string | undefined;

  if (existsSync(SOLANA_KEYPAIR_FILE_PATH)) {
    rawKey = readFileSync(SOLANA_KEYPAIR_FILE_PATH, "utf8").trim();
  }

  if (!rawKey) {
    const envKey = process.env.SOLANA_PRIVATE_KEY?.trim();
    if (envKey) {
      rawKey = envKey;
    }
  }

  if (!rawKey) {
    throw new Error(
      `Solana private key not found. ` +
        `Checked: file at "${SOLANA_KEYPAIR_FILE_PATH}" and SOLANA_PRIVATE_KEY environment variable.`
    );
  }

  try {
    const secretKeyBytes = bs58.decode(rawKey);
    return Keypair.fromSecretKey(secretKeyBytes);
  } catch {
    throw new Error(
      `Failed to load Solana keypair: key material could not be decoded or is invalid. ` +
        `Check the format of the key in "${SOLANA_KEYPAIR_FILE_PATH}" or SOLANA_PRIVATE_KEY.`
    );
  }
}
