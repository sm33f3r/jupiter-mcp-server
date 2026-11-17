import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { loadSolanaKeypair } from "../client/solana.js";
import {
  fetchAllPositionsForWallet,
  fetchPosition,
  fetchPositionRequest,
  CUSTODY_ADDRESSES,
  getCustodyAccounts,
  derivePositionPda,
  derivePositionRequestPda,
  buildIncreasePositionIx,
  buildDecreasePositionIx,
  buildCancelPositionRequestIx,
} from "../client/perps.js";
import { jupiterFetch } from "../client/jupiter.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";

const SCALE = 1_000_000;
// Maintenance margin rate (0.1% of position size) used to approximate liquidation price
const MAINTENANCE_MARGIN_RATE = 0.001;

const CUSTODY_TO_SYMBOL: Record<string, string> = {
  [CUSTODY_ADDRESSES.SOL.toString()]: "SOL",
  [CUSTODY_ADDRESSES.ETH.toString()]: "ETH",
  [CUSTODY_ADDRESSES.BTC.toString()]: "BTC",
};

const CUSTODY_TO_MINT: Record<string, string> = {
  [CUSTODY_ADDRESSES.SOL.toString()]: "So11111111111111111111111111111111111111112",
  [CUSTODY_ADDRESSES.ETH.toString()]: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  [CUSTODY_ADDRESSES.BTC.toString()]: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
};

function bnToUsd(bn: BN): number {
  return bn.toNumber() / SCALE;
}

function calcPnl(
  currentPrice: number,
  entryPrice: number,
  sizeUsd: number,
  isLong: boolean
): number {
  if (isLong) {
    return ((currentPrice - entryPrice) / entryPrice) * sizeUsd;
  }
  return ((entryPrice - currentPrice) / entryPrice) * sizeUsd;
}

// Liquidation price: derived from get-liquidation-price.ts reference logic.
// Position is liquidated when losses consume collateral minus the maintenance margin buffer.
// For longs:  liqPrice = entryPrice × (1 − collateral/size + maintenanceMargin)
// For shorts: liqPrice = entryPrice × (1 + collateral/size − maintenanceMargin)
function calcLiquidationPrice(
  entryPrice: number,
  sizeUsd: number,
  collateralUsd: number,
  isLong: boolean
): number {
  const collateralRatio = collateralUsd / sizeUsd;
  if (isLong) {
    return entryPrice * (1 - collateralRatio + MAINTENANCE_MARGIN_RATE);
  }
  return entryPrice * (1 + collateralRatio - MAINTENANCE_MARGIN_RATE);
}

// Returns the worst acceptable execution price scaled to 6 decimals (USDC_DECIMALS).
// isBuying=true when the trade acquires the asset (open long, close short).
// isBuying=false when the trade sells the asset (open short, close long).
function calcAcceptablePrice(
  currentPrice: number,
  slippageBps: number,
  isBuying: boolean
): BN {
  const factor = isBuying
    ? 1 + slippageBps / 10000
    : 1 - slippageBps / 10000;
  const acceptablePrice = currentPrice * factor;
  return new BN(Math.round(acceptablePrice * SCALE));
}

async function executeOpenPosition(params: {
  asset: "SOL" | "ETH" | "BTC";
  side: "long" | "short";
  sizeUsd: number;
  collateralAmount: string;
  priceSlippage?: number;
}): Promise<{
  positionPda: PublicKey;
  positionRequestPda: PublicKey;
  txSignature: string;
}> {
  const { asset, side, sizeUsd, collateralAmount, priceSlippage } = params;
  const slippage = priceSlippage ?? 500;
  const keypair = loadSolanaKeypair();
  const counter = new BN(Math.floor(Math.random() * 1_000_000));

  const { custody, collateralCustody } = getCustodyAccounts(asset, side);
  const positionPda = derivePositionPda(
    keypair.publicKey,
    custody,
    collateralCustody,
    side
  );
  const positionRequestPda = derivePositionRequestPda(positionPda, counter, "increase");

  const mint = CUSTODY_TO_MINT[custody.toString()];
  interface PriceEntry { usdPrice: number; }
  type PriceResponse = Record<string, PriceEntry>;
  const priceData = (await jupiterFetch("/price/v3", { ids: mint })) as PriceResponse;
  const currentPrice = priceData[mint].usdPrice;

  // Opening a long = buying the asset. Opening a short = selling the asset.
  const isBuying = side === "long";
  const acceptablePrice = calcAcceptablePrice(currentPrice, slippage, isBuying);

  const increaseIx = await buildIncreasePositionIx({
    walletPublicKey: keypair.publicKey,
    asset,
    side,
    sizeUsdDelta: new BN(Math.round(sizeUsd * 1_000_000)),
    collateralTokenDelta: new BN(collateralAmount),
    priceSlippage: acceptablePrice,
    counter,
  });

  const instructions = [];

  if (asset === "SOL" && side === "long") {
    const wsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      keypair.publicKey
    );

    // 1. Create wSOL ATA (idempotent — no-ops if already exists)
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        keypair.publicKey,
        wsolAta,
        keypair.publicKey,
        NATIVE_MINT
      )
    );

    // 2. Transfer native SOL into the wSOL ATA
    const lamports = Math.round(Number(collateralAmount));
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: wsolAta,
        lamports,
      })
    );

    // 3. Sync the wSOL ATA balance
    instructions.push(createSyncNativeInstruction(wsolAta));
  }

  instructions.push(increaseIx);

  const connection = new Connection(process.env.HELIUS_RPC_URL!);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);

  const txSignature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });

  await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  return { positionPda, positionRequestPda, txSignature };
}

