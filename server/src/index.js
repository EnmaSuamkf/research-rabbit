// ResearchRabbit Copilot gateway (researchrabbit-copilot-server).
// REST gateway in front of the research backend. The LLM never talks to the
// upstream API directly; every endpoint returns small, flat, already-decided
// §7 objects. Mirrors firsttable-server idioms: express + cors + express.json,
// a `wrap(fn)` async helper, GET / as a JSON endpoint descriptor, GET /api/health.
//
// Run:  node --env-file=.env src/index.js   (Node 20+ native fetch, no dotenv)
// Listens on http://localhost:8821  (PORT wins; default 8821)

const express = require("express");
const cors = require("cors");

const openalex = require("./adapters/openalex");
const rr = require("./adapters/rr");

const BACKEND = (process.env.RR_BACKEND || "openalex").toLowerCase();
const adapter = BACKEND === "rr" ? rr : openalex;

const PORT = process.env.PORT || 8821;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true }));
app.use(express.json());
// request logging (helps confirm MCP / Flowise calls reach us)
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

// ---- helpers ----------------------------------------------------------------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function writesAllowed() {
  return process.env.RR_ALLOW_WRITES === "true";
}

// Send an adapter result. null -> 404; structured {ok:false,...} "not available"
// messages are returned at 200 so the agent can read them; real upstream
// failures throw and hit the error handler.
function send(res, result) {
  if (result === null || result === undefined) {
    return res.status(404).json({ ok: false, backend: BACKEND, error: "Not found" });
  }
  res.json(result);
}

// 403 gate for the two write endpoints (create_collection / save_articles).
function writeGate(req, res) {
  if (!writesAllowed()) {
    res.status(403).json({
      ok: false,
      backend: BACKEND,
      error: "Writes are disabled. Set RR_ALLOW_WRITES=true to enable create_collection / save_articles.",
    });
    return true;
  }
  return false;
}

// ---- descriptor + health ----------------------------------------------------

app.get("/", (_req, res) => {
  res.json({
    name: "ResearchRabbit Copilot gateway",
    backend: BACKEND,
    endpoints: [
      "GET  /api/health",
      "GET  /api/context",
      "POST /api/search/keyword            {q, per?}",
      "POST /api/search/network            {seeds, edgeMode:both|backward|forward, sinceYear?, per?}",
      "POST /api/search/author             {name? | authorIds?, per?}",
      "POST /api/expand                    {seeds, iterations, limit}",
      "GET  /api/articles/:idOrDoi          (id, DOI, or title)",
      "POST /api/resolve                   {query}",
      "POST /api/screen                    {ids?|items?, yearMin?, yearMax?, doctype?, minCitations?, excludeRetracted?}",
      "POST /api/credibility               {id|doi|title}",
      "POST /api/rank                      {items, seeds?, sortBy?}",
      "POST /api/sessions                  {seeds, ...}            [rr only]",
      "GET  /api/sessions/:id                                      [rr only]",
      "PATCH /api/sessions/:id/steps/:stepId                      [rr only]",
      "POST /api/session-link                {sessionId, stepIndex, query?} [rr only]",
      "GET  /api/collections                                      [rr only]",
      "POST /api/collections                {name, color?}          [rr only, write]",
      "POST /api/library/save               {ids, collectionId?}   [rr only, write]",
      "GET  /api/library                                           [rr only]",
      "GET  /api/recent                                            [rr only]",
      "GET  /api/readings                                         [rr only]",
      "POST /api/export/bibtex              {ids?|dois?}",
      "POST /api/gaps                                             [rr only]",
      "GET  /api/searches/:id                                     (alias of get_article on openalex)",
    ],
  });
});

app.get("/api/health", (_req, res) => res.json(adapter.health()));
app.get("/api/context", (_req, res) => res.json(adapter.context()));
app.get("/api/_cache", (_req, res) => res.json({ backend: BACKEND, cache: adapter.cacheStats() }));

// ---- search -----------------------------------------------------------------

app.post("/api/search/keyword", wrap(async (req, res) => {
  const { q, per } = req.body || {};
  if (!q) return res.status(400).json({ ok: false, backend: BACKEND, error: "q is required" });
  send(res, await adapter.searchKeyword({ q, per }));
}));

app.post("/api/search/network", wrap(async (req, res) => {
  const { seeds, edgeMode, sinceYear, per } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "seeds (titles or DOIs) are required" });
  }
  send(res, await adapter.searchNetwork({ seeds, edgeMode, sinceYear, per }));
}));

app.post("/api/search/author", wrap(async (req, res) => {
  const { name, authorIds, per } = req.body || {};
  if (!name && !(Array.isArray(authorIds) && authorIds.length)) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "name or authorIds is required" });
  }
  send(res, await adapter.searchAuthor({ name, authorIds, per }));
}));

app.post("/api/expand", wrap(async (req, res) => {
  const { seeds, iterations, limit } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "seeds (titles or DOIs) are required" });
  }
  send(res, await adapter.expand({ seeds, iterations, limit }));
}));

