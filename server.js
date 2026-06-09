#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

// ─────────────────────────────────────────────────────────────────────────────
// Superhighway MCP server — paid web tools for any MCP agent (Claude, etc.).
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
const GEOCODE_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Address or place to geocode (forward)." },
    lat: { type: "number", description: "Latitude for reverse geocoding (pair with lon)." },
    lon: { type: "number", description: "Longitude for reverse geocoding (pair with lat)." },
  },
  required: [],
};
const NLP_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: "The text to analyze." } },
  required: ["text"],
};
const EMAIL_SCHEMA = {
  type: "object",
  properties: { email: { type: "string", description: "The email address to verify." } },
  required: ["email"],
};
const CONVERT_SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string", description: "Source format: csv, json, md, or html." },
    to: { type: "string", description: "Target format: json, csv, html, md, or text." },
    data: { type: "string", description: "The content to convert." },
  },
  required: ["from", "to", "data"],
};
const QR_SCHEMA = {
  type: "object",
  properties: {
    data: { type: "string", description: "Text or URL to encode in the QR code." },
    format: { type: "string", description: "Output: 'svg' (default) or 'dataurl' (PNG data-URI)." },
  },
  required: ["data"],
};
const FEED_SCHEMA = {
  type: "object",
  properties: { url: { type: "string", description: "The RSS or Atom feed URL to parse." } },
  required: ["url"],
};
const SITEMAP_SCHEMA = {
  type: "object",
  properties: { url: { type: "string", description: "A sitemap URL or a site root (we will try /sitemap.xml)." } },
  required: ["url"],
};
const UNFURL_SCHEMA = {
  type: "object",
  properties: { url: { type: "string", description: "The page URL to unfurl into a link-preview card." } },
  required: ["url"],
};
const FX_SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string", description: "Base currency, 3-letter code (e.g. USD)." },
    to: { type: "string", description: "Target currency; omit to get all rates for the base." },
    amount: { type: "number", description: "Amount to convert (default 1)." },
  },
  required: ["from"],
};
const DNS_SCHEMA = {
  type: "object",
  properties: {
    host: { type: "string", description: "The hostname to resolve (e.g. example.com)." },
    type: { type: "string", description: "Record type: A (default), AAAA, MX, TXT, NS, CNAME, SOA." },
  },
  required: ["host"],
};
const HASH_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The text to hash." },
    algo: { type: "string", description: "md5, sha1, sha256 (default), sha384, sha512." },
    encoding: { type: "string", description: "hex (default), base64, base64url." },
  },
  required: ["text"],
};
const COLOR_SCHEMA = {
  type: "object",
  properties: {
    color: { type: "string", description: "A color: #ff0000, rgb(255,0,0), hsl(0,100%,50%), or a CSS name." },
  },
  required: ["color"],
};
const CASE_SCHEMA = {
  type: "object",
  properties: { text: { type: "string", description: "The text to convert into every case form." } },
  required: ["text"],
};
const BASE64_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The text to encode, or the base64 to decode." },
    op: { type: "string", description: "encode (default) or decode." },
    urlsafe: { type: "boolean", description: "Use url-safe base64." },
  },
  required: ["text"],
};
const JWT_SCHEMA = {
  type: "object",
  properties: { token: { type: "string", description: "The JWT to decode (signature is not verified)." } },
  required: ["token"],
};
const DIFF_SCHEMA = {
  type: "object",
  properties: {
    a: { type: "string", description: "The first (original) text." },
    b: { type: "string", description: "The second (changed) text." },
  },
  required: ["a", "b"],
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
  {
    name: "geocode",
    inputSchema: GEOCODE_SCHEMA,
    description:
      "Geocoding for AI agents. Forward: give 'query' (an address or place) → latitude, longitude, " +
      "and structured address. Reverse: give 'lat' and 'lon' → the address at that point. Paid per " +
      "call in USDC via x402 — no signup, no API key. Use to resolve locations and add coordinates.",
    build: (a) =>
      a.lat != null && a.lon != null
        ? `/geocode?lat=${encodeURIComponent(String(a.lat))}&lon=${encodeURIComponent(String(a.lon))}`
        : `/geocode?q=${encodeURIComponent(String(a.query ?? "").trim())}`,
  },
  {
    name: "nlp",
    inputSchema: NLP_SCHEMA,
    description:
      "Analyze text locally in one call: language detection, sentiment (positive/neutral/negative), " +
      "keyword extraction, and an extractive summary. Paid per call in USDC via x402 — no signup, no " +
      "API key. Use to triage, classify, or summarize text cheaply without a full LLM round-trip.",
    build: (a) => `/nlp?text=${encodeURIComponent(String(a.text ?? "").trim())}`,
  },
  {
    name: "email_verify",
    inputSchema: EMAIL_SCHEMA,
    description:
      "Verify an email address: checks syntax, whether the domain accepts mail (MX), and flags " +
      "disposable and role addresses → deliverable/risky/undeliverable. Paid per call in USDC via " +
      "x402 — no signup, no API key. Use to clean lists and qualify contacts before outreach.",
    build: (a) => `/email/verify?email=${encodeURIComponent(String(a.email ?? "").trim())}`,
  },
  {
    name: "convert",
    inputSchema: CONVERT_SCHEMA,
    description:
      "Convert data between formats: csv↔json, markdown→html, html→markdown, html→text. Paid per " +
      "call in USDC via x402 — no signup, no API key. Use as pipeline glue to transform formats.",
    build: (a) =>
      `/convert?from=${encodeURIComponent(String(a.from ?? "").trim())}&to=${encodeURIComponent(String(a.to ?? "").trim())}&data=${encodeURIComponent(String(a.data ?? ""))}`,
  },
  {
    name: "qr",
    inputSchema: QR_SCHEMA,
    description:
      "Generate a QR code from text or a URL → an SVG string or PNG data-URI. Paid per call in USDC " +
      "via x402 — no signup, no API key. Use to embed scannable codes in generated content or links.",
    build: (a) => `/qr?data=${encodeURIComponent(String(a.data ?? ""))}&format=${encodeURIComponent(String(a.format ?? "svg"))}`,
  },
  {
    name: "feed",
    inputSchema: FEED_SCHEMA,
    description:
      "Parse an RSS or Atom feed → its title and recent items (title, link, date, snippet) as JSON. " +
      "Paid per call in USDC via x402 — no signup, no API key. Use to monitor news, blogs, changelogs, and releases.",
    build: (a) => `/feed?url=${encodeURIComponent(String(a.url ?? "").trim())}`,
  },
  {
    name: "sitemap",
    inputSchema: SITEMAP_SCHEMA,
    description:
      "Fetch a websites sitemap → the list of page URLs as JSON (handles sitemap indexes; give a sitemap URL or a site root). " +
      "Paid per call in USDC via x402 — no signup, no API key. Use to map a sites pages before crawling, auditing, or research.",
    build: (a) => `/sitemap?url=${encodeURIComponent(String(a.url ?? "").trim())}`,
  },
  {
    name: "unfurl",
    inputSchema: UNFURL_SCHEMA,
    description:
      "Unfurl a URL into a link-preview card → title, description, hero image, site name, canonical URL, favicon, and type " +
      "(OpenGraph → Twitter Card → standard meta). Paid per call in USDC via x402 — no signup, no API key. Use to render link " +
      "previews and enrich URLs without downloading the whole page (lighter than scrape).",
    build: (a) => `/unfurl?url=${encodeURIComponent(String(a.url ?? "").trim())}`,
  },
  {
    name: "fx",
    inputSchema: FX_SCHEMA,
    description:
      "Currency conversion + exchange rates. Give 'from' + 'to' (+ optional 'amount') to convert at the latest ECB reference " +
      "rate, or just 'from' to get all of that currency's latest rates. Paid per call in USDC via x402 — no signup, no API key. " +
      "Use to price, convert, and reason about money across currencies mid-task.",
    build: (a) => {
      const from = encodeURIComponent(String(a.from ?? "").trim());
      const to = String(a.to ?? "").trim();
      const amt = a.amount != null ? `&amount=${encodeURIComponent(String(a.amount))}` : "";
      return to ? `/fx?from=${from}&to=${encodeURIComponent(to)}${amt}` : `/fx?from=${from}`;
    },
  },
  {
    name: "dns",
    inputSchema: DNS_SCHEMA,
    description:
      "DNS lookup. Give a hostname (+ optional record type A/AAAA/MX/TXT/NS/CNAME/SOA) → its DNS records as JSON. Paid per call " +
      "in USDC via x402 — no signup, no API key. Use for domain research, mail deliverability (MX), SPF/DKIM/DMARC (TXT), and " +
      "verifying where a name points.",
    build: (a) => {
      const host = encodeURIComponent(String(a.host ?? "").trim());
      const type = String(a.type ?? "").trim();
      return type ? `/dns?host=${host}&type=${encodeURIComponent(type)}` : `/dns?host=${host}`;
    },
  },
  {
    name: "hash",
    inputSchema: HASH_SCHEMA,
    description:
      "Hash text with a chosen algorithm (md5/sha1/sha256/sha384/sha512) and encoding (hex/base64/base64url) → the digest. " +
      "Paid per call in USDC via x402 — no signup, no API key. Use for content-addressing, dedup and cache/ETag keys, and " +
      "integrity checks.",
    build: (a) => {
      const text = `text=${encodeURIComponent(String(a.text ?? ""))}`;
      const algo = a.algo ? `&algo=${encodeURIComponent(String(a.algo))}` : "";
      const enc = a.encoding ? `&encoding=${encodeURIComponent(String(a.encoding))}` : "";
      return `/hash?${text}${algo}${enc}`;
    },
  },
  {
    name: "color",
    inputSchema: COLOR_SCHEMA,
    description:
      "Convert a color given as hex, rgb(), hsl(), or a CSS name → every representation (hex, rgb, hsl) plus the matching/nearest " +
      "CSS color name. Paid per call in USDC via x402 — no signup, no API key. Use for theming, design/UI generation, and " +
      "normalizing colors.",
    build: (a) => `/color?color=${encodeURIComponent(String(a.color ?? "").trim())}`,
  },
  {
    name: "case",
    inputSchema: CASE_SCHEMA,
    description:
      "Convert text to every case form: camelCase, PascalCase, snake_case, kebab-case, CONSTANT_CASE, slug, Title Case, " +
      "Sentence case, upper, lower. Paid per call in USDC via x402 — no signup, no API key. Use for code generation " +
      "(variable/field names), slugs, and normalizing identifiers.",
    build: (a) => `/case?text=${encodeURIComponent(String(a.text ?? ""))}`,
  },
  {
    name: "base64",
    inputSchema: BASE64_SCHEMA,
    description:
      "Base64 encode or decode. Encode text → base64 (standard or url-safe), or decode base64 → text. Paid per call in USDC " +
      "via x402 — no signup, no API key. Use for data URIs, transporting/embedding text, and decoding tokens or blobs.",
    build: (a) => {
      const text = `text=${encodeURIComponent(String(a.text ?? ""))}`;
      const op = a.op ? `&op=${encodeURIComponent(String(a.op))}` : "";
      const us = a.urlsafe ? `&urlsafe=true` : "";
      return `/base64?${text}${op}${us}`;
    },
  },
  {
    name: "jwt",
    inputSchema: JWT_SCHEMA,
    description:
      "Decode a JSON Web Token → its header + payload (claims) with readable iat/exp/nbf times and an expiry flag. Decodes " +
      "only — does NOT verify the signature. Paid per call in USDC via x402 — no signup, no API key. Use to inspect token " +
      "claims, scopes, and expiry.",
    build: (a) => `/jwt?token=${encodeURIComponent(String(a.token ?? "").trim())}`,
  },
  {
    name: "diff",
    inputSchema: DIFF_SCHEMA,
    description:
      "Line diff of two texts → the added/removed/unchanged counts, per-line ops, and a unified-diff string. Paid per call " +
      "in USDC via x402 — no signup, no API key. Use to compare versions, outputs, configs, or before/after.",
    build: (a) => `/diff?a=${encodeURIComponent(String(a.a ?? ""))}&b=${encodeURIComponent(String(a.b ?? ""))}`,
  },
];

const server = new Server({ name: "superhighway", version: "0.8.0" }, { capabilities: { tools: {} } });

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
