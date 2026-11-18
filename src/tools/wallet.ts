import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { jupiterFetch } from "../client/jupiter.js";
import { getSolanaConnection, getSolanaPublicKey } from "../client/solana.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const EXACT_NOTE =
  " Amounts are exact (not rounded) and include base units and decimals, ready to pass to swap/order tools.";

interface ParsedTokenInfo {
  mint: string;
  tokenAmount: { amount: string; decimals: number };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** Exact decimal string for a base-unit amount: no rounding, no float math. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const sign = negative ? "-" : "";
  if (decimals <= 0) return `${sign}${digits}`;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return `${sign}${whole}.${frac}`;
}

/** Sum parsed token accounts per mint; drops zero totals; preserves first-seen order. */
export function aggregateTokenAccounts(
  accounts: Array<{ account: { data: any } }>
): Array<{ mint: string; amount: bigint; decimals: number; accountCount: number }> {
  const byMint = new Map<string, { mint: string; amount: bigint; decimals: number; accountCount: number }>();
  for (const a of accounts) {
    const info = a.account.data.parsed.info as ParsedTokenInfo;
    const raw = BigInt(info.tokenAmount.amount);
    const existing = byMint.get(info.mint);
    if (existing) {
      existing.amount += raw;
      existing.accountCount += 1;
    } else {
      byMint.set(info.mint, {
        mint: info.mint,
        amount: raw,
        decimals: info.tokenAmount.decimals,
        accountCount: 1,
      });
    }
  }
  return [...byMint.values()].filter((e) => e.amount !== 0n);
}

async function resolveSymbol(mint: string): Promise<string> {
  try {
    const results = (await jupiterFetch("/tokens/v2/search", { query: mint })) as Array<{
      id?: string;
      address?: string;
      mint?: string;
      symbol?: string;
    }>;
    const match = results.find((r) => r.id === mint || r.address === mint || r.mint === mint);
    if (match && match.symbol) return match.symbol;
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
        return { content: [{ type: "text", text: `Error: ${describeError(e)}` }] };
      }
    }
  );

  server.tool(
    "get_wallet_balances",
    "Return the SOL balance and all non-zero SPL token balances for a wallet (covers both the classic SPL Token program and Token-2022). If address is provided, queries that wallet; if omitted, uses the loaded wallet." + EXACT_NOTE,
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

        const lines: string[] = [`SOL: ${formatBaseUnits(BigInt(lamports), 9)} (lamports: ${lamports})`];

        const tokens = aggregateTokenAccounts([...splAccounts.value, ...token2022Accounts.value]);

        if (tokens.length === 0) {
          lines.push("No SPL token or Token-2022 balances found.");
        } else {
          for (const t of tokens) {
            const symbol = await resolveSymbol(t.mint);
            const accountsNote = t.accountCount > 1 ? `, ${t.accountCount} accounts` : "";
            lines.push(
              `${symbol} (${t.mint}): ${formatBaseUnits(t.amount, t.decimals)} (base units: ${t.amount}, decimals: ${t.decimals}${accountsNote})`
            );
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${describeError(e)}` }] };
      }
    }
  );

  server.tool(
    "get_token_balance",
    "Return the balance of a specific SPL token in a wallet by mint address. If address is provided, checks that wallet; if omitted, uses the loaded wallet." + EXACT_NOTE,
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

        const accounts = tokenAccountsResult.value;
        const decimals = (accounts[0].account.data as { parsed: { info: ParsedTokenInfo } }).parsed.info.tokenAmount
          .decimals;
        let total = 0n;
        for (const a of accounts) {
          total += BigInt((a.account.data as { parsed: { info: ParsedTokenInfo } }).parsed.info.tokenAmount.amount);
        }
        const accountsNote = accounts.length > 1 ? `, ${accounts.length} accounts` : "";
        return {
          content: [
            {
              type: "text",
              text: `${mint}: ${formatBaseUnits(total, decimals)} (base units: ${total}, decimals: ${decimals}${accountsNote})`,
            },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${describeError(e)}` }] };
      }
    }
  );
}
