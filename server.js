#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

// ─────────────────────────────────────────────────────────────────────────────
// Superhighway MCP server — web search for any MCP agent (Claude, etc.).
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
      "AGENT_PRIVATE_KEY is not set. Provide a funded Base wallet key so the server can pay per call in USDC."
    );
  }
  if (!payFetch) {
    const signer = await createSigner(NETWORK, PRIVATE_KEY);
    payFetch = wrapFetchWithPayment(fetch, signer);
  }
  return payFetch;
}

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query." },
    limit: { type: "number", description: "Max results, 1-20 (default 5)." },
  },
  required: ["query"],
};
const SCRAPE_SCHEMA = {
  type: "object",
  properties: { url: { type: "string", description: "The page URL to read (http/https)." } },
  required: ["url"],
};

const clampLimit = (v) => (Number.isFinite(v) ? Math.max(1, Math.min(20, Number(v))) : 5);

const TOOLS = [
  {
    name: "web_search",
    inputSchema: SEARCH_SCHEMA,
    description:
      "Real-time web search. Returns ranked organic results (title, url, snippet) as JSON " +
      "from a multi-engine metasearch. Paid per call in USDC via x402 — no signup, no API key. " +
      "Use for fresh facts, research, fact-checking, and grounding/RAG.",
    build: (a) => `/search?q=${encodeURIComponent(String(a.query ?? "").trim())}&limit=${clampLimit(a.limit)}`,
  },
  {
    name: "news_search",
    inputSchema: SEARCH_SCHEMA,
    description:
      "Real-time news search. Returns recent news articles (title, url, snippet, published date) " +
      "as JSON from a multi-engine news metasearch. Paid per call in USDC via x402 — no signup, " +
      "no API key. Use for current events, breaking news, monitoring, and time-sensitive facts.",
    build: (a) => `/news?q=${encodeURIComponent(String(a.query ?? "").trim())}&limit=${clampLimit(a.limit)}`,
  },
  {
    name: "scrape",
    inputSchema: SCRAPE_SCHEMA,
    description:
      "Read any web page as clean text + markdown. Give a URL, get back the page title, readable " +
      "markdown, and plain text. Paid per call in USDC via x402 — no signup, no API key. Use to let " +
      "the agent read pages, fetch articles/docs it can't access, scrape content, and feed RAG.",
    build: (a) => `/scrape?url=${encodeURIComponent(String(a.url ?? "").trim())}`,
  },
];

const server = new Server({ name: "superhighway", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const args = req.params.arguments ?? {};
  for (const key of tool.inputSchema.required) {
    if (!String(args[key] ?? "").trim()) {
      return { content: [{ type: "text", text: `Error: '${key}' is required.` }], isError: true };
    }
  }
  try {
    const pay = await getPayFetch();
    const res = await pay(`${BASE_URL}${tool.build(args)}`, { method: "GET" });
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
