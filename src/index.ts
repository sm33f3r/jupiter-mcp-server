import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerPriceTool } from "./tools/price.js";
import { registerTokensTool } from "./tools/tokens.js";
import { registerWalletTools } from "./tools/wallet.js";
import { registerSwapTools } from "./tools/swap.js";
import { registerTriggerTools } from "./tools/trigger.js";
import { registerPerpsTools } from "./tools/perps.js";

const server = new McpServer({
  name: "jupiter-mcp-server",
  version: "0.2.0",
});

server.registerTool(
  "echo",
  {
    description:
      "Echoes back the provided message. Trivial diagnostic tool for confirming the MCP stdio connection works.",
    inputSchema: {
      message: z.string().describe("The message to echo back."),
    },
  },
  async ({ message }) => {
    return {
      content: [
        {
          type: "text",
          text: `[jupiter-mcp-server echo] ${message}`,
        },
      ],
    };
  }
);

registerPriceTool(server);
registerTokensTool(server);
registerWalletTools(server);
registerSwapTools(server);
registerTriggerTools(server);
registerPerpsTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error running jupiter-mcp-server:", error);
  process.exit(1);
});
