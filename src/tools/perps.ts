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

// Decimals of the collateral custody's token.
// LONG: collateral is the asset itself — SOL (So11111111111111111111111111111111111111112) = 9,
//   ETH (7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs) = 8, BTC (3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh) = 8.
// SHORT: collateral is USDC = 6.
const COLLATERAL_DECIMALS = {
  long: { SOL: 9, ETH: 8, BTC: 8 },
  short: { SOL: 6, ETH: 6, BTC: 6 },
} as const;

export function checkCollateral(params: {
  asset: "SOL" | "ETH" | "BTC";
  side: "long" | "short";
  sizeUsd: number;
  collateralAmount: string;
  assetPriceUsd: number;
  maxLeverage?: number;
}): { collateralTokens: number; collateralUsd: number; leverage: number; decimals: number } {
  const { asset, side, sizeUsd, collateralAmount, assetPriceUsd, maxLeverage } = params;
  const isLong = side === "long";
  const decimals = COLLATERAL_DECIMALS[side][asset];
  const unit = isLong ? asset : "USDC";
  const article = asset === "ETH" ? "an" : "a";
  const oneUnit = "1" + "0".repeat(decimals);
  const correctUnit = `${unit} collateral for ${article} ${asset} ${side} uses ${decimals} decimals (1 ${unit} = ${oneUnit})`;

  if (typeof collateralAmount !== "string" || !/^\d+$/.test(collateralAmount) || Number(collateralAmount) === 0) {
    throw new Error(
      `collateralAmount must be a positive integer in base units (digits only, no decimals). ` +
        `${correctUnit}.`
    );
  }
  if (typeof sizeUsd !== "number" || !Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    throw new Error("sizeUsd must be a finite number greater than 0.");
  }
  if (typeof assetPriceUsd !== "number" || !Number.isFinite(assetPriceUsd) || assetPriceUsd <= 0) {
    throw new Error("assetPriceUsd must be a finite number greater than 0.");
  }

  const collateralTokens = Number(collateralAmount) / 10 ** decimals;
  const collateralUsd = isLong ? collateralTokens * assetPriceUsd : collateralTokens;
  const leverage = sizeUsd / collateralUsd;

  if (leverage < 0.9) {
    throw new Error(
      `Collateral is worth $${collateralUsd.toFixed(2)} but the position size is $${sizeUsd} ` +
        `(leverage ${leverage.toFixed(2)}x).\n` +
        `Collateral worth more than the position almost always means a units mistake.\n` +
        `${correctUnit}.`
    );
  }
  if (typeof maxLeverage === "number" && Number.isFinite(maxLeverage) && maxLeverage > 0 && leverage > maxLeverage) {
    throw new Error(
      `Leverage ${leverage.toFixed(2)}x exceeds the configured maximum of ${maxLeverage}x.`
    );
  }

  return { collateralTokens, collateralUsd, leverage, decimals };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const j = JSON.stringify(err);
    return j === undefined ? String(err as any) : j;
  } catch {
    return String(err as any);
  }
}

export async function sendAndConfirm(
  connection: {
    sendRawTransaction(raw: Uint8Array | Buffer, opts?: any): Promise<string>;
    confirmTransaction(strategy: any, commitment?: any): Promise<{ value: { err: unknown } }>;
  },
  tx: { serialize(): Uint8Array },
  blockhash: string,
  lastValidBlockHeight: number
): Promise<string> {
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  } catch (e) {
    throw new Error(`Transaction was NOT sent: ${describeError(e)}. Nothing changed on-chain.`);
  }

  let result: { value: { err: unknown } };
  try {
    result = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed"
    );
  } catch (e) {
    throw new Error(
      `Transaction ${signature} was sent but its confirmation was lost: ${describeError(e)}. ` +
        `It may still land. Do NOT retry yet — check get_perp_positions and get_position_request_status ` +
        `(or https://solscan.io/tx/${signature}) first.`
    );
  }
  if (result.value.err) {
    throw new Error(
      `Transaction ${signature} landed but FAILED on-chain: ${describeError(result.value.err)}. Nothing changed.`
    );
  }
  return signature;
}

export function classifyRequestOutcome(p: {
  requestExists: boolean;
  requestExecuted: boolean;
  baselineSizeUsd: number;
  currentSizeUsd: number;
  change: "increase" | "decrease";
}): "pending" | "filled" | "not_filled" {
  if (p.requestExists && !p.requestExecuted) return "pending";
  if (p.change === "increase") {
    return p.currentSizeUsd > p.baselineSizeUsd ? "filled" : "not_filled";
  }
  return p.currentSizeUsd < p.baselineSizeUsd ? "filled" : "not_filled";
}

