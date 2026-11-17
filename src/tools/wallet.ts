import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { jupiterFetch } from "../client/jupiter.js";
import { getSolanaConnection, getSolanaPublicKey } from "../client/solana.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const LAMPORTS_PER_SOL = 1_000_000_000;

interface ParsedTokenInfo {
  mint: string;
  tokenAmount: { uiAmount: number | null };
}

async function resolveSymbol(mint: string): Promise<string> {
  try {
    const results = (await jupiterFetch("/tokens/v2/search", { query: mint })) as Array<{ symbol?: string }>;
    if (results.length > 0 && results[0].symbol) return results[0].symbol;
  } catch {
    // fall through to mint address silently
  }
  return mint;
}

export function registerWalletTools(server: McpServer): void {
  server.tool(
    "get_wallet_address",
    "Return the base58 public address of a Solana wallet. If address is provided, it is validated and echoed back (no RPC call needed). If omitted, returns the loaded wallet's address. Fast sanity-check.",
    {
      address: z.string().optional().describe("Optional base58 wallet address to validate/echo. Omit to use the loaded wallet."),
    },
    async ({ address }) => {
      try {
        if (address !== undefined) {
          const publicKey = new PublicKey(address);
          return { content: [{ type: "text", text: publicKey.toBase58() }] };
        }
        const publicKey = getSolanaPublicKey();
        return { content: [{ type: "text", text: publicKey.toBase58() }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  server.tool(
    "get_wallet_balances",
    "Return the SOL balance and all non-zero SPL token balances for a wallet (covers both the classic SPL Token program and Token-2022). If address is provided, queries that wallet; if omitted, uses the loaded wallet.",
    {
      address: z.string().optional().describe("Optional base58 wallet address to query. Omit to use the loaded wallet."),
    },
    async ({ address }) => {
      try {
        const connection = getSolanaConnection();
        const publicKey = address !== undefined ? new PublicKey(address) : getSolanaPublicKey();

        const [lamports, splAccounts, token2022Accounts] = await Promise.all([
          connection.getBalance(publicKey),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
        ]);

        const lines: string[] = [`SOL: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)}`];

        const allAccounts = [...splAccounts.value, ...token2022Accounts.value];
        const nonZero = allAccounts.filter((a) => {
          const info = (a.account.data as { parsed: { info: ParsedTokenInfo } }).parsed.info;
          return info.tokenAmount.uiAmount !== null && info.tokenAmount.uiAmount > 0;
        });

        if (nonZero.length === 0) {
          lines.push("No SPL token or Token-2022 balances found.");
        } else {
          for (const a of nonZero) {
            const info = (a.account.data as { parsed: { info: ParsedTokenInfo } }).parsed.info;
            const uiAmount = info.tokenAmount.uiAmount!;
            const symbol = await resolveSymbol(info.mint);
            lines.push(`${symbol} (${info.mint}): ${uiAmount.toFixed(6)}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );

  server.tool(
    "get_token_balance",
    "Return the balance of a specific SPL token in a wallet by mint address. If address is provided, checks that wallet; if omitted, uses the loaded wallet.",
    {
      mint: z.string().describe("Solana mint address of the token to check."),
      address: z.string().optional().describe("Optional base58 wallet address to check. Omit to use the loaded wallet."),
    },
    async ({ mint, address }) => {
      try {
        const connection = getSolanaConnection();
        const publicKey = address !== undefined ? new PublicKey(address) : getSolanaPublicKey();

        const tokenAccountsResult = await connection.getParsedTokenAccountsByOwner(publicKey, {
          mint: new PublicKey(mint),
        });

        if (tokenAccountsResult.value.length === 0) {
          return { content: [{ type: "text", text: `${mint}: zero balance (no token account found)` }] };
        }

        const info = (
          tokenAccountsResult.value[0].account.data as { parsed: { info: ParsedTokenInfo } }
        ).parsed.info;

        const uiAmount = info.tokenAmount.uiAmount;
        if (uiAmount === null || uiAmount === 0) {
          return { content: [{ type: "text", text: `${mint}: 0.000000` }] };
        }

        return { content: [{ type: "text", text: `${mint}: ${uiAmount.toFixed(6)}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }
  );
}
