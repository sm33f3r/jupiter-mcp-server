# Jupiter MCP Server

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent trade on [Jupiter](https://jup.ag), Solana's DEX aggregator: spot swaps, Trigger V2 limit and OCO orders, and Jupiter Perps through the on-chain program. It runs locally over stdio and signs transactions with **your own keypair** — the key never leaves your machine.

> **Warning:** this server moves real funds on Solana mainnet. Use a dedicated wallet, fund it only with what you can afford to lose, and make your first trades tiny.

## Why this server

It is built for **autonomous agents that sign their own trades**, including perpetuals.

|  | jupiter-mcp-server | Jupiter's hosted [Trading MCP](https://developers.jup.ag/docs/ai/trading-mcp) |
| --- | --- | --- |
| Hosting | Self-hosted, stdio | Hosted at `mcp.jup.ag`, HTTP |
| Signing | Signs locally with your keypair and submits | Returns unsigned transactions; your client must sign them |
| Perps | Yes — open, close and track positions on the Jupiter Perps program | Not covered |
| Coverage | Swaps, Trigger V2 single and OCO orders, perps, wallet, price, tokens | Broader: swap, trigger, recurring, lend, tokens, send, studio and more |

Use the hosted server if your client already handles signing and you do not need perps. Use this one if your agent should trade on its own.

## Tools

Eighteen tools. Those marked **Yes** sign and send a real transaction from the configured wallet.

| Tool | What it does | Sends a transaction |
| --- | --- | --- |
| `echo` | Connection check | No |
| `get_price` | USD prices from Jupiter Price API V3 | No |
| `search_token` | Token lookup by symbol, name or mint (Tokens API V2) | No |
| `get_wallet_address` | The configured wallet's address, or validates one you pass | No |
| `get_wallet_balances` | SOL and every SPL and Token-2022 balance, exact, with base units and decimals | No |
| `get_token_balance` | One token's balance by mint, summed across all its accounts | No |
| `get_swap_quote` | Swap quote from Jupiter Ultra | No |
| `execute_swap` | Executes a swap via Jupiter Ultra (`/order` then `/execute`) | **Yes** |
| `create_trigger_order` | Single limit order (take-profit, stop-loss, buy-below, buy-above) | **Yes** (deposit) |
| `create_oco_order` | Take-profit and stop-loss pair sharing one deposit | **Yes** (deposit) |
| `get_trigger_orders` | Active or past trigger orders | No |
| `update_trigger_order` | Changes trigger price or slippage on an open single order | No (API update) |
| `cancel_trigger_order` | Cancels an order and withdraws the funds | **Yes** (withdrawal) |
| `get_perp_positions` | Open perps positions with estimated PnL and liquidation price | No |
| `open_perp_position` | Submits a perps open request (SOL, ETH or BTC; long or short) | **Yes** |
| `open_perp_position_and_wait` | Opens, waits for the keeper, and cancels if still pending at timeout | **Yes** |
| `get_position_request_status` | Whether a perps request is pending or gone | No |
| `close_perp_position` | Submits a request to close an entire position | **Yes** |

All amounts are **whole numbers in base units** (lamports for SOL, 1 USDC = 1000000). Balance tools print base units and decimals so an agent can pass them straight through.

## Requirements

- **Node.js 20 or later.**
- **A Jupiter API key** from the [Jupiter Developer Platform](https://developers.jup.ag). Every Jupiter call needs it, including prices.
- **A Solana RPC endpoint.** A paid provider is strongly recommended: the public endpoint rate-limits heavily, and some calls this server uses (such as listing perps positions) are often blocked there.
- **A dedicated Solana wallet** for the agent, funded only with what you are prepared to lose.

## Install and build

```bash
git clone https://github.com/sm33f3r/jupiter-mcp-server.git
cd jupiter-mcp-server
npm ci
npm run build
```

The server entry point is `dist/index.js`. Your MCP client starts it as a child process and talks to it over stdio, so you never run it by hand in normal use.

To update later: `git pull`, `npm ci`, `npm run build`, then restart your MCP client.

## Configuration

All configuration comes from environment variables that your MCP client passes to the server. A template is in `.env.example`. The server reads no config file of its own and never writes your key anywhere.

| Variable | Required | What it is |
| --- | --- | --- |
| `JUPITER_API_KEY` | Yes | Your Jupiter API key |
| `SOLANA_RPC_URL` | Yes | Solana RPC endpoint URL. `HELIUS_RPC_URL` is accepted as a fallback. |
| `SOLANA_PRIVATE_KEY` | One of these two | The wallet's secret key: a base58 string, or a JSON array of 64 numbers (Solana CLI `id.json` format) |
| `SOLANA_KEYPAIR_PATH` | One of these two | Path to a keypair file in either format. Takes precedence over `SOLANA_PRIVATE_KEY`; a missing or invalid file is an error, never a silent fallback. |
| `MAX_LEVERAGE` | No | Refuse perps opens above this leverage. Off when unset. |
| `MAX_SLIPPAGE_BPS` | No | Refuse perps opens above this slippage, in basis points. Off when unset; never applies to closes. |

Read-only tools that do not need the RPC or the key still work when those are missing; the tools that need them return a clear error.

## Connect to an MCP client

Use the **absolute path** to `dist/index.js` in every example.

### Claude Desktop

Add to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "jupiter": {
      "command": "node",
      "args": ["/absolute/path/to/jupiter-mcp-server/dist/index.js"],
      "env": {
        "JUPITER_API_KEY": "your-jupiter-api-key",
        "SOLANA_RPC_URL": "https://your-rpc-endpoint",
        "SOLANA_KEYPAIR_PATH": "/absolute/path/to/agent-wallet.json"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add jupiter \
  -e JUPITER_API_KEY=your-jupiter-api-key \
  -e SOLANA_RPC_URL=https://your-rpc-endpoint \
  -e SOLANA_KEYPAIR_PATH=/absolute/path/to/agent-wallet.json \
  -- node /absolute/path/to/jupiter-mcp-server/dist/index.js
```

Check it with `claude mcp list`.

### Hermes Agent (Nous Research)

In Hermes's `config.yaml`, with the values supplied as environment variables of the Hermes process (Hermes substitutes `${VAR}`):

```yaml
mcp_servers:
  jupiter:
    command: node
    args:
      - /absolute/path/to/jupiter-mcp-server/dist/index.js
    env:
      JUPITER_API_KEY: ${JUPITER_API_KEY}
      SOLANA_RPC_URL: ${SOLANA_RPC_URL}
      SOLANA_PRIVATE_KEY: ${SOLANA_PRIVATE_KEY}
```

In a container, keep the built server on a persistent volume and rebuild it there after each `git pull`.

### Any other client

Any MCP client that launches stdio servers works: command `node`, argument the path to `dist/index.js`, and the environment variables above. Call `echo` first to confirm the connection.

## Using it safely

- **Units.** Every amount is a whole number in base units. Perps collateral is in the collateral token's units: SOL long in lamports (9 decimals), ETH or BTC long in 8-decimal base units (1 ETH = 100000000), and any short in USDC (6 decimals). The perps tools value the collateral in USD first and refuse collateral worth more than the position, which almost always means a units mistake.
- **Perps are two-phase.** Opening or closing submits a request; Jupiter's keeper then fills it or rejects it, usually within seconds. The tools say "submitted (NOT yet filled)" until a fill is confirmed. `open_perp_position_and_wait` reports FILLED only when the position size actually changed. Perps have no automatic stop-loss: liquidation is the only automatic exit, so the agent must monitor its positions.
- **Do not blindly retry.** If a transaction was sent but the result was lost, the tools say so, give the signature, and say "Do NOT retry yet". A retry could double a swap, a deposit or a perps position. Check balances, orders or positions first.
- **Optional limits.** `MAX_LEVERAGE` and `MAX_SLIPPAGE_BPS` are off by default. The library makes no trading decisions; set them if you want the server itself to refuse riskier opens. Closes are never capped, so an exit is not refused in a fast market.
- **Start tiny.** Make the first swap, the first order and the first perps open-and-close with the smallest amounts the protocol accepts.

## Security and key handling

- **This repository contains no keys.** Your key reaches the server only at runtime, from your environment or a file you point it to. Never commit a key, a filled-in `.env` file or a client config containing one.
- **Prefer `SOLANA_KEYPAIR_PATH`** with the file readable only by you (for example `chmod 600`) over pasting the key into a config file.
- **An agent with a shell can read its own environment.** If your agent framework gives the model a terminal in the same environment as this server, the model can read the key. Run the agent's shell in a separate sandbox if you need a hard boundary.
- **Use a dedicated wallet** for each agent, never your main wallet, and keep only trading capital in it.
- **Error messages never include key material.** If you report a bug, still check logs before sharing them.

Found a security issue? Please report it privately through GitHub's **Security → Report a vulnerability** on this repository rather than in a public issue.

## Known limitations

- **Perps estimates.** PnL and liquidation price in `get_perp_positions` are client-side estimates that ignore fees; real liquidation comes sooner.
- **Paths not yet verified against a live keeper:** the cancel-on-timeout branch of `open_perp_position_and_wait`, cancelling a stuck SOL-collateral request, and the RFQ path of `execute_swap`. They are covered by code review and unit checks only.
- **Trigger orders on native SOL** may require wrapped SOL; this has not been confirmed. Test with a small order first.
- **Not implemented:** Jupiter Recurring (DCA), adding or removing perps collateral, and OTOCO orders.

## Dependency advisories

`npm audit` reports advisories in the `@solana/web3.js` v1 dependency chain (`bigint-buffer`, `jayson` and related packages) and in Anchor 0.29's `toml` parser. None has a non-breaking fix; the long-term fix is migrating to `@solana/kit` and a newer Anchor IDL format. The MCP SDK's HTTP server code, where the critical advisories were, is never used: this server runs over stdio only.

## Contributing

Issues and pull requests are welcome. Keep the core rule: the server executes, the agent and its operator decide. Do not add hardcoded position sizing, leverage or trade direction, and never add anything that stores, logs or transmits key material.

## License

MIT. This software is provided as is, without warranty. You are responsible for every transaction your agent sends.
