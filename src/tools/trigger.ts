import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import {
  getTriggerJwt,
  getVaultCached,
  craftDeposit,
  createTriggerOrder,
  createOcoTriggerOrder,
  cancelTriggerOrder,
  confirmCancelTriggerOrder,
  TRIGGER_API_BASE,
} from "../client/trigger.js";
import { getSolanaPublicKey, loadSolanaKeypair } from "../client/solana.js";

export function registerTriggerTools(server: McpServer): void {
  // Add the new get_trigger_orders tool first
  server.tool(
    "get_trigger_orders",
    "Query Jupiter trigger order history. state='active' returns open orders; state='past' returns filled, cancelled, or expired orders. Omit state to see all. Optionally filter by mint address (matches input or output mint). Supports pagination via limit (1-100, default 20) and offset.",
    {
      state: z.enum(['active', 'past']).optional(),
      mint: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ state, mint, limit, offset }) => {
      try {
        // Get JWT for authentication
        const jwt = await getTriggerJwt();

        // Read API key from environment
        const apiKey = process.env.JUPITER_API_KEY;
        if (!apiKey) {
          throw new Error("JUPITER_API_KEY environment variable is not set");
        }

        // Construct URL with query parameters
        const url = new URL(`${TRIGGER_API_BASE}/orders/history`);
        if (state) url.searchParams.set('state', state);
        if (mint) url.searchParams.set('mint', mint);
        if (limit !== undefined) url.searchParams.set('limit', limit.toString());
        if (offset !== undefined) url.searchParams.set('offset', offset.toString());

        // Make the API call
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'Authorization': `Bearer ${jwt}`,
          },
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Trigger orders API error: ${response.status} ${response.statusText} — ${body}`);
        }

        const data = await response.json() as {
          orders: Array<{
            id: string;
            orderType: "single" | "oco" | "otoco";
            orderState: string;
            rawState: string;
            userPubkey: string;
            privyWalletPubkey: string;
            inputMint: string;
            initialInputAmount: string;
            remainingInputAmount: string;
            outputMint: string;
            triggerMint: string;
            triggerCondition: "above" | "below";
            triggerPriceUsd: number;
            slippageBps: number;
            expiresAt: number;
            createdAt: number;
            updatedAt: number;
            events: Array<{
              type: "deposit" | "fill" | "withdrawal" | "cancelled" | "expired";
              timestamp: number;
              state: string;
              txSignature?: string;
              mint?: string;
              amount?: string;
              outputMint?: string;
              outputAmount?: string;
              orderContext?: string;
            }>;
            triggeredAt?: number;
            outputAmount?: string;
            inputUsed?: string;
            fillPercent?: number;
          }>;
          pagination: { total: number; limit: number; offset: number };
        };

        const { orders, pagination } = data;
        const { total, limit: actualLimit, offset: actualOffset } = pagination;

        // Handle empty response
        if (total === 0) {
          return {
            content: [{ type: "text", text: "No trigger orders found." }],
          };
        }

        // Build summary line
        const count = orders.length;
        const summary = `${total} trigger order(s) found (showing ${actualOffset + 1}–${actualOffset + count} of ${total}):`;

        // Build per-order blocks
        const orderBlocks = orders.map(order => {
          const expiryDate = new Date(order.expiresAt);
          const createdDate = new Date(order.createdAt);

          let block = [
            `Order ${order.id}`,
            `  Type: ${order.orderType} | ${order.orderState}`,
            `  Trigger: ${order.triggerCondition} $${order.triggerPriceUsd} (${order.triggerMint})`,
            `  Input: ${order.remainingInputAmount}/${order.initialInputAmount} ${order.inputMint} remaining`,
            `  Output mint: ${order.outputMint}`,
            `  Slippage: ${order.slippageBps != null ? `${order.slippageBps} bps` : 'not reported by Jupiter'}`,
            `  Expires: ${expiryDate.toISOString()}`,
            `  Created: ${createdDate.toISOString()}`,
          ];

          // Add fill info if present
          if (order.fillPercent !== undefined) {
            const fillPercent = (order.fillPercent * 100).toFixed(2);
            block.push(`  Filled: ${fillPercent}% — received ${order.outputAmount || 'unknown'} ${order.outputMint}`);
          }

          return block.join('\n');
        });

        // Combine summary and order blocks
        const output = [summary, ...orderBlocks].join('\n\n');

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to fetch trigger orders: ${errorMessage}` }],
        };
      }
    }
  );

  // Keep the existing create_trigger_order tool
  server.tool(
    "create_trigger_order",
    "Place a single trigger order on Jupiter. Executes automatically when the trigger condition is met. inputAmount must be in base units (lamports for SOL, raw integer for USDC with 6 decimals). Direction is implicit: sell inputMint for outputMint when triggerMint price crosses triggerPriceUsd. triggerCondition 'above' = take-profit or buy-into-strength; 'below' = stop-loss or limit-buy. slippageBps defaults to 300 bps for stop-loss/buy-below orders when not specified; take-profit/buy-above orders default to Jupiter's automatic slippage when not specified. Specify expiry via expiresAt (millisecond timestamp) or expiryDays (1-365). Returns the order id for subsequent management, the deposit tx signature, and a Solscan URL.",
    {
      inputMint: z.string().describe("Mint address of the token to sell"),
      outputMint: z.string().describe("Mint address of the token to buy"),
      triggerMint: z.string().describe("Mint address of the token whose USD price triggers the order"),
      inputAmount: z.string().describe("Amount to sell in base units (lamports for SOL, raw integer for USDC with 6 decimals)"),
      triggerCondition: z.enum(['above', 'below']).describe("Trigger condition: 'above' = take-profit/buy-into-strength, 'below' = stop-loss/limit-buy"),
      triggerPriceUsd: z.number().describe("Trigger price in USD"),
      slippageBps: z.number().int().min(0).max(10000).optional().describe("Slippage in basis points (0-10000). Omit to use Jupiter's default"),
      expiresAt: z.number().int().optional().describe("Order expiry as Unix timestamp in milliseconds"),
      expiryDays: z.number().int().min(1).max(365).optional().describe("Order expiry in days (1-365)"),
    },
    async ({
      inputMint,
      outputMint,
      triggerMint,
      inputAmount,
      triggerCondition,
      triggerPriceUsd,
      slippageBps,
      expiresAt,
      expiryDays,
    }) => {
      try {
        // Pre-API validation
        if (inputMint === outputMint) {
          return {
            content: [{
              type: "text",
              text: "Error: inputMint cannot equal outputMint"
            }]
          };
        }

        // Expiry logic
        let resolvedExpiresAt: number;

        if (expiresAt !== undefined) {
          resolvedExpiresAt = expiresAt;
        } else if (expiryDays !== undefined) {
          resolvedExpiresAt = Date.now() + (expiryDays * 24 * 60 * 60 * 1000);
        } else {
          return {
            content: [{
              type: "text",
              text: "Error: must provide either expiresAt or expiryDays"
            }]
          };
        }

        if (resolvedExpiresAt <= Date.now()) {
          return {
            content: [{
              type: "text",
              text: `Error: expiry timestamp ${new Date(resolvedExpiresAt).toISOString()} is in the past`
            }]
          };
        }

        // Step 1 — Obtain JWT
        const jwt = await getTriggerJwt();

        // Step 2 — Get or register vault (cached)
        const vault = await getVaultCached(jwt);

        // Step 3 — Craft deposit
        const deposit = await craftDeposit({
          jwt,
          inputMint,
          outputMint,
          userAddress: getSolanaPublicKey().toBase58(),
          amount: inputAmount,
          orderSubType: "single",
        });

        // Step 4 — Sign the deposit transaction
        const keypair = loadSolanaKeypair();
        const tx = VersionedTransaction.deserialize(
          Buffer.from(deposit.transaction, "base64")
        );
        tx.sign([keypair]);
        const depositSignedTx = Buffer.from(tx.serialize()).toString("base64");

        // Step 5 — Create the order
        // Stop-loss/buy-below orders default to 300 bps to avoid catastrophic fills;
        // take-profit/buy-above orders pass undefined to use Jupiter's automatic slippage.
        const resolvedSlippageBps = slippageBps !== undefined
          ? slippageBps
          : triggerCondition === 'below' ? 300 : undefined;

        const order = await createTriggerOrder({
          jwt,
          depositRequestId: deposit.requestId,
          depositSignedTx,
          userPubkey: getSolanaPublicKey().toBase58(),
          inputMint,
          inputAmount,
          outputMint,
          triggerMint,
          triggerCondition,
          triggerPriceUsd,
          slippageBps: resolvedSlippageBps,
          expiresAt: resolvedExpiresAt,
        });

        // Format success response
        const expiryDate = new Date(resolvedExpiresAt);
        const slippageDisplay = slippageBps !== undefined
          ? `${slippageBps} bps`
          : triggerCondition === 'below' ? '300 bps (default)' : 'auto';
        const lines = [
          "Trigger order placed successfully.",
          `Order ID: ${order.id}`,
          `Type: Single | ${triggerCondition} at $${triggerPriceUsd}`,
          `Input: ${inputAmount} ${inputMint} (base units)`,
          `Output mint: ${outputMint}`,
          `Trigger mint: ${triggerMint}`,
          `Slippage: ${slippageDisplay}`,
          `Expires: ${expiryDate.toISOString()}`,
          `Deposit tx: ${order.txSignature}`,
          `Solscan: https://solscan.io/tx/${order.txSignature}`
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to create trigger order: ${errorMessage}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "cancel_trigger_order",
    "Cancel an open or expired Jupiter trigger order and withdraw funds back to your wallet. Initiates the two-step cancellation flow: requests a withdrawal transaction from Jupiter, signs it with your wallet, and submits it. Works for both open orders (user-initiated cancel) and expired orders (recovering funds after expiry). Returns the withdrawal transaction signature and a Solscan URL confirming funds are returned. If the order is not yet ready to cancel, returns a message to try again shortly.",
    {
      orderId: z.string().describe("The order ID (ocoId) to cancel"),
    },
    async ({ orderId }) => {
      try {
        // Step 1 — Obtain JWT
        const jwt = await getTriggerJwt();

        // Step 2 — Initiate cancellation
        let cancelData;
        try {
          cancelData = await cancelTriggerOrder({ jwt, orderId });
        } catch (error) {
          // Check for 400 error (order not yet ready_to_cancel)
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes('400') || errorMessage.includes('not yet ready')) {
            return {
              content: [{
                type: "text",
                text: `Order ${orderId} is not yet ready to cancel. It may still be executing or open. Check its current state with get_trigger_orders and try again shortly.`
              }]
            };
          }
          // Re-throw other errors
          throw error;
        }

        // Step 3 — Sign the withdrawal transaction
        const keypair = loadSolanaKeypair();
        const tx = VersionedTransaction.deserialize(
          Buffer.from(cancelData.transaction, "base64")
        );
        tx.sign([keypair]);
        const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

        // Step 4 — Confirm cancellation
        const result = await confirmCancelTriggerOrder({
          jwt,
          orderId,
          signedTransaction,
          cancelRequestId: cancelData.requestId
        });

        // Format success response
        const lines = [
          "Trigger order cancelled successfully.",
          `Order ID: ${result.id}`,
          `Withdrawal tx: ${result.txSignature}`,
          `Solscan: https://solscan.io/tx/${result.txSignature}`,
          "Funds have been returned to your wallet."
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to cancel trigger order: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "update_trigger_order",
    "Update the trigger price or slippage on an open single Jupiter trigger order. Only open orders can be updated — check order state with get_trigger_orders first if unsure. Provide at least one of triggerPriceUsd or slippageBps. Changes take effect immediately with no signing or deposit required.",
    {
      orderId: z.string().describe("The order ID to update"),
      triggerPriceUsd: z.number().positive().optional().describe("New trigger price in USD — omit to keep current"),
      slippageBps: z.number().int().min(0).max(10000).optional().describe("New slippage in basis points — omit to keep current"),
    },
    async ({ orderId, triggerPriceUsd, slippageBps }) => {
      try {
        // Pre-API validation: at least one field must be provided
        if (triggerPriceUsd === undefined && slippageBps === undefined) {
          return {
            content: [{
              type: "text",
              text: "Provide at least one field to update: triggerPriceUsd or slippageBps."
            }]
          };
        }

        // Get JWT for authentication
        const jwt = await getTriggerJwt();

        // Read API key from environment
        const apiKey = process.env.JUPITER_API_KEY;
        if (!apiKey) {
          throw new Error("JUPITER_API_KEY environment variable is not set");
        }

        // Construct request body with only provided fields
        const body: Record<string, unknown> = { orderType: "single" };
        if (triggerPriceUsd !== undefined) {
          body.triggerPriceUsd = triggerPriceUsd;
        }
        if (slippageBps !== undefined) {
          body.slippageBps = slippageBps;
        }

        // Make the PATCH request
        const url = `${TRIGGER_API_BASE}/orders/price/${orderId}`;
        const response = await fetch(url, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "Authorization": `Bearer ${jwt}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const bodyText = await response.text();
          if (response.status === 400) {
            return {
              content: [{
                type: "text",
                text: `Order ${orderId} could not be updated. It may not be in an open state — check its current state with get_trigger_orders. Jupiter error: ${bodyText}`
              }]
            };
          }
          throw new Error(`Update trigger order error: ${response.status} ${response.statusText} — ${bodyText}`);
        }

        const result = await response.json() as { id: string };

        // Format success response
        const lines = [
          "Trigger order updated successfully.",
          `Order ID: ${result.id}`,
          "Updated fields:"
        ];

        if (triggerPriceUsd !== undefined) {
          lines.push(`  - Trigger price: $${triggerPriceUsd}`);
        }
        if (slippageBps !== undefined) {
          lines.push(`  - Slippage: ${slippageBps} bps`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to update trigger order: ${errorMessage}` }],
        };
      }
    }
  );

  server.tool(
    "create_oco_order",
    "Place an OCO (One-Cancels-Other) trigger order on Jupiter — a take-profit and stop-loss pair sharing a single deposit. The take-profit leg executes if triggerMint price rises above tpPriceUsd; the stop-loss leg executes if it falls below slPriceUsd. Only one leg can fill — when one triggers, the other is cancelled automatically. inputAmount must be in base units (lamports for SOL, raw integer for USDC with 6 decimals). tpPriceUsd must be greater than slPriceUsd. Specify expiry via expiresAt (ms timestamp) or expiryDays (1-365). Returns the order id for management via get_trigger_orders, cancel_trigger_order, and update_trigger_order.",
    {
      inputMint: z.string().describe("Mint address of the token to sell"),
      outputMint: z.string().describe("Mint address of the token to buy"),
      triggerMint: z.string().describe("Mint address of the token whose USD price triggers both legs"),
      inputAmount: z.string().describe("Amount to sell in base units (lamports for SOL, raw integer for USDC with 6 decimals)"),
      tpPriceUsd: z.number().positive().describe("Take-profit trigger price in USD"),
      slPriceUsd: z.number().positive().describe("Stop-loss trigger price in USD"),
      tpSlippageBps: z.number().int().min(0).max(10000).optional().describe("Take-profit slippage in basis points (0-10000)"),
      slSlippageBps: z.number().int().min(0).max(10000).optional().describe("Stop-loss slippage in basis points (0-10000)"),
      expiresAt: z.number().int().optional().describe("Order expiry as Unix timestamp in milliseconds"),
      expiryDays: z.number().int().min(1).max(365).optional().describe("Order expiry in days (1-365)"),
    },
    async ({
      inputMint,
      outputMint,
      triggerMint,
      inputAmount,
      tpPriceUsd,
      slPriceUsd,
      tpSlippageBps,
      slSlippageBps,
      expiresAt,
      expiryDays,
    }) => {
      try {
        // Pre-API validation
        if (inputMint === outputMint) {
          return {
            content: [{
              type: "text",
              text: "inputMint cannot equal outputMint"
            }]
          };
        }

        if (tpPriceUsd <= slPriceUsd) {
          return {
            content: [{
              type: "text",
              text: "tpPriceUsd must be strictly greater than slPriceUsd for an OCO order"
            }]
          };
        }

        // Expiry logic
        let resolvedExpiresAt: number;

        if (expiresAt !== undefined) {
          resolvedExpiresAt = expiresAt;
        } else if (expiryDays !== undefined) {
          resolvedExpiresAt = Date.now() + (expiryDays * 24 * 60 * 60 * 1000);
        } else {
          return {
            content: [{
              type: "text",
              text: "Must provide either expiresAt or expiryDays"
            }]
          };
        }

        if (resolvedExpiresAt <= Date.now()) {
          return {
            content: [{
              type: "text",
              text: `Error: expiry timestamp ${new Date(resolvedExpiresAt).toISOString()} is in the past`
            }]
          };
        }

        // Step 1 — Obtain JWT
        const jwt = await getTriggerJwt();

        // Step 2 — Get or register vault (cached)
        const vault = await getVaultCached(jwt);

        // Step 3 — Craft deposit (orderSubType must be 'oco')
        const deposit = await craftDeposit({
          jwt,
          inputMint,
          outputMint,
          userAddress: getSolanaPublicKey().toBase58(),
          amount: inputAmount,
          orderSubType: 'oco'
        });

        // Step 4 — Sign the deposit transaction
        const keypair = loadSolanaKeypair();
        const tx = VersionedTransaction.deserialize(
          Buffer.from(deposit.transaction, "base64")
        );
        tx.sign([keypair]);
        const depositSignedTx = Buffer.from(tx.serialize()).toString("base64");

        // Step 5 — Create the OCO order
        // Stop-loss leg defaults to 300 bps to avoid extreme fill prices;
        // take-profit leg passes undefined to use Jupiter's automatic slippage.
        const resolvedSlSlippageBps = slSlippageBps !== undefined ? slSlippageBps : 300;

        const order = await createOcoTriggerOrder({
          jwt,
          depositRequestId: deposit.requestId,
          depositSignedTx,
          userPubkey: getSolanaPublicKey().toBase58(),
          inputMint,
          inputAmount,
          outputMint,
          triggerMint,
          tpPriceUsd,
          slPriceUsd,
          tpSlippageBps,
          slSlippageBps: resolvedSlSlippageBps,
          expiresAt: resolvedExpiresAt,
        });

        // Format success response
        const expiryDate = new Date(resolvedExpiresAt);
        const tpSlippageDisplay = tpSlippageBps !== undefined ? `${tpSlippageBps} bps` : 'auto slippage';
        const slSlippageDisplay = slSlippageBps !== undefined ? `${slSlippageBps} bps` : '300 bps (default)';
        const lines = [
          "OCO order placed successfully.",
          `Order ID: ${order.id}`,
          `Take-profit: $${tpPriceUsd} (${tpSlippageDisplay})`,
          `Stop-loss: $${slPriceUsd} (${slSlippageDisplay})`,
          `Input: ${inputAmount} ${inputMint} (base units)`,
          `Output mint: ${outputMint}`,
          `Trigger mint: ${triggerMint}`,
          `Expires: ${expiryDate.toISOString()}`,
          `Deposit tx: ${order.txSignature}`,
          `Solscan: https://solscan.io/tx/${order.txSignature}`
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to place OCO order: ${errorMessage}` }],
        };
      }
    }
  );
}