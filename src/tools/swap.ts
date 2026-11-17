import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
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

interface SwapQuoteResponse {
  swapType: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: Array<{
    label: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface OrderResponse {
  requestId: string;
  transaction: string | null;
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
      amount: z.string().describe("Amount in base units (smallest denomination) as a decimal string"),
    },
    async ({ inputMint, outputMint, amount }) => {
      try {
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
        const errorMessage = error instanceof Error ? error.message : String(error);
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
      amount: z.string().describe("Amount in base units (smallest denomination) as a decimal string"),
    },
    async ({ inputMint, outputMint, amount }) => {
      try {
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

        const requestId = order.requestId;
        let signedTransaction: string | undefined;

        // Branch based on transaction presence
        if (order.transaction !== null) {
          // Aggregator swap: sign the transaction
          const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
          const keypair = loadSolanaKeypair();
          tx.sign([keypair]);
          signedTransaction = Buffer.from(tx.serialize()).toString('base64');
        }

        // Execute the swap
        const executeBody: Record<string, unknown> = { requestId };
        if (signedTransaction !== undefined) {
          executeBody.signedTransaction = signedTransaction;
        }

        const executeResult = (await jupiterFetch("/ultra/v1/execute", undefined, {
          method: 'POST',
          body: executeBody,
        })) as ExecuteResponse;

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
          const signature = executeResult.signature;
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error executing swap: ${errorMessage}` }],
        };
      }
    }
  );
}