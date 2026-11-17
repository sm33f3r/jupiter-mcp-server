import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jupiterFetch } from "../client/jupiter.js";

const SOL_MINT  = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP_MINT  = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

interface PriceEntry {
  usdPrice: number;
  priceChange24h?: number;
  blockId?: number;
  decimals?: number;
  liquidity?: number;
  createdAt?: string;
}

type PriceResponse = Record<string, PriceEntry>;

export function registerPriceTool(server: McpServer): void {
  server.tool(
    "get_price",
    "Fetch the current USD price for one or more Solana tokens by mint address.",
    {
      mints: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("One or more Solana mint addresses to fetch USD prices for."),
    },
    async ({ mints }) => {
      const result = (await jupiterFetch("/price/v3", {
        ids: mints.join(","),
      })) as PriceResponse;

      const lines = mints.map((mint) => {
        const entry = result[mint];
        if (!entry) {
          return `${mint}: price unavailable`;
        }
        const change = entry.priceChange24h !== undefined
          ? `${entry.priceChange24h >= 0 ? "+" : ""}${entry.priceChange24h.toFixed(2)}%`
          : "n/a";
        return `${mint}: $${entry.usdPrice.toFixed(4)} (24h change: ${change})`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );
}