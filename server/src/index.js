// ResearchRabbit Copilot gateway (researchrabbit-copilot-server).
// REST gateway in front of the research backend. The LLM never talks to the
// upstream API directly; every endpoint returns small, flat, already-decided
// §7 objects.
//
// MULTI-TENANT backends (Camino A / B / C):
//   Each request resolves a ResearchRabbit credential in this priority order:
//     1. X-RR-Token (+ X-RR-Project-Id) request headers   — Camino B (MCP/editor)
//     2. RR_SESSION_TOKEN (+ RR_PROJECT_ID) env vars       — Camino A (single shared account)
//     3. the in-memory web credential store                — Camino C (web "Connect account" panel)
//   The credential is a JWT sessionToken (from the SPA's localStorage), sent
//   upstream as `Authorization: Bearer <token>`. If a credential is present,
//   that ONE request is served by the rr adapter bound to it; otherwise the
//   default backend (RR_BACKEND, default openalex). No credential is logged
//   or returned to clients.
//
// Run:  node --env-file=.env src/index.js   (Node 20+ native fetch, no dotenv)
// Listens on http://localhost:8821  (PORT wins; default 8821)

const express = require("express");
const cors = require("cors");

const openalex = require("./adapters/openalex");
const createRrAdapter = require("./adapters/rr"); // factory

const DEFAULT_BACKEND = (process.env.RR_BACKEND || "openalex").toLowerCase();
const ENV_TOKEN = process.env.RR_SESSION_TOKEN || "";
const ENV_PROJECT = process.env.RR_PROJECT_ID || "";

const PORT = process.env.PORT || 8821;
// An origin missing here can't read any answer from /api/rr/*, so the chat
// gate's login silently fails in the browser: keep the usual local dev servers
// (Flowise 3000, static site 8088, Vite 5173 / preview 4173) in the default.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:3000,http://localhost:8088,http://localhost:5173,http://localhost:4173"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WEB_TTL = (Number(process.env.RR_WEB_CRED_TTL_SECONDS) || 86400) * 1000;

// ---------------------------------------------------------------------------
// Camino C — in-memory web credential store (single active account for the
// web chat channel). Render free-tier restarts wipe it: the user reconnects.
// TTL'd so a stale token is dropped after a day.
// ---------------------------------------------------------------------------
let webCred = null; // { token, projectId, ts, user }
function setWebCred(token, projectId, user) { webCred = { token, projectId, ts: Date.now(), user }; }
function getWebCred() {
  if (!webCred) return null;
  if (Date.now() - webCred.ts > WEB_TTL) { webCred = null; return null; }
  return webCred;
}
function clearWebCred() { webCred = null; }

// ---------------------------------------------------------------------------
// Per-request credential resolution (header → env → web-store → none).
// The credential is a JWT sessionToken (Bearer), NOT a cookie.
// ---------------------------------------------------------------------------
function resolveCred(req) {
  const hToken = req.get("X-RR-Token");
  const hPid = req.get("X-RR-Project-Id");
  if (hToken) return { token: hToken, projectId: hPid || "", source: "header" };
  if (ENV_TOKEN) return { token: ENV_TOKEN, projectId: ENV_PROJECT, source: "env" };
  const w = getWebCred();
  if (w) return { token: w.token, projectId: w.projectId, source: "web" };
  return null;
}

// Adapter cache keyed by credential signature, so repeated requests with the
// same credential reuse their adapter (and its in-memory cache). Bounded by the
// number of distinct credentials (one per user / one env / one web).
const adapterCache = new Map();
function adapterFor(req) {
  const cred = resolveCred(req);
  if (cred && cred.token) {
    const sig = `${cred.source}|${cred.token}|${cred.projectId}`;
    let a = adapterCache.get(sig);
    if (!a) { a = createRrAdapter(cred); adapterCache.set(sig, a); }
    return { adapter: a, cred, backend: "rr" };
  }
  return { adapter: openalex, cred: null, backend: DEFAULT_BACKEND };
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true }));
app.use(express.json());
// request logging (helps confirm MCP / Flowise calls reach us)
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

// Attach the per-request adapter + resolved backend to every request.
app.use((req, _res, next) => {
  const { adapter, cred, backend } = adapterFor(req);
  req.adapter = adapter;
  req.cred = cred;
  req.backend = backend;
  next();
});

// ---- helpers ----------------------------------------------------------------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function writesAllowed() {
  return process.env.RR_ALLOW_WRITES === "true";
}

// Send an adapter result. null -> 404; structured {ok:false,...} "not available"
// messages are returned at 200 so the agent can read them; real upstream
// failures throw and hit the error handler.
function send(res, result, backend) {
  if (result === null || result === undefined) {
    return res.status(404).json({ ok: false, backend: backend || "openalex", error: "Not found" });
  }
  res.json(result);
}