// ---- article / resolution ---------------------------------------------------

// Wildcard so a DOI with a slash works whether the slash is encoded (%2F) or not.
app.get("/api/articles/*", wrap(async (req, res) => {
  const idOrDoi = decodeURIComponent(req.params[0] || "");
  if (!idOrDoi) return res.status(400).json({ ok: false, backend: BACKEND, error: "id, DOI, or title is required" });
  send(res, await adapter.getArticle(idOrDoi));
}));

app.post("/api/resolve", wrap(async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, backend: BACKEND, error: "query is required" });
  send(res, await adapter.resolve({ query }));
}));

// ---- derived: screen / credibility / rank ----------------------------------

app.post("/api/screen", wrap(async (req, res) => {
  const { ids, items, yearMin, yearMax, doctype, minCitations, excludeRetracted } = req.body || {};
  if (!(Array.isArray(ids) && ids.length) && !(Array.isArray(items) && items.length)) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "ids or items are required" });
  }
  send(res, await adapter.screen({ ids, items, yearMin, yearMax, doctype, minCitations, excludeRetracted }));
}));

app.post("/api/credibility", wrap(async (req, res) => {
  const { id, doi, title } = req.body || {};
  if (!id && !doi && !title) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "id, doi, or title is required" });
  }
  send(res, await adapter.credibility({ id, doi, title }));
}));

app.post("/api/rank", wrap(async (req, res) => {
  const { items, seeds, sortBy } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "items is required" });
  }
  send(res, await adapter.rank({ items, seeds, sortBy }));
}));

// ---- sessions (rr only) -----------------------------------------------------

app.post("/api/sessions", wrap(async (req, res) => {
  const { seeds } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "seeds (titles or DOIs) are required" });
  }
  send(res, await adapter.createSession({ seeds, ...req.body }));
}));

app.get("/api/sessions/:id", wrap(async (req, res) => {
  send(res, await adapter.getSession(req.params.id));
}));

app.patch("/api/sessions/:id/steps/:stepId", wrap(async (req, res) => {
  send(res, await adapter.updateSessionStep({ sessionId: req.params.id, stepId: req.params.stepId, ...req.body }));
}));

// Build the ResearchRabbit session deep link (rr only; openalex returns a
// not-available message + an OpenAlex search URL fallback when a query is given).
app.post("/api/session-link", wrap(async (req, res) => {
  const { sessionId, stepIndex, query } = req.body || {};
  send(res, await adapter.buildSessionLink({ sessionId, stepIndex, query }));
}));

// ---- collections / library / recent / readings (rr only) -------------------

app.get("/api/collections", wrap(async (_req, res) => send(res, await adapter.listCollections())));

app.post("/api/collections", wrap(async (req, res) => {
  if (writeGate(req, res)) return;
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, backend: BACKEND, error: "name is required" });
  send(res, await adapter.createCollection({ name, color }));
}));

app.post("/api/library/save", wrap(async (req, res) => {
  if (writeGate(req, res)) return;
  const { ids, collectionId } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "ids is required" });
  }
  send(res, await adapter.saveToLibrary({ ids, collectionId }));
}));

app.get("/api/library", wrap(async (_req, res) => send(res, await adapter.listLibrary())));
app.get("/api/recent", wrap(async (_req, res) => send(res, await adapter.listRecent())));
app.get("/api/readings", wrap(async (_req, res) => send(res, await adapter.listReadings())));

// ---- export / gaps / searches ----------------------------------------------

app.post("/api/export/bibtex", wrap(async (req, res) => {
  const { ids, dois } = req.body || {};
  if (!(Array.isArray(ids) && ids.length) && !(Array.isArray(dois) && dois.length)) {
    return res.status(400).json({ ok: false, backend: BACKEND, error: "ids or dois are required" });
  }
  send(res, await adapter.exportBibtex({ ids, dois }));
}));

app.post("/api/gaps", wrap(async (req, res) => send(res, await adapter.findGaps(req.body || {}))));

app.get("/api/searches/:id", wrap(async (req, res) => {
  send(res, await adapter.getSearchResults(decodeURIComponent(req.params.id || "")));
}));

// ---- error handler ----------------------------------------------------------

app.use((err, _req, res, _next) => {
  const status = err.status && Number.isInteger(err.status) ? err.status : 502;
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ ok: false, backend: BACKEND, error: err.message });
});

// ---- bootstrap --------------------------------------------------------------

const server = app.listen(PORT, () => {
  const h = adapter.health();
  console.log(`ResearchRabbit gateway listening on http://localhost:${PORT}`);
  console.log(`[backend] ${h.backend} | authOk=${h.authOk} | plan=${h.plan} | seedCap=${h.seedCap}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Start on another port, e.g.:\n  PORT=8821 npm start\n`);
  } else {
    console.error("[server error]", err);
  }
  process.exit(1);
});
