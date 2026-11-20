/**
 * RPC configuration (read from the environment at call time):
 *
 * - SOLANA_RPC_URL: the Solana RPC endpoint. Takes precedence when set and non-empty.
 * - HELIUS_RPC_URL: legacy fallback, used only when SOLANA_RPC_URL is unset or blank.
 *
 * Keypair configuration (read from the environment at call time):
 *
 * - SOLANA_KEYPAIR_PATH: path to a file containing the keypair. If set and non-empty it
 *   takes precedence; a missing or unreadable file is an error (no fallback to the env key).
 * - SOLANA_PRIVATE_KEY: the keypair inline. Used only when SOLANA_KEYPAIR_PATH is not set.
 *
 * Accepted formats for both sources (surrounding whitespace is ignored):
 * - a JSON array of exactly 64 integers 0-255 (Solana CLI id.json format), or
 * - a base58 string that decodes to 64 bytes.
 *
 * Key material and file contents are never included in error messages.
 */
import { readFileSync } from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export function getRpcUrl(): string {
  const primary = process.env.SOLANA_RPC_URL?.trim();
  if (primary) return primary;
  const legacy = process.env.HELIUS_RPC_URL?.trim();
  if (legacy) return legacy;
  throw new Error("No Solana RPC URL configured. Set SOLANA_RPC_URL (HELIUS_RPC_URL is also accepted).");
}

export function getSolanaConnection(): Connection {
  return new Connection(getRpcUrl(), "confirmed");
}

export function getSolanaPublicKey(): PublicKey {
  return loadSolanaKeypair().publicKey;
}

function parseSecretKey(raw: string, source: string): Keypair {
  try {
    const text = raw.trim();
    let bytes: Uint8Array;
    if (text.startsWith("[")) {
      const parsed: unknown = JSON.parse(text);
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 64 ||
        !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
      ) {
        throw new Error("bad array");
      }
      bytes = Uint8Array.from(parsed as number[]);
    } else {
      bytes = bs58.decode(text);
      if (bytes.length !== 64) throw new Error("bad length");
    }
    return Keypair.fromSecretKey(bytes);
  } catch {
    // Deliberately no detail from the underlying error: it could echo key material.
    throw new Error(
      `Invalid Solana keypair from ${source}: expected a base58 secret key or a JSON array of 64 numbers.`
    );
  }
}

export function loadSolanaKeypair(): Keypair {
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH?.trim();
  if (keypairPath) {
    let contents: string;
    try {
      contents = readFileSync(keypairPath, "utf8");
    } catch (e) {
      const reason = (e as NodeJS.ErrnoException)?.code ?? "unreadable";
      throw new Error(`Could not read the keypair file at SOLANA_KEYPAIR_PATH ("${keypairPath}"): ${reason}.`);
    }
    return parseSecretKey(contents, "SOLANA_KEYPAIR_PATH file");
  }

  const envKey = process.env.SOLANA_PRIVATE_KEY?.trim();
  if (envKey) return parseSecretKey(envKey, "SOLANA_PRIVATE_KEY");

  throw new Error(
    "No Solana keypair configured. Set SOLANA_PRIVATE_KEY (base58 or JSON array) or SOLANA_KEYPAIR_PATH (path to a keypair file)."
  );
}
