import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import bs58 from "bs58";
import { jupiterFetch } from "../client/jupiter.js";
import { getSolanaPublicKey, loadSolanaKeypair } from "../client/solana.js";

const ERROR_CODES: Record<number, string> = {
  0: "Success",
  [-1]: "Missing cached order (requestId expired or not found)",
  [-2]: "Invalid signed transaction",
  [-3]: "Invalid message bytes",
  [-1000]: "Aggregator: failed to land",
  [-1001]: "Aggregator: unknown error",
  [-1002]: "Aggregator: invalid transaction",
  [-1003]: "Aggregator: transaction not fully signed",
  [-1004]: "Aggregator: invalid block height",
  [-2000]: "RFQ: failed to land",
  [-2001]: "RFQ: unknown error",
  [-2002]: "RFQ: invalid payload",
  [-2003]: "RFQ: quote expired",
  [-2004]: "RFQ: swap rejected",
};

export function validateBaseUnits(amount: string): void {
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || /^0+$/.test(amount)) {
    throw new Error(
      `amount must be a positive whole number in base units (digits only, e.g. lamports: 1 SOL = 1000000000). Got: ${amount}. Nothing was submitted.`
    );
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const j = JSON.stringify(err);
    return j === undefined ? String(err as any) : j;
  } catch {
    return String(err as any);
  }
}

interface SwapQuoteResponse {
  swapType: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan?: Array<{
    label: string;
    [key: string]: unknown;
  }>;
  errorMessage?: unknown;
  errorCode?: unknown;
  [key: string]: unknown;
}

interface OrderResponse {
  requestId?: string;
  transaction?: string | null;
  errorMessage?: unknown;
  errorCode?: unknown;
  [key: string]: unknown;
}

interface ExecuteResponse {
  status: string; // "Success" or "Failed"
  code: number;   // numeric result code — maps to ERROR_CODES
  signature?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
  [key: string]: unknown;
}

