import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  buildIncreasePositionIx,
  buildDecreasePositionIx,
} from "../dist/client/perps.js";

async function main() {
  const wallet = new PublicKey("2g1mcizzurwCBrHmnxFN2KsCzJCSAEi2TVteBxo2uwnx");

  console.log("1. Building increase position instruction (SOL long)...");
  const increaseIx = await buildIncreasePositionIx({
    walletPublicKey: wallet,
    asset: "SOL",
    side: "long",
    sizeUsdDelta: new BN(10_000_000),
    collateralTokenDelta: new BN(100_000_000),
    priceSlippage: new BN(500),
    counter: new BN(42),
  });
  console.log("   keys.length:", increaseIx.keys.length);
  console.log("   data.length:", increaseIx.data.length);

  console.log("2. Building decrease position instruction (SOL long, full close)...");
  const decreaseIx = await buildDecreasePositionIx({
    walletPublicKey: wallet,
    asset: "SOL",
    side: "long",
    sizeUsdDelta: new BN(0),
    collateralUsdDelta: new BN(0),
    priceSlippage: new BN(500),
    entirePosition: true,
    counter: new BN(43),
  });
  console.log("   keys.length:", decreaseIx.keys.length);
  console.log("   data.length:", decreaseIx.data.length);

  console.log("Instruction builder self-test passed.");
}

main().catch((err) => {
  console.error("Self-test FAILED:", err);
  process.exit(1);
});