// 403 gate for the two write endpoints (create_collection / save_articles).
function writeGate(req, res) {
  if (!writesAllowed()) {
    res.status(403).json({
      ok: false,
      backend: req.backend,
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
    backend: DEFAULT_BACKEND,
    multiTenant: true,
    credentialSources: ["header (X-RR-Token / X-RR-Project-Id)", "env (RR_SESSION_TOKEN / RR_PROJECT_ID)", "web-store (/api/rr/connect)"],
    endpoints: [
      "GET  /api/health                          (per-request: reflects the resolved backend)",
      "GET  /api/context",
      "POST /api/rr/connect        {token, projectId?}    [Camino C: validate + store web cred]",
      "GET  /api/rr/status                                [Camino C: is a web account connected?]",
      "DELETE /api/rr/disconnect                          [Camino C: drop the web cred]",
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

app.get("/api/health", wrap(async (req, res) => res.json(await Promise.resolve(req.adapter.health()))));
app.get("/api/context", wrap(async (req, res) => res.json(await Promise.resolve(req.adapter.context()))));
app.get("/api/_cache", wrap(async (req, res) => res.json({ backend: req.backend, cache: req.adapter.cacheStats() })));

// ---- Camino C: web credential management -----------------------------------

// Validate a ResearchRabbit session cookie (+ optional projectId) and store it
// as the active web credential. Validates via GET /users/me; best-effort
// projectId discovery when one isn't supplied.
app.post("/api/rr/connect", wrap(async (req, res) => {
  const { token, projectId } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, backend: "rr", error: "token (sessionToken JWT from app.researchrabbit.ai localStorage) is required" });
  const a = createRrAdapter({ token, projectId: projectId || "" });
  const user = await a.validate();
  if (!user) {
    return res.status(401).json({
      ok: false,
      backend: "rr",
      error: "Invalid or expired ResearchRabbit session. Log in at https://app.researchrabbit.ai, then copy a fresh sessionToken from localStorage (DevTools → Application → Local Storage → tokens).",
    });
  }
  // Auto-discover projectId via GET /projects when not supplied.
  let pid = projectId || "";
  if (!pid) pid = (await a.discoverProjectId()) || "";
  setWebCred(token, pid, user);
  res.json({
    ok: true,
    backend: "rr",
    source: "web",
    user: { id: user.id, email: user.email, name: user.name },
    projectId: pid || null,
    projectIdAutoDiscovered: !projectId && !!pid,
    note: pid ? null : "projectId could not be auto-discovered — paste your projectId too.",
  });
}));

// Is a web account connected and still valid?
app.get("/api/rr/status", wrap(async (_req, res) => {
  const w = getWebCred();
  if (!w) return res.json({ connected: false, backend: DEFAULT_BACKEND });
  const a = createRrAdapter({ token: w.token, projectId: w.projectId });
  const user = await a.validate();
  if (!user) {
    clearWebCred();
    return res.json({ connected: false, backend: DEFAULT_BACKEND, error: "Session expired — reconnect." });
  }
  res.json({ connected: true, backend: "rr", user: { id: user.id, email: user.email, name: user.name }, projectId: w.projectId || null });
}));

// Drop the active web credential.
app.delete("/api/rr/disconnect", wrap(async (_req, res) => {
  clearWebCred();
  res.json({ ok: true, disconnected: true, backend: DEFAULT_BACKEND });
}));

// ---- search -----------------------------------------------------------------

app.post("/api/search/keyword", wrap(async (req, res) => {
  const { q, per } = req.body || {};
  if (!q) return res.status(400).json({ ok: false, backend: req.backend, error: "q is required" });
  send(res, await req.adapter.searchKeyword({ q, per }), req.backend);
}));

app.post("/api/search/network", wrap(async (req, res) => {
  const { seeds, edgeMode, sinceYear, per } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "seeds (titles or DOIs) are required" });
  }
  send(res, await req.adapter.searchNetwork({ seeds, edgeMode, sinceYear, per }), req.backend);
}));

app.post("/api/search/author", wrap(async (req, res) => {
  const { name, authorIds, per } = req.body || {};
  if (!name && !(Array.isArray(authorIds) && authorIds.length)) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "name or authorIds is required" });
  }
  send(res, await req.adapter.searchAuthor({ name, authorIds, per }), req.backend);
}));

app.post("/api/expand", wrap(async (req, res) => {
  const { seeds, iterations, limit } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "seeds (titles or DOIs) are required" });
  }
  send(res, await req.adapter.expand({ seeds, iterations, limit }), req.backend);
}));

// ---- article / resolution ---------------------------------------------------

// Wildcard so a DOI with a slash works whether the slash is encoded (%2F) or not.
app.get("/api/articles/*", wrap(async (req, res) => {
  const idOrDoi = decodeURIComponent(req.params[0] || "");
  if (!idOrDoi) return res.status(400).json({ ok: false, backend: req.backend, error: "id, DOI, or title is required" });
  send(res, await req.adapter.getArticle(idOrDoi), req.backend);
}));