export function registerPerpsTools(server: McpServer): void {
  server.tool(
    "get_perp_positions",
    "Fetch all open Jupiter Perpetuals positions for Sylvester's wallet and return a human-readable summary.",
    {},
    async () => {
      try {
        const keypair = loadSolanaKeypair();
        const allPositions = await fetchAllPositionsForWallet(keypair.publicKey);

        const open = allPositions.filter((p) => {
          const acc = p.account as any;
          const sizeUsd: BN = acc.sizeUsd;
          return sizeUsd && sizeUsd.gtn(0);
        });

        if (open.length === 0) {
          return { content: [{ type: "text" as const, text: "No open perp positions." }] };
        }

        // Collect unique mints for a single price fetch
        const mintsNeeded = new Set<string>();
        for (const p of open) {
          const acc = p.account as any;
          const custodyKey = (acc.custody as PublicKey).toString();
          const mint = CUSTODY_TO_MINT[custodyKey];
          if (mint) mintsNeeded.add(mint);
        }

        interface PriceEntry { usdPrice: number; }
        type PriceResponse = Record<string, PriceEntry>;
        const priceData = (await jupiterFetch("/price/v3", {
          ids: [...mintsNeeded].join(","),
        })) as PriceResponse;

        const lines: string[] = [];

        for (const pos of open) {
          const acc = pos.account as any;
          const custodyKey = (acc.custody as PublicKey).toString();
          const symbol = CUSTODY_TO_SYMBOL[custodyKey] ?? "UNKNOWN";
          const mint = CUSTODY_TO_MINT[custodyKey];

          // Anchor decodes Side enum as { long: {} } or { short: {} }
          const isLong = acc.side != null && "long" in acc.side;
          const sideLabel = isLong ? "Long" : "Short";

          const entryPrice = bnToUsd(acc.price as BN);
          const sizeUsd = bnToUsd(acc.sizeUsd as BN);
          const collateralUsd = bnToUsd(acc.collateralUsd as BN);

          const currentPrice = mint && priceData[mint]
            ? priceData[mint].usdPrice
            : entryPrice;

          const pnl = calcPnl(currentPrice, entryPrice, sizeUsd, isLong);
          const liqPrice = calcLiquidationPrice(entryPrice, sizeUsd, collateralUsd, isLong);
          const pnlLabel = pnl >= 0 ? "in profit" : "at a loss";

          const openTime = new Date((acc.openTime as BN).toNumber() * 1000).toLocaleString();
          const updateTime = new Date((acc.updateTime as BN).toNumber() * 1000).toLocaleString();

          lines.push(
            `${symbol} ${sideLabel} | $${sizeUsd.toFixed(2)} position\n` +
            `Entry price: $${entryPrice.toFixed(2)}\n` +
            `Collateral: $${collateralUsd.toFixed(2)}\n` +
            `Unrealized PnL: $${pnl.toFixed(2)} (${pnlLabel})\n` +
            `Liq. price: $${liqPrice.toFixed(2)}\n` +
            `Opened: ${openTime}\n` +
            `Last updated: ${updateTime}\n` +
            `Position PDA: ${pos.publicKey.toString()}`
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n\n") }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error fetching perp positions: ${msg}` }],
        };
      }
    }
  );

  server.tool(
    "open_perp_position",
    "Open a new Jupiter Perpetuals position for Sylvester's wallet by submitting a market increase position request.",
    {
      asset: z.enum(["SOL", "ETH", "BTC"]).describe("Asset to trade"),
      side: z.enum(["long", "short"]).describe("Position direction"),
      sizeUsd: z.number().describe("Position size in USD (e.g. 100 for a $100 position)"),
      collateralAmount: z
        .string()
        .describe(
          "Collateral in token base units: lamports for SOL longs, raw USDC units (6 decimals) for shorts and ETH/BTC longs"
        ),
      priceSlippage: z
        .number()
        .optional()
        .describe("Price slippage tolerance in basis points. Defaults to 500 (5%)"),
    },
    async ({ asset, side, sizeUsd, collateralAmount, priceSlippage }) => {
      try {
        const { positionPda, positionRequestPda, txSignature } = await executeOpenPosition({
          asset,
          side,
          sizeUsd,
          collateralAmount,
          priceSlippage,
        });

        const result =
          `Position opened successfully.\n\n` +
          `Position PDA:         ${positionPda.toString()}\n` +
          `Position Request PDA: ${positionRequestPda.toString()}\n` +
          `Transaction:          ${txSignature}\n` +
          `Solscan:              https://solscan.io/tx/${txSignature}\n\n` +
          `The request has been submitted to the keeper network for execution. ` +
          `Call get_position_request_status with positionRequestPda "${positionRequestPda.toString()}" ` +
          `to confirm keeper execution and see the final fill price.`;

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error opening perp position: ${msg}` }],
        };
      }
    }
  );

  server.tool(
    "open_perp_position_and_wait",
    "Open a new Jupiter Perpetuals position and poll until the keeper executes the request, cancelling the request if it isn't executed within the timeout.",
    {
      asset: z.enum(["SOL", "ETH", "BTC"]).describe("Asset to trade"),
      side: z.enum(["long", "short"]).describe("Position direction"),
      sizeUsd: z.number().describe("Position size in USD (e.g. 100 for a $100 position)"),
      collateralAmount: z
        .string()
        .describe(
          "Collateral in token base units: lamports for SOL longs, raw USDC units (6 decimals) for shorts and ETH/BTC longs"
        ),
      priceSlippage: z
        .number()
        .optional()
        .describe("Price slippage tolerance in basis points. Defaults to 500 (5%)"),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(
          "Polling timeout in seconds before giving up and cancelling the request. Defaults to 30."
        ),
    },
    async ({ asset, side, sizeUsd, collateralAmount, priceSlippage, timeoutSeconds }) => {
      try {
        const { positionPda, positionRequestPda, txSignature } = await executeOpenPosition({
          asset,
          side,
          sizeUsd,
          collateralAmount,
          priceSlippage,
        });

        const timeout = timeoutSeconds ?? 30;
        const timeoutMs = timeout * 1000;
        const pollIntervalMs = 2000;
        const startTime = Date.now();
        let executed = false;

        while (Date.now() - startTime < timeoutMs) {
          const requestAccount = await fetchPositionRequest(positionRequestPda);
          executed = requestAccount === null || (requestAccount as any).executed === true;
          if (executed) break;
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        if (executed) {
          const result =
            `Position opened and executed by the keeper.\n\n` +
            `Position PDA:         ${positionPda.toString()}\n` +
            `Position Request PDA: ${positionRequestPda.toString()}\n` +
            `Transaction:          ${txSignature}\n` +
            `Solscan:              https://solscan.io/tx/${txSignature}\n\n` +
            `The keeper executed the request within the timeout. Call get_perp_positions to see the ` +
            `final position state — settlement details such as fill price may still lag slightly.`;

          return { content: [{ type: "text" as const, text: result }] };
        }

        // Timed out — the request is still pending. Attempt to cancel it so collateral isn't stuck.
        try {
          const keypair = loadSolanaKeypair();
          const cancelIx = await buildCancelPositionRequestIx({
            walletPublicKey: keypair.publicKey,
            positionPda,
            positionRequestPda,
            asset,
            side,
          });

          const connection = new Connection(process.env.HELIUS_RPC_URL!);
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

          const message = new TransactionMessage({
            payerKey: keypair.publicKey,
            recentBlockhash: blockhash,
            instructions: [cancelIx],
          }).compileToV0Message();

          const tx = new VersionedTransaction(message);
          tx.sign([keypair]);

          const cancelTxSignature = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
          });

          await connection.confirmTransaction(
            { signature: cancelTxSignature, blockhash, lastValidBlockHeight },
            "confirmed"
          );

          const result =
            `Position request timed out after ${timeout}s and was cancelled.\n\n` +
            `Position Request PDA: ${positionRequestPda.toString()}\n` +
            `Original Transaction: ${txSignature}\n` +
            `Cancel Transaction:   ${cancelTxSignature}\n` +
            `Solscan (cancel):     https://solscan.io/tx/${cancelTxSignature}\n\n` +
            `The keeper did not execute the request in time, so it was cancelled. Collateral should be ` +
            `returned to the wallet.`;

          return { content: [{ type: "text" as const, text: result }] };
        } catch (cancelErr: unknown) {
          const cancelMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
          return {
            content: [{
              type: "text" as const,
              text:
                `Position request timed out and the cancellation attempt FAILED: ${cancelMsg}\n\n` +
                `WARNING: A position request may still be pending on-chain and needs manual attention. ` +
                `Call get_position_request_status with positionRequestPda "${positionRequestPda.toString()}" ` +
                `to check its state before taking further action.`,
            }],
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error opening perp position: ${msg}` }],
        };
      }
    }
  );

  server.tool(
    "get_position_request_status",
    "Check whether a Jupiter Perpetuals position request has been executed by the keeper network.",
    {
      positionRequestPda: z
        .string()
        .describe(
          "The position request account address returned by open_perp_position or close_perp_position"
        ),
    },
    async ({ positionRequestPda }) => {
      try {
        const pda = new PublicKey(positionRequestPda);
        const result = await fetchPositionRequest(pda);

        const executed = result === null || (result as any).executed === true;
        const text = executed
          ? "Request executed. Call get_perp_positions to confirm your position state."
          : "Request still pending. Try again in a few seconds.";

        return { content: [{ type: "text" as const, text }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error checking position request status: ${msg}` }],
        };
      }
    }
  );

  server.tool(
    "close_perp_position",
    "Close an existing Jupiter Perpetuals position entirely for Sylvester's wallet.",
    {
      asset: z.enum(["SOL", "ETH", "BTC"]).describe("Asset of the position to close"),
      side: z.enum(["long", "short"]).describe("Direction of the position to close"),
      priceSlippage: z
        .number()
        .optional()
        .describe("Price slippage tolerance in basis points. Defaults to 500 (5%)"),
    },
    async ({ asset, side, priceSlippage }) => {
      try {
        const slippage = priceSlippage ?? 500;
        const keypair = loadSolanaKeypair();
        const counter = new BN(Math.floor(Math.random() * 1_000_000));

        const { custody, collateralCustody } = getCustodyAccounts(asset, side);
        const positionPda = derivePositionPda(
          keypair.publicKey,
          custody,
          collateralCustody,
          side
        );
        const positionRequestPda = derivePositionRequestPda(positionPda, counter, "decrease");

        const positionAccount = await fetchPosition(positionPda);
        if (!positionAccount) {
          return {
            content: [{ type: "text" as const, text: `No open position found for ${asset} ${side}.` }],
          };
        }

        const mint = CUSTODY_TO_MINT[custody.toString()];
        interface PriceEntry { usdPrice: number; }
        type PriceResponse = Record<string, PriceEntry>;
        const priceData = (await jupiterFetch("/price/v3", { ids: mint })) as PriceResponse;
        const currentPrice = priceData[mint].usdPrice;

        // Closing a long = selling the asset. Closing a short = buying back the asset.
        const isBuying = side === "short";
        const acceptablePrice = calcAcceptablePrice(currentPrice, slippage, isBuying);

        const ix = await buildDecreasePositionIx({
          walletPublicKey: keypair.publicKey,
          asset,
          side,
          sizeUsdDelta: (positionAccount as any).sizeUsd as BN,
          collateralUsdDelta: new BN(0),
          priceSlippage: acceptablePrice,
          entirePosition: true,
          counter,
        });

        const connection = new Connection(process.env.HELIUS_RPC_URL!);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

        const message = new TransactionMessage({
          payerKey: keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: [ix],
        }).compileToV0Message();

        const tx = new VersionedTransaction(message);
        tx.sign([keypair]);

        const txSignature = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
        });

        await connection.confirmTransaction(
          { signature: txSignature, blockhash, lastValidBlockHeight },
          "confirmed"
        );

        const result =
          `Close request submitted successfully.\n\n` +
          `Position Request PDA: ${positionRequestPda.toString()}\n` +
          `Transaction:          ${txSignature}\n` +
          `Solscan:              https://solscan.io/tx/${txSignature}\n\n` +
          `Call get_position_request_status with positionRequestPda "${positionRequestPda.toString()}" ` +
          `to confirm keeper execution.`;

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error closing perp position: ${msg}` }],
        };
      }
    }
  );
}