export function registerSwapTools(server: McpServer): void {
  server.tool(
    "get_swap_quote",
    "Get a swap quote from Jupiter without executing. INVARIANT: amount must be supplied in base units (smallest denomination) as a decimal string — e.g. lamports for SOL, raw integer units for a token with N decimals. This tool performs NO decimal conversion and assumes the caller has already normalized the value (e.g. via search_token to look up decimals, then multiplying). Do not pass human-readable amounts like '0.01'.",
    {
      inputMint: z.string().describe("Mint address of the token to sell"),
      outputMint: z.string().describe("Mint address of the token to buy"),
      amount: z.string().describe("Amount in base units (smallest denomination) as a decimal string. Must be a whole number (digits only)."),
    },
    async ({ inputMint, outputMint, amount }) => {
      try {
        validateBaseUnits(amount);

        // Get the wallet's public key
        const publicKey = getSolanaPublicKey();
        const taker = publicKey.toBase58();

        // Call Jupiter API for a swap quote
        const quote = (await jupiterFetch("/ultra/v1/order", {
          inputMint,
          outputMint,
          amount,
          taker,
        })) as SwapQuoteResponse;

        if (quote.errorMessage || quote.errorCode || !Array.isArray(quote.routePlan)) {
          const reason = quote.errorMessage ?? quote.errorCode ?? "no route";
          return {
            content: [{ type: "text", text: `Jupiter returned no quote: ${describeError(reason)}.` }],
          };
        }

        // Extract route labels
        const routeLabels = quote.routePlan.map(step => step.label).join(" -> ");

        // Format the response
        const formatted = [
          `Swap quote: ${quote.inAmount} (${inputMint}) → ~${quote.outAmount} (${outputMint})`,
          `Type: ${quote.swapType}`,
          `Slippage: ${quote.slippageBps} bps`,
          `Price impact: ${quote.priceImpactPct}%`,
          `Route: ${routeLabels}`,
        ].join("\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      } catch (error) {
        const errorMessage = describeError(error);
        return {
          content: [{ type: "text", text: `Error getting swap quote: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "execute_swap",
    "Execute a real on-chain swap via Jupiter Ultra. INVARIANT: amount must be supplied in base units (smallest denomination) as a decimal string. This tool performs NO decimal conversion — the caller must normalize the amount before calling (e.g. via search_token to look up decimals). This submits a REAL transaction on Solana mainnet using the loaded wallet.",
    {
      inputMint: z.string().describe("Mint address of the token to sell"),
      outputMint: z.string().describe("Mint address of the token to buy"),
      amount: z.string().describe("Amount in base units (smallest denomination) as a decimal string. Must be a whole number (digits only)."),
    },
    async ({ inputMint, outputMint, amount }) => {
      let executeAttempted = false;
      try {
        validateBaseUnits(amount);

        // Get the wallet's public key
        const publicKey = getSolanaPublicKey();
        const taker = publicKey.toBase58();

        // Get a fresh quote from Jupiter
        const order = (await jupiterFetch("/ultra/v1/order", {
          inputMint,
          outputMint,
          amount,
          taker,
        })) as OrderResponse;

        if (order.errorMessage || order.errorCode || !order.requestId) {
          const reason = order.errorMessage ?? order.errorCode ?? "no requestId";
          return {
            content: [{
              type: "text",
              text: `Jupiter did not return an executable order: ${describeError(reason)}. Nothing was submitted.`,
            }],
          };
        }

        const requestId = order.requestId;
        let signedTransaction: string | undefined;
        let localSignature: string | undefined;

        // Branch based on transaction presence.
        // NOTE: the RFQ branch (transaction null, no error field) is unchanged and untested live.
        if (order.transaction) {
          // Aggregator swap: sign the transaction
          const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
          const keypair = loadSolanaKeypair();
          tx.sign([keypair]);
          localSignature = bs58.encode(tx.signatures[0]);
          signedTransaction = Buffer.from(tx.serialize()).toString('base64');
        }

        // Execute the swap
        const executeBody: Record<string, unknown> = { requestId };
        if (signedTransaction !== undefined) {
          executeBody.signedTransaction = signedTransaction;
        }

        let executeResult: ExecuteResponse;
        executeAttempted = true;
        try {
          executeResult = (await jupiterFetch("/ultra/v1/execute", undefined, {
            method: 'POST',
            body: executeBody,
          })) as ExecuteResponse;
        } catch (execErr) {
          const lines = [
            `Swap was submitted to Jupiter but the result was not received: ${describeError(execErr)}. ` +
              `It may still land. Do NOT retry yet — check wallet balances (get_wallet_balances) first.`,
            `Request ID: ${requestId}`,
            localSignature ? `Signature: ${localSignature}` : null,
            localSignature ? `Explorer: https://solscan.io/tx/${localSignature}` : null,
          ].filter(line => line !== null);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Format response — status is a string ("Success"/"Failed"), code is the numeric
        // result code that maps to ERROR_CODES. These are two separate fields from Jupiter.
        const code = executeResult.code;
        const statusMessage = ERROR_CODES[code] ?? `Unknown result code (${code})`;

        if (executeResult.status === "Success") {
          // Success
          const signature = executeResult.signature || 'unknown';
          const lines = [
            `Swap executed successfully`,
            `Input: ${executeResult.inputAmountResult || 'unknown'} (${inputMint})`,
            `Output: ${executeResult.outputAmountResult || 'unknown'} (${outputMint})`,
            `Signature: ${signature}`,
            `Explorer: https://solscan.io/tx/${signature}`,
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        } else {
          // Failure
          const signature = executeResult.signature || localSignature;
          const lines = [
            `Swap failed with status ${code}: ${statusMessage}`,
            executeResult.error ? `Error details: ${executeResult.error}` : null,
            signature ? `Signature: ${signature}` : null,
            signature ? `Explorer: https://solscan.io/tx/${signature}` : null,
          ].filter(line => line !== null);

          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        }
      } catch (error) {
        const errorMessage = describeError(error);
        const suffix = executeAttempted || errorMessage.endsWith("Nothing was submitted.")
          ? ""
          : " Nothing was submitted.";
        return {
          content: [{ type: "text", text: `Error executing swap: ${errorMessage}${suffix}` }],
        };
      }
    }
  );
}