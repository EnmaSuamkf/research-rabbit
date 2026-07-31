// ResearchRabbit Copilot MCP server.
// Exposes the REST gateway as 22 MCP tools over the Streamable HTTP transport,
// so a Flowise agent or Claude Code can call them.
//
// Run:  node index.js   (or: GATEWAY_URL=http://localhost:8821 MCP_PORT=8822 node index.js)
// Listens on http://localhost:8822/mcp  (Streamable HTTP, stateless).
//
// Camino B — per-user ResearchRabbit credentials:
//   A client (Claude Code / Cursor / Windsurf / VS Code) may send request
//   headers on every POST /mcp:
//     X-RR-Token:      the JWT sessionToken from app.researchrabbit.ai
//                      (SPA localStorage: tokens → sessionToken)
//     X-RR-Project-Id: the user's projectId (optional — the gateway can
//                      auto-discover it via GET /projects)
//   The server reads them once per request, closes them over a fresh server
//   instance (stateless: one createServer(credCtx) per request — race-free),
//   and forwards them to the gateway, which upgrades that single call to the
//   rr backend with that session. No credential is stored here. See
//   .mcp.json "headers" in site/index.html for the client config.
//
// Mirrors firsttable-mcp-server: a TOOLS array of {name, description, inputSchema, call},
// a gw(method, path, query, body, ctx) helper returning {status, ok, data}, GET / as a
// JSON descriptor, POST /mcp stateless, GET /mcp -> 405, a plain POST /mcp without the
// Accept: application/json, text/event-stream header -> 406 (from the SDK).
// PORT wins over MCP_PORT so Render can inject PORT.

const express = require("express");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:8821";
const PORT = Number(process.env.PORT || process.env.MCP_PORT || 8822);

