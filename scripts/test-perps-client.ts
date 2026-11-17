import { getPerpsProgram, JLP_POOL_ACCOUNT_PUBKEY, fetchAllPositionsForWallet } from "../dist/client/perps.js";
import { PublicKey } from "@solana/web3.js";

async function main() {
  console.log("1. Initializing Anchor program...");
  const program = getPerpsProgram();
  console.log("   Program ID:", program.programId.toBase58());

  console.log("2. Fetching JLP pool account...");
  const pool = await program.account.pool.fetch(JLP_POOL_ACCOUNT_PUBKEY);
  console.log("   JLP pool AUM (raw):", pool.aumUsd?.toString() ?? pool.aum?.toString() ?? "(field name differs — log full pool keys)");
  if (!pool.aumUsd && !pool.aum) {
    console.log("   Pool account keys:", Object.keys(pool));
  }

  console.log("3. Fetching positions for dummy wallet...");
  const dummy = new PublicKey("11111111111111111111111111111111");
  const positions = await fetchAllPositionsForWallet(dummy);
  console.log("   Positions found:", positions.length);

  console.log("Self-test passed.");
}

main().catch((err) => {
  console.error("Self-test FAILED:", err);
  process.exit(1);
});