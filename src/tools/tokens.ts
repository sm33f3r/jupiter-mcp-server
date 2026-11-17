import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jupiterFetch } from "../client/jupiter.js";

interface TokenEntry {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
}

export function registerTokensTool(server: McpServer): void {
  server.registerTool(
    "search_token",
    {
      description: "Search for Solana tokens by symbol, name, or mint address.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Token symbol, name, or mint address to search for. Examples: 'SOL', 'USDC', 'Jupiter', or a full mint address."
          ),
      },
    },
    async ({ query }) => {
      const raw = await jupiterFetch("/tokens/v2/search", { query });
      const tokens = (raw as TokenEntry[]).slice(0, 5);

      if (tokens.length === 0) {
        return {
          content: [{ type: "text", text: `No tokens found for query: ${query}` }],
        };
      }

      const blocks = tokens.map((token) => {
        const tags =
          token.tags && token.tags.length > 0 ? token.tags.join(", ") : "none";
        return [
          `${token.name} (${token.symbol})`,
          `  Mint: ${token.id}`,
          `  Decimals: ${token.decimals}`,
          `  Tags: ${tags}`,
        ].join("\n");
      });

      return {
        content: [{ type: "text", text: blocks.join("\n\n") }],
      };
    }
  );
}