// ---------------------------------------------------------------------------
// Tool catalogue: 22 tools (12 on, 8 off, 2 write). Each maps to one gateway
// endpoint. `seeds` take TITLES or DOIs — never invent numeric ids.
// Each `call(args, ctx)` forwards the per-request ResearchRabbit credential
// (ctx = {token, projectId}) to gw(), which adds X-RR-Token / X-RR-Project-Id
// headers on the gateway call. ctx may be empty ({}) for anonymous (openalex) use.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "search_keyword",
    description:
      "Find candidate seed papers from a topic, phrase, or DOI. Title + abstract matching. " +
      "Use this FIRST when the user describes a topic but has not named specific papers. " +
      "Returns ranked papers, each with articleId, title, authors, year, venue, doi, citedBy, seedHits and citationsPerYear.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Topic / phrase / DOI to search for" },
        per: { type: "number", description: "Max results (default 5, max 20)" },
      },
      required: ["q"],
    },
    call: (a, ctx) => gw("POST", "/api/search/keyword", null, { q: a.q, per: a.per ?? 5 }, ctx),
  },
  {
    name: "search_similar",
    description:
      "Similar Work — every connection type around the seed papers (references + cited-by + related). " +
      "The widest net. Pass 1-5 seed papers by TITLE or DOI (the gateway resolves them to ids) — never invent a numeric id. " +
      "Returns ranked papers with doi, year, citedBy, seedHits (how many seeds connect) and a reason.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, description: "Paper titles or DOIs, 1-5 of them" },
        sinceYear: { type: "number", description: "Optional: only papers from this year onward" },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
      required: ["seeds"],
    },
    call: (a, ctx) => gw("POST", "/api/search/network", null, { seeds: a.seeds, edgeMode: "both", sinceYear: a.sinceYear, per: a.limit ?? 10 }, ctx),
  },
  {
    name: "search_earlier_work",
    description:
      "Find the papers the seed papers BUILT ON (their references / Earlier Work / backward edges). " +
      "Use this for foundations, prior art, or 'where did this idea come from?'. " +
      "Pass seeds by TITLE or DOI. Returns ranked earlier papers with doi, year, citedBy and seedHits.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, description: "Paper titles or DOIs, 1-5 of them" },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
      required: ["seeds"],
    },
    call: (a, ctx) => gw("POST", "/api/search/network", null, { seeds: a.seeds, edgeMode: "backward", per: a.limit ?? 10 }, ctx),
  },
  {
    name: "search_later_work",
    description:
      "Find papers published AFTER the seed papers that CITE them (Later Work / Cited By / forward edges). " +
      "Use this for 'what is new?', 'state of the art', or 'what happened since this paper came out?'. " +
      "Pass seeds by TITLE or DOI. Optional sinceYear to focus on recent work. Returns ranked later papers with doi, year, citedBy and seedHits.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, description: "Paper titles or DOIs, 1-5 of them" },
        sinceYear: { type: "number", description: "Optional: only papers from this year onward" },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
      required: ["seeds"],
    },
    call: (a, ctx) => gw("POST", "/api/search/network", null, { seeds: a.seeds, edgeMode: "forward", sinceYear: a.sinceYear, per: a.limit ?? 10 }, ctx),
  },
  {
    name: "expand_frontier",
    description:
      "Run N iterations of network search server-side and return deduped, consensus-ranked candidates — the 'Grow and go!' loop in one call. " +
      "Use this when the user wants a broad shortlist fast. Pass seeds by TITLE or DOI. Each result has seedHits (consensus across the seeds) and citationsPerYear.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, description: "Paper titles or DOIs, 1-5 of them" },
        iterations: { type: "number", description: "Network expansion iterations (default 2, max 4)" },
        limit: { type: "number", description: "Max results (default 10, max 20)" },
      },
      required: ["seeds"],
    },
    call: (a, ctx) => gw("POST", "/api/expand", null, { seeds: a.seeds, iterations: a.iterations ?? 2, limit: a.limit ?? 10 }, ctx),
  },
  {
    name: "get_article",
    description:
      "Full metadata for ONE paper by id, DOI, or title: abstract, authors with h-index, citation counts, references count, retraction flag, doctype, venue. " +
      "Use this to read a paper the user named, or to verify a candidate before recommending it. Accepts a DOI (e.g. 10.1016/...), an OpenAlex id (W...), or a title.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "OpenAlex id (W...), DOI (10.…), or title" } },
      required: ["id"],
    },
    call: (a, ctx) => gw("GET", `/api/articles/${encodeURIComponent(a.id)}`, null, null, ctx),
  },
  {
    name: "rank_candidates",
    description:
      "Re-rank a candidate set by seed-consensus (default), recency, citations-per-year, or raw citations, and return a human-readable reason per item. " +
      "Use this after search_similar / expand_frontier / search_later_work to order a shortlist and justify it. " +
      "Pass `items` (the candidate objects from a prior search, or ids/titles) and optionally the original `seeds` to recompute seedHits.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object" }, description: "Candidate items (from a prior search) or {id|doi|title} objects" },
        seeds: { type: "array", items: { type: "string" }, description: "Original seed titles/DOIs to recompute seedHits against" },
        sortBy: { type: "string", description: "seedConsensus (default) | recency | citationsPerYear | citations" },
      },
      required: ["items"],
    },
    call: (a, ctx) => gw("POST", "/api/rank", null, { items: a.items, seeds: a.seeds, sortBy: a.sortBy }, ctx),
  },
  {
    name: "credibility_check",
    description:
      "Structured 'should I trust this paper?' triage: retraction flag, doctype, venue, citation counts, citations-per-year, first-author h-index, with explicit caveats. " +
      "Use this before endorsing a paper, especially one found via a broad search. Pass an id, DOI, or title.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "OpenAlex id (W...), DOI, or title (provide one of id/doi/title)" },
        doi: { type: "string", description: "DOI" },
        title: { type: "string", description: "Title" },
      },
    },
    call: (a, ctx) => gw("POST", "/api/credibility", null, { id: a.id, doi: a.doi, title: a.title }, ctx),
  },
  {
    name: "resolve_article",
    description:
      "Resolve a paper TITLE or DOI to a stable articleId (and doi + confidence). The anti-hallucination keystone — call this whenever you only have a title from an earlier turn, " +
      "before using it as a seed, so you never pass a wrong or fabricated id to search_similar / search_later_work / expand_frontier.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "A paper title or DOI" } },
      required: ["query"],
    },
    call: (a, ctx) => gw("POST", "/api/resolve", null, { query: a.query }, ctx),
  },
  {
    name: "create_research_session",
    description:
      "Create a ResearchRabbit search session and its first step from a seed set (rr backend only). " +
      "On the openalex backend this returns a structured 'not available' message. Pass seeds by TITLE or DOI.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, description: "Paper titles or DOIs, 1-5 of them" },
        title: { type: "string", description: "Optional session title" },
      },
      required: ["seeds"],
    },
    call: (a, ctx) => gw("POST", "/api/sessions", null, { seeds: a.seeds, title: a.title }, ctx),
  },
  {
    name: "update_session_step",
    description:
      "Point a ResearchRabbit session step at a search or inspected article, so the app opens exactly where the chat left off (rr backend only). " +
      "Requires sessionId, stepId, and a step payload. On openalex returns a structured 'not available' message.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from create_research_session" },
        stepId: { type: "string", description: "Step id to update" },
        step: { type: "object", description: "Step update payload (e.g. {searchId, articleId, label})" },
      },
      required: ["sessionId", "stepId"],
    },
    call: (a, ctx) => gw("PATCH", `/api/sessions/${encodeURIComponent(a.sessionId)}/steps/${encodeURIComponent(a.stepId)}`, null, { step: a.step }, ctx),
  },
  {
    name: "build_session_link",
    description:
      "Return the ResearchRabbit deep link app.researchrabbit.ai/search/{sessionId}/{stepIndex} — the hand-off to the app, like a booking URL (rr backend only). " +
      "On the openalex backend it returns a structured 'not available' message plus an OpenAlex search URL fallback when you pass a query. " +
      "Give the user this link (or the fallback) so they can continue in the ResearchRabbit app.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from create_research_session" },
        stepIndex: { type: "number", description: "Step index to open (0-based)" },
        query: { type: "string", description: "Optional topic, for an OpenAlex search URL fallback on the openalex backend" },
      },
      required: ["sessionId"],
    },
    call: (a, ctx) => gw("POST", "/api/session-link", null, { sessionId: a.sessionId, stepIndex: a.stepIndex, query: a.query }, ctx),
  },
  {
    name: "get_search_results",
    description:
      "Re-read a previous search by id (rr backend). On the openalex backend this is treated as a fetch-by-id (alias of get_article): pass an OpenAlex id, DOI, or title.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Search id (rr) or article id/DOI/title (openalex)" } },
      required: ["id"],
    },
    call: (a, ctx) => gw("GET", `/api/searches/${encodeURIComponent(a.id)}`, null, null, ctx),
  },
  {
    name: "get_research_session",
    description:
      "Read a ResearchRabbit session and its ordered steps (rr backend only). On openalex returns a structured 'not available' message.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Session id" } },
      required: ["id"],
    },
    call: (a, ctx) => gw("GET", `/api/sessions/${encodeURIComponent(a.id)}`, null, null, ctx),
  },
  {
    name: "search_by_author",
    description:
      "Find papers by an author, or by author ids. Pass a name (the gateway searches authors and returns their works) or authorIds. " +
      "Returns the author(s) with h-index and a list of their works (ranked by citations).",
    inputSchema: {
      type: "object",
      properties: {
        authorName: { type: "string", description: "Author name (e.g. 'Carly Ziter')" },
        authorIds: { type: "array", items: { type: "string" }, description: "Author ids (optional, instead of name)" },
        per: { type: "number", description: "Max works (default 10, max 20)" },
      },
    },
    call: (a, ctx) => gw("POST", "/api/search/author", null, { name: a.authorName, authorIds: a.authorIds, per: a.per ?? 10 }, ctx),
  },
  {
    name: "screen_articles",
    description:
      "Filter a candidate set by year range, doctype, minimum citations, and/or exclude retracted papers. " +
      "Pass `items` (candidate objects from a prior search) or `ids` (article ids/DOIs). Returns the subset that passes, in the same shape.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object" }, description: "Candidate items from a prior search" },
        ids: { type: "array", items: { type: "string" }, description: "Article ids or DOIs" },
        yearMin: { type: "number", description: "Earliest publication year" },
        yearMax: { type: "number", description: "Latest publication year" },
        doctype: { type: "string", description: "e.g. 'article', 'review'" },
        minCitations: { type: "number", description: "Minimum citation count" },
        excludeRetracted: { type: "boolean", description: "Drop retracted papers (default false)" },
      },
    },
    call: (a, ctx) => gw("POST", "/api/screen", null, {
      items: a.items, ids: a.ids, yearMin: a.yearMin, yearMax: a.yearMax,
      doctype: a.doctype, minCitations: a.minCitations, excludeRetracted: a.excludeRetracted,
    }, ctx),
  },
  {
    name: "export_bibtex",
    description:
      "Export a set of papers to BibTeX text, ready to paste into Zotero. Pass `ids` (OpenAlex ids) or `dois`. Returns a `bibtex` string with one @article entry per paper.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "OpenAlex ids (W...)" },
        dois: { type: "array", items: { type: "string" }, description: "DOIs" },
      },
    },
    call: (a, ctx) => gw("POST", "/api/export/bibtex", null, { ids: a.ids, dois: a.dois }, ctx),
  },
  {
    name: "find_gaps",
    description:
      "Find well-connected papers in the local network that the user's collection does NOT contain (rr/collection only). " +
      "On the openalex backend this returns a structured 'not available' message — use expand_frontier for a similar 'what am I missing?' exploration.",
    inputSchema: {
      type: "object",
      properties: {
        seeds: { type: "array", items: { type: "string" }, description: "Seed titles/DOIs" },
        collectionId: { type: "string", description: "Collection to compare against (rr)" },
      },
    },
    call: (a, ctx) => gw("POST", "/api/gaps", null, { seeds: a.seeds, collectionId: a.collectionId }, ctx),
  },
  {
    name: "list_collections",
    description:
      "List the user's ResearchRabbit folders with item counts and colours (rr backend only). On openalex returns a structured 'not available' message.",
    inputSchema: { type: "object", properties: {} },
    call: (_a, ctx) => gw("GET", "/api/collections", null, null, ctx),
  },
  {
    name: "list_library",
    description:
      "List the user's saved articles (the ResearchRabbit library). On openalex returns a structured 'not available' message.",
    inputSchema: { type: "object", properties: {} },
    call: (_a, ctx) => gw("GET", "/api/library", null, null, ctx),
  },
  {
    name: "create_collection",
    description:
      "Create a ResearchRabbit folder/collection with a name and optional colour. WRITE — requires RR_ALLOW_WRITES=true on the gateway (returns 403 otherwise) and the rr backend. " +
      "On openalex returns a structured 'not available' message. Never ask the user for ResearchRabbit credentials in the chat.",
    inputSchema: {
      type: "object",
      properties: {
        collectionName: { type: "string", description: "Collection name" },
        color: { type: "string", description: "Optional colour" },
      },
      required: ["collectionName"],
    },
    call: (a, ctx) => gw("POST", "/api/collections", null, { name: a.collectionName, color: a.color }, ctx),
  },
  {
    name: "save_articles",
    description:
      "Save a shortlist of articles into a ResearchRabbit collection. WRITE — requires RR_ALLOW_WRITES=true on the gateway (returns 403 otherwise) and the rr backend. " +
      "Pass `ids` (OpenAlex ids or DOIs) and an optional `collectionId`. On openalex returns a structured 'not available' message.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Article ids or DOIs to save" },
        collectionId: { type: "string", description: "Target collection id (optional)" },
      },
      required: ["ids"],
    },
    call: (a, ctx) => gw("POST", "/api/library/save", null, { ids: a.ids, collectionId: a.collectionId }, ctx),
  },
];