async function readPositionSizeUsd(positionPda: PublicKey): Promise<number> {
  const acc = await fetchPosition(positionPda);
  if (!acc) return 0;
  return bnToUsd((acc as any).sizeUsd as BN);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readOptionalPositiveNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveOpenSlippageBps(requested: number | undefined, maxBps: number | undefined): number {
  if (requested === undefined) {
    return maxBps !== undefined ? Math.min(500, maxBps) : 500;
  }
  if (!Number.isInteger(requested) || requested < 0 || requested > 10000) {
    throw new Error(
      `priceSlippage must be an integer between 0 and 10000 basis points (got ${requested}). Nothing was sent.`
    );
  }
  if (maxBps !== undefined && requested > maxBps) {
    throw new Error(
      `Requested slippage ${requested} bps exceeds MAX_SLIPPAGE_BPS=${maxBps}. Use a lower priceSlippage, or raise or unset MAX_SLIPPAGE_BPS in the server's environment. Nothing was sent.`
    );
  }
  return requested;
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
  collateralUsd: number;
  leverage: number;
  baselineSizeUsd: number;
  slippageBps: number;
}> {
  const { asset, side, sizeUsd, collateralAmount, priceSlippage } = params;
  // Resolved (and optionally capped) before anything is built or sent.
  const slippage = resolveOpenSlippageBps(priceSlippage, readOptionalPositiveNumber("MAX_SLIPPAGE_BPS"));
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

  // Validate collateral units/value before building or sending anything.
  const { collateralUsd, leverage } = checkCollateral({
    asset,
    side,
    sizeUsd,
    collateralAmount,
    assetPriceUsd: currentPrice,
    maxLeverage: readOptionalPositiveNumber("MAX_LEVERAGE"),
  });

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

  // Record the position size before sending so a fill can be detected afterwards.
  const baselineSizeUsd = await readPositionSizeUsd(positionPda);

  const connection = new Connection(process.env.HELIUS_RPC_URL!);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);

  const txSignature = await sendAndConfirm(connection, tx, blockhash, lastValidBlockHeight);

  return { positionPda, positionRequestPda, txSignature, collateralUsd, leverage, baselineSizeUsd, slippageBps: slippage };
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
        const msg = describeError(err);
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
          "Collateral in base units of the collateral token. LONG: the asset itself — SOL long in lamports (9 decimals, 1 SOL = 1000000000); ETH or BTC long in 8-decimal base units (1 ETH/BTC = 100000000). SHORT (any asset): USDC base units (6 decimals, 1 USDC = 1000000). The tool refuses collateral worth more than the position (a units mistake)."
        ),
      priceSlippage: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe("Price slippage tolerance in basis points (0-10000). Defaults to 500 (5%), or to MAX_SLIPPAGE_BPS if the operator set a lower cap."),
    },
    async ({ asset, side, sizeUsd, collateralAmount, priceSlippage }) => {
      try {
        const { positionPda, positionRequestPda, txSignature, collateralUsd, leverage, slippageBps } =
          await executeOpenPosition({
            asset,
            side,
            sizeUsd,
            collateralAmount,
            priceSlippage,
          });

        const result =
          `Position request submitted (NOT yet filled).\n\n` +
          `Position PDA:         ${positionPda.toString()}\n` +
          `Position Request PDA: ${positionRequestPda.toString()}\n` +
          `Transaction:          ${txSignature}\n` +
          `Solscan:              https://solscan.io/tx/${txSignature}\n\n` +
          `The keeper will fill or reject it, usually within seconds. ` +
          `Call get_position_request_status, then get_perp_positions to confirm the position actually grew — do not assume it filled.\n` +
          `Collateral value: $${collateralUsd.toFixed(2)}\n` +
          `Leverage: ${leverage.toFixed(2)}x\n` +
          `Slippage: ${slippageBps} bps`;

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (err: unknown) {
        const msg = describeError(err);
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
          "Collateral in base units of the collateral token. LONG: the asset itself — SOL long in lamports (9 decimals, 1 SOL = 1000000000); ETH or BTC long in 8-decimal base units (1 ETH/BTC = 100000000). SHORT (any asset): USDC base units (6 decimals, 1 USDC = 1000000). The tool refuses collateral worth more than the position (a units mistake)."
        ),
      priceSlippage: z
        .number()
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe("Price slippage tolerance in basis points (0-10000). Defaults to 500 (5%), or to MAX_SLIPPAGE_BPS if the operator set a lower cap."),
      timeoutSeconds: z
        .number()
        .min(5)
        .max(120)
        .optional()
        .describe(
          "Polling timeout in seconds (5–120) before giving up and cancelling the request. Defaults to 30."
        ),
    },
    async ({ asset, side, sizeUsd, collateralAmount, priceSlippage, timeoutSeconds }) => {
      try {
        const { positionPda, positionRequestPda, txSignature, collateralUsd, leverage, baselineSizeUsd, slippageBps } =
          await executeOpenPosition({
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
        let outcome: "pending" | "filled" | "not_filled" = "pending";
        let currentSizeUsd = baselineSizeUsd;

        while (Date.now() - startTime < timeoutMs) {
          const requestAccount = await fetchPositionRequest(positionRequestPda);
          const requestExists = requestAccount !== null;
          const requestExecuted = requestExists && (requestAccount as any).executed === true;
          currentSizeUsd = await readPositionSizeUsd(positionPda);
          const classify = () =>
            classifyRequestOutcome({
              requestExists,
              requestExecuted,
              baselineSizeUsd,
              currentSizeUsd,
              change: "increase",
            });
          outcome = classify();

          if (outcome === "not_filled") {
            // Settlement may lag the request disappearing — re-read a few times before concluding.
            for (let i = 0; i < 3 && outcome === "not_filled"; i++) {
              await sleep(pollIntervalMs);
              currentSizeUsd = await readPositionSizeUsd(positionPda);
              outcome = classify();
            }
          }
          if (outcome !== "pending") break;
          await sleep(pollIntervalMs);
        }

        if (outcome === "filled") {
          const result =
            `Position FILLED: size grew from $${baselineSizeUsd.toFixed(2)} to $${currentSizeUsd.toFixed(2)}.\n\n` +
            `Position PDA:         ${positionPda.toString()}\n` +
            `Position Request PDA: ${positionRequestPda.toString()}\n` +
            `Transaction:          ${txSignature}\n` +
            `Solscan:              https://solscan.io/tx/${txSignature}\n` +
            `Collateral value: $${collateralUsd.toFixed(2)}\n` +
            `Leverage: ${leverage.toFixed(2)}x\n` +
            `Slippage: ${slippageBps} bps`;

          return { content: [{ type: "text" as const, text: result }] };
        }

        if (outcome === "not_filled") {
          const result =
            `Request was NOT filled — the keeper rejected or closed it. ` +
            `Position size is unchanged at $${currentSizeUsd.toFixed(2)}. ` +
            `Any collateral should be back in the wallet; check balances.\n\n` +
            `Position PDA:         ${positionPda.toString()}\n` +
            `Position Request PDA: ${positionRequestPda.toString()}\n` +
            `Transaction:          ${txSignature}\n` +
            `Solscan:              https://solscan.io/tx/${txSignature}`;

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

          const cancelTxSignature = await sendAndConfirm(connection, tx, blockhash, lastValidBlockHeight);

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
          const cancelMsg = describeError(cancelErr);
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
        const msg = describeError(err);
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

        let text: string;
        if (result === null) {
          text =
            "Request no longer exists: the keeper either FILLED or REJECTED it — this tool cannot tell which. " +
            "Call get_perp_positions and compare the position size with before the request. Do not assume it filled.";
        } else if ((result as any).executed === true) {
          text =
            "Request marked executed by the keeper. Call get_perp_positions to confirm the position state.";
        } else {
          text = "Request still pending. Try again in a few seconds.";
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err: unknown) {
        const msg = describeError(err);
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
        .int()
        .min(0)
        .max(10000)
        .optional()
        .describe("Price slippage tolerance in basis points (0-10000). Defaults to 500 (5%). Never capped, so an exit is not refused."),
    },
    async ({ asset, side, priceSlippage }) => {
      try {
        // Closes are intentionally never capped by MAX_SLIPPAGE_BPS.
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
        const sizeBefore = positionAccount ? bnToUsd((positionAccount as any).sizeUsd as BN) : 0;
        if (!positionAccount || sizeBefore <= 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No open ${asset} ${side} position to close (size is $0). Nothing was sent.`,
            }],
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

        const txSignature = await sendAndConfirm(connection, tx, blockhash, lastValidBlockHeight);

        const result =
          `Close request submitted (NOT yet filled).\n` +
          `Position size before close: $${sizeBefore.toFixed(2)}.\n\n` +
          `Position Request PDA: ${positionRequestPda.toString()}\n` +
          `Transaction:          ${txSignature}\n` +
          `Solscan:              https://solscan.io/tx/${txSignature}\n\n` +
          `Call get_position_request_status, then get_perp_positions to confirm the position is gone.`;

        return {
          content: [{ type: "text" as const, text: result }],
        };
      } catch (err: unknown) {
        const msg = describeError(err);
        return {
          content: [{ type: "text" as const, text: `Error closing perp position: ${msg}` }],
        };
      }
    }
  );
}
