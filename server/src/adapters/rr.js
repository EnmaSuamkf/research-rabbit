// ResearchRabbit adapter — scaffolded behind RR_BACKEND=rr (§6 / §14.0).
//
// The working local backend is `openalex` (no credentials). This adapter is a
// faithful stub: it mirrors the openalex adapter's method surface so the
// gateway can switch backends with one env var, but it NEVER calls upstream
// api.researchrabbit.ai without a valid RR_SESSION_COOKIE. Without a cookie
// every method returns a structured not-configured error and /api/health
// reports authOk:false.
//
// When a cookie + RR_PROJECT_ID are present, fill in the real upstream calls
// (POST /searches, GET /articles/{id}, GET /folders, …) per
// researchrabbit-howto-api-en.html. The projectId is injected by the gateway,
// never seen by the agent.

const RR_API_BASE = process.env.RR_API_BASE || "https://api.researchrabbit.ai";
const RR_APP_BASE = process.env.RR_APP_BASE || "https://app.researchrabbit.ai";
const SESSION_COOKIE = process.env.RR_SESSION_COOKIE || "";
const PROJECT_ID = process.env.RR_PROJECT_ID || "";
const SEED_CAP = Number(process.env.SEED_CAP) || 50;

const configured = !!(SESSION_COOKIE && PROJECT_ID);

function notConfigured(what) {
  return {
    ok: false,
    backend: "rr",
    error: "RR backend not configured (no session cookie)",
    detail: `Set RR_SESSION_COOKIE and RR_PROJECT_ID to enable ${what}. Upstream host: ${RR_API_BASE}`,
  };
}

// Placeholder for the real upstream call. Kept here so the wiring is obvious
// when a cookie is added: gate every fetch on `configured`.
async function rrFetch(pathname, opts = {}) {
  if (!configured) throw Object.assign(new Error("RR backend not configured"), { rrNotConfigured: true });
  // Real implementation would:
  //   const res = await fetch(RR_API_BASE + pathname, {
  //     method: opts.method || "GET",
  //     headers: { Cookie: `SPRSESSION=${SESSION_COOKIE}`, "Content-Type": "application/json", ...(opts.headers||{}) },
  //     body: opts.body ? JSON.stringify({ ...opts.body, projectId: PROJECT_ID }) : undefined,
  //   });
  //   return res.json();
  throw new Error("RR upstream calls not implemented in this scaffold");
}

module.exports = {
  backend: "rr",
  configured,

  health() {
    return { ok: true, backend: "rr", authOk: configured, plan: configured ? "pro" : "free", seedCap: SEED_CAP };
  },
  context() {
    return { plan: configured ? "pro" : "free", seedCap: SEED_CAP, backend: "rr", projectId: PROJECT_ID || null, authOk: configured };
  },

  // Every data method needs upstream RR; without a cookie it is not available.
  searchKeyword() { return notConfigured("keyword search"); },
  searchNetwork() { return notConfigured("network search"); },
  searchAuthor() { return notConfigured("author search"); },
  expand() { return notConfigured("expand"); },
  getArticle() { return notConfigured("article lookup"); },
  resolve() { return notConfigured("article resolution"); },
  screen() { return notConfigured("screening"); },
  credibility() { return notConfigured("credibility checks"); },
  rank() { return notConfigured("ranking"); },
  exportBibtex() { return notConfigured("BibTeX export"); },

  createSession() { return notConfigured("sessions"); },
  getSession() { return notConfigured("sessions"); },
  updateSessionStep() { return notConfigured("sessions"); },
  buildSessionLink({ sessionId, stepIndex } = {}) {
    if (!configured) return notConfigured("session links");
    const sid = sessionId || "{sessionId}";
    const step = stepIndex != null ? stepIndex : "{stepIndex}";
    return { ok: true, backend: "rr", url: `${RR_APP_BASE}/search/${sid}/${step}` };
  },
  listCollections() { return notConfigured("collections"); },
  createCollection() { return notConfigured("collections"); },
  saveToLibrary() { return notConfigured("library"); },
  listLibrary() { return notConfigured("library"); },
  listRecent() { return notConfigured("recently found"); },
  listReadings() { return notConfigured("reading list"); },
  getSearchResults() { return notConfigured("search re-read"); },
  findGaps() { return notConfigured("gap analysis"); },

  cacheStats() { return { configured }; },
};