// ---------------------------------------------------------------------------
// Gateway helper — returns { status, ok, data }
// ctx = { token, projectId } (Camino B). Forwarded as X-RR-Token /
// X-RR-Project-Id so the gateway can upgrade this single call to the rr backend
// with the caller's own ResearchRabbit session (JWT Bearer). Empty ctx =>
// anonymous (openalex).
// ---------------------------------------------------------------------------
async function gw(method, path, query, body, ctx) {
  const url = new URL(GATEWAY + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (ctx && ctx.token) headers["X-RR-Token"] = String(ctx.token);
  if (ctx && ctx.projectId) headers["X-RR-Project-Id"] = String(ctx.projectId);
  const init = { method, headers };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(url.toString(), init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, ok: res.ok, data: parsed };
}

// ---------------------------------------------------------------------------
// MCP server factory (stateless: one server per request). credCtx is closed
// over so tool calls forward the caller's ResearchRabbit credential without any
// module-level mutable state (safe under concurrent requests).
// ---------------------------------------------------------------------------
function createServer(credCtx) {
  const server = new Server(
    { name: "researchrabbit-copilot", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    try {
      const result = await tool.call(args || {}, credCtx);
      const text = JSON.stringify(result.data, null, 2);
      return {
        isError: !result.ok,
        content: [
          { type: "text", text: result.ok ? text : `HTTP ${result.status}: ${text}` },
        ],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool error: ${e.message}` }],
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Express app with the Streamable HTTP endpoint
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) =>
  res.json({
    name: "ResearchRabbit Copilot MCP server",
    transport: "streamable-http (stateless)",
    endpoint: "POST /mcp",
    gateway: GATEWAY,
    tools: TOOLS.map((t) => t.name),
    perRequestAuth:
      "Camino B — send X-RR-Token (+ optional X-RR-Project-Id) headers on POST /mcp to use your own ResearchRabbit session (JWT forwarded to the gateway). Omit them for the anonymous openalex backend.",
  })
);

app.post("/mcp", async (req, res) => {
  // Camino B: read the caller's ResearchRabbit credential from request headers.
  // Headers are case-insensitive via req.get(); values are kept only for this
  // request's server instance — never stored.
  const credCtx = {
    token: req.get("X-RR-Token") || null,
    projectId: req.get("X-RR-Project-Id") || null,
  };
  const server = createServer(credCtx);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (e) {
    console.error("[mcp] request error:", e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) =>
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }))
);
app.delete("/mcp", (_req, res) =>
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }))
);

app.listen(PORT, () => {
  console.log(`ResearchRabbit MCP server listening on http://localhost:${PORT}/mcp`);
  console.log(`Gateway: ${GATEWAY} | tools: ${TOOLS.length} | per-request RR auth: on (X-RR-Token / X-RR-Project-Id)`);
});
