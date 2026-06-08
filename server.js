#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

// ─────────────────────────────────────────────────────────────────────────────
// Superhighway MCP server — paid search tools for any MCP agent (Claude, etc.).
//
// The agent calls a tool; under the hood this server GETs Superhighway's paid
// endpoint, receives a 402, signs a USDC micro-payment with YOUR wallet
// (AGENT_PRIVATE_KEY) via x402, retries, and returns results. No API key, no signup.
//
// Config (env, via your MCP client):
//   AGENT_PRIVATE_KEY  a wallet you control, funded with a little USDC on Base
//   X402_NETWORK       "base" (default) | "base-sepolia" for testnet
//   SUPERHIGHWAY_URL   defaults to the hosted production endpoint
//
// MCP speaks over stdout/stdin — logs go to stderr only.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = (process.env.SUPERHIGHWAY_URL || "https://api-production-17e1.up.railway.app").replace(/\/+$/, "");
const NETWORK = process.env.X402_NETWORK || "base";
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;

let payFetch = null;
async function getPayFetch() {
  if (!PRIVATE_KEY) {
    throw new Error(
      "AGENT_PRIVATE_KEY is not set. Provide a funded Base wallet key so the server can pay $0.001/search in USDC."
    );
  }
  if (!payFetch) {
    const signer = await createSigner(NETWORK, PRIVATE_KEY);
    payFetch = wrapFetchWithPayment(fetch, signer);
  }
  return payFetch;
}

const TOOLS = [
  {
    name: "web_search",
    path: "/search",
    description:
      "Real-time web search. Returns ranked organic results (title, url, snippet) as JSON " +
      "from a multi-engine metasearch. Paid per call in USDC via x402 — no signup, no API key. " +
      "Use for fresh facts, research, fact-checking, and grounding/RAG.",
  },
  {
    name: "news_search",
    path: "/news",
    description:
      "Real-time news search. Returns recent news articles (title, url, snippet, published date) " +
      "as JSON from a multi-engine news metasearch. Paid per call in USDC via x402 — no signup, " +
      "no API key. Use for current events, breaking news, monitoring, and time-sensitive facts.",
  },
];

const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query." },
    limit: { type: "number", description: "Max results, 1-20 (default 5)." },
  },
  required: ["query"],
};

const server = new Server({ name: "superhighway", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const args = req.params.arguments ?? {};
  const query = String(args.query ?? "").trim();
  if (!query) {
    return { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true };
  }
  const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(20, Number(args.limit))) : 5;
  try {
    const pay = await getPayFetch();
    const url = `${BASE_URL}${tool.path}?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await pay(url, { method: "GET" });
    if (!res.ok) {
      const body = await res.text();
      return { content: [{ type: "text", text: `Request failed (${res.status}): ${body}` }], isError: true };
    }
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[superhighway-mcp] ready — tools: ${TOOLS.map((t) => t.name).join(", ")} · paying on ${NETWORK} via ${BASE_URL}`);
