# superhighway-mcp

**Web search for AI agents that pays for itself.**

An MCP server that gives any MCP-speaking agent (Claude Desktop, etc.) a real-time
web search tool. Under the hood it pays [Superhighway](https://api-production-17e1.up.railway.app)
**$0.001 per search in USDC** via the [x402](https://x402.org) protocol, using *your*
wallet — no API key, no signup, no human in the loop.

## Install

Add to your MCP client config (e.g. Claude Desktop's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "superhighway": {
      "command": "npx",
      "args": ["-y", "github:patwalls/superhighway-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0xYOUR_FUNDED_BASE_WALLET_KEY",
        "X402_NETWORK": "base"
      }
    }
  }
}
```

Restart your client. The agent now has three tools that do the whole search job — **web_search** (live, ranked results), **news_search** (recent articles with dates), and **scrape** (read any URL as clean markdown). Find it, read it, pay per call.

## Wallet

`AGENT_PRIVATE_KEY` is a wallet you control, funded with a little **USDC on Base**
(each search costs $0.001; gas is covered by the facilitator, so you don't need ETH).
The key only ever signs tiny USDC payments — keep it to a small balance.

Want to try free first? Set `X402_NETWORK=base-sepolia` and fund the wallet from a
[Base Sepolia faucet](https://faucet.circle.com) to pay in test USDC.

## What you get

`web_search` (web) and `news_search` (recent news) each return results as JSON:

```json
{ "query": "...", "count": 5, "results": [ { "title": "...", "url": "...", "description": "..." } ] }
```

---

Powered by [Superhighway](https://api-production-17e1.up.railway.app) — the web-search API agents pay for.