app.post("/api/resolve", wrap(async (req, res) => {
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, backend: req.backend, error: "query is required" });
  send(res, await req.adapter.resolve({ query }), req.backend);
}));

// ---- derived: screen / credibility / rank ----------------------------------

app.post("/api/screen", wrap(async (req, res) => {
  const { ids, items, yearMin, yearMax, doctype, minCitations, excludeRetracted } = req.body || {};
  if (!(Array.isArray(ids) && ids.length) && !(Array.isArray(items) && items.length)) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "ids or items are required" });
  }
  send(res, await req.adapter.screen({ ids, items, yearMin, yearMax, doctype, minCitations, excludeRetracted }), req.backend);
}));

app.post("/api/credibility", wrap(async (req, res) => {
  const { id, doi, title } = req.body || {};
  if (!id && !doi && !title) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "id, doi, or title is required" });
  }
  send(res, await req.adapter.credibility({ id, doi, title }), req.backend);
}));

app.post("/api/rank", wrap(async (req, res) => {
  const { items, seeds, sortBy } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "items is required" });
  }
  send(res, await req.adapter.rank({ items, seeds, sortBy }), req.backend);
}));

// ---- sessions (rr only) -----------------------------------------------------

app.post("/api/sessions", wrap(async (req, res) => {
  const { seeds } = req.body || {};
  if (!Array.isArray(seeds) || !seeds.length) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "seeds (titles or DOIs) are required" });
  }
  send(res, await req.adapter.createSession({ seeds, ...req.body }), req.backend);
}));

app.get("/api/sessions/:id", wrap(async (req, res) => {
  send(res, await req.adapter.getSession(req.params.id), req.backend);
}));

app.patch("/api/sessions/:id/steps/:stepId", wrap(async (req, res) => {
  send(res, await req.adapter.updateSessionStep({ sessionId: req.params.id, stepId: req.params.stepId, ...req.body }), req.backend);
}));

// Build the ResearchRabbit session deep link (rr only; openalex returns a
// not-available message + an OpenAlex search URL fallback when a query is given).
app.post("/api/session-link", wrap(async (req, res) => {
  const { sessionId, stepIndex, query } = req.body || {};
  send(res, await req.adapter.buildSessionLink({ sessionId, stepIndex, query }), req.backend);
}));

// ---- collections / library / recent / readings (rr only) -------------------

app.get("/api/collections", wrap(async (req, res) => send(res, await req.adapter.listCollections(), req.backend)));

app.post("/api/collections", wrap(async (req, res) => {
  if (writeGate(req, res)) return;
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, backend: req.backend, error: "name is required" });
  send(res, await req.adapter.createCollection({ name, color }), req.backend);
}));

app.post("/api/library/save", wrap(async (req, res) => {
  if (writeGate(req, res)) return;
  const { ids, collectionId } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "ids is required" });
  }
  send(res, await req.adapter.saveToLibrary({ ids, collectionId }), req.backend);
}));

app.get("/api/library", wrap(async (req, res) => send(res, await req.adapter.listLibrary(), req.backend)));
app.get("/api/recent", wrap(async (req, res) => send(res, await req.adapter.listRecent(), req.backend)));
app.get("/api/readings", wrap(async (req, res) => send(res, await req.adapter.listReadings(), req.backend)));

// ---- export / gaps / searches ----------------------------------------------

app.post("/api/export/bibtex", wrap(async (req, res) => {
  const { ids, dois } = req.body || {};
  if (!(Array.isArray(ids) && ids.length) && !(Array.isArray(dois) && dois.length)) {
    return res.status(400).json({ ok: false, backend: req.backend, error: "ids or dois are required" });
  }
  send(res, await req.adapter.exportBibtex({ ids, dois }), req.backend);
}));

app.post("/api/gaps", wrap(async (req, res) => send(res, await req.adapter.findGaps(req.body || {}), req.backend)));

app.get("/api/searches/:id", wrap(async (req, res) => {
  send(res, await req.adapter.getSearchResults(decodeURIComponent(req.params.id || "")), req.backend);
}));

// ---- error handler ----------------------------------------------------------

app.use((err, _req, res, _next) => {
  const status = err.status && Number.isInteger(err.status) ? err.status : 502;
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ ok: false, backend: "rr", error: err.message });
});

// ---- bootstrap --------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`ResearchRabbit gateway listening on http://localhost:${PORT}`);
  console.log(`[backend] default=${DEFAULT_BACKEND} | envCred=${!!ENV_TOKEN} | webCred=${!!webCred} | multiTenant=on`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Start on another port, e.g.:\n  PORT=8821 npm start\n`);
  } else {
    console.error("[server error]", err);
  }
  process.exit(1);
});
