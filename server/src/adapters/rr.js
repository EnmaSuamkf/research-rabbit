// ResearchRabbit adapter — real upstream calls against api.researchrabbit.ai.
//
// This is a FACTORY: createRrAdapter(cred) returns an adapter bound to ONE
// caller's credential (Camino B header, Camino C web-store, or Camino A env),
// so the gateway can be multi-tenant: each request uses its own session.
//
// cred = { token, projectId, source }
//   token     — the ResearchRabbit JWT sessionToken (from the SPA's
//               localStorage: app.researchrabbit.ai → tokens → sessionToken).
//               Sent upstream as `Authorization: Bearer <token>`.
//               NEVER logged, NEVER returned to clients.
//   projectId — the user's RR projectId. Required by almost every endpoint.
//               Auto-discovered via GET /projects when not supplied.
//
// AUTH MODEL (verified live): ResearchRabbit uses a JWT Bearer token, NOT a
// cookie. The token lives in the SPA's localStorage under `tokens.sessionToken`
// and is sent as `Authorization: Bearer <jwt>`. projectId is in localStorage
// too (`projectId`) and is also recoverable via GET /projects (items[0].id).
//
// Endpoint set (verified against api.researchrabbit.ai):
//   GET  /users/me                          validate the token (profile)
//   GET  /projects                          list user projects → projectId
//   POST /searches                          create a search (keyword/network)
//   GET  /searches/{id}?projectId=          fetch a search's results
//   GET  /articles/{id}                     full article metadata
//   POST /search-sessions                   create a research thread
//   GET  /search-sessions/{id}?projectId=   read a session + its steps
//   PATCH /search-sessions/{id}/steps/{stepId}
//   GET  /folders?projectId=…               list collections
//   POST /folders?projectId=…               create a collection
//   GET  /user-articles?projectId=…         library
//   POST /user-articles/batch               save articles
//   GET  /recent-articles?projectId=…       recently found
//   GET  /readings?projectId=…              reading list
//
// SEARCH IS TWO-STEP + STRINGIFIED RESULTS:
//   POST /searches creates the search and returns {id, ...} with an EMPTY
//   results field. The actual hits come from GET /searches/{id}?projectId=…,
//   whose `results` field is a STRINGIFIED JSON object that must be parsed to
//   get .items[]. Each item is {id, score, details:{title, dois[], authors[],
//   firstAuthor, authorString, publicationDate, publicationTitle,
//   forwardEdgeCount, backwardEdgeCount, retracted, doctype, url, openAlexIds,
//   abstract, ...}}.
//
// EDGE-COUNT SEMANTICS (verified against a 2024 paper):
//   backwardEdgeCount = citations (cited-by, incoming)   → citedBy
//   forwardEdgeCount  = references (outgoing)            → references

const shape = require("../shape");
const { TtlCache } = require("../cache");

const RR_API_BASE = process.env.RR_API_BASE || "https://api.researchrabbit.ai";
const RR_APP_BASE = process.env.RR_APP_BASE || "https://app.researchrabbit.ai";
const SEED_CAP = Number(process.env.SEED_CAP) || 50;
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS_PER_CONV) || 40;

function parseYear(d) {
  if (!d) return null;
  const m = String(d).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

function createRrAdapter(cred) {
  const token = (cred && cred.token) || "";
  const projectId = (cred && cred.projectId) || "";
  const cache = new TtlCache();
  let discoveredProjectId = null;

  const configured = !!token;

  function notConfigured(what) {
    return {
      ok: false,
      backend: "rr",
      error: "RR backend not configured for this request.",
      detail: `No ResearchRabbit session on this request. Provide X-RR-Token on the MCP call, connect an account via /api/rr/connect, or set RR_SESSION_TOKEN on the gateway. Needed for: ${what}.`,
    };
  }

  function needProject(what) {
    return {
      ok: false,
      backend: "rr",
      error: "projectId is required for ResearchRabbit.",
      detail: `Your session token is present but no projectId was supplied and it could not be auto-discovered. Reconnect your account via /api/rr/connect (which discovers it from /projects) or pass X-RR-Project-Id. Needed for: ${what}.`,
    };
  }

  // Low-level upstream fetch, authenticated with this caller's JWT.
  async function rrFetch(pathname, { method = "GET", query, body } = {}) {
    if (!configured) {
      const e = new Error("RR backend not configured (no session token)");
      e.rrNotConfigured = true;
      throw e;
    }
    const url = new URL(RR_API_BASE + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    const init = { method, headers };
    if (body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url.toString(), init);
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    if (res.status === 401 || res.status === 403) {
      const e = new Error("Your ResearchRabbit session expired or is invalid. Reconnect your account (log in at app.researchrabbit.ai and paste a fresh sessionToken from localStorage).");
      e.status = res.status;
      e.rrAuth = true;
      throw e;
    }
    if (!res.ok) {
      const e = new Error((parsed && (parsed.message || parsed.reason || parsed.error)) || `RR upstream ${res.status}`);
      e.status = res.status;
      e.upstream = parsed;
      throw e;
    }
    return parsed;
  }

  // Wrap an async producer: turn auth/config errors into structured messages
  // the agent can read (returned at HTTP 200), rethrow real failures.
  async function guarded(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e.rrAuth) return { ok: false, backend: "rr", error: e.message };
      if (e.rrNotConfigured) return notConfigured("this call");
      throw e;
    }
  }

  // Best-effort projectId discovery via GET /projects (verified live:
  // returns {items:[{id, name, ...}]}). Falls back to /folders if needed.
  async function ensureProjectId() {
    if (projectId) return projectId;
    if (discoveredProjectId) return discoveredProjectId;
    try {
      const data = await rrFetch("/projects");
      const items = (data && (data.items || data)) || [];
      const first = Array.isArray(items) ? items[0] : null;
      if (first && first.id) {
        discoveredProjectId = first.id;
        return discoveredProjectId;
      }
    } catch { /* fall through to folders */ }
    try {
      const data = await rrFetch("/folders", { query: { includeItemCounts: "true", per: 1, page: 1 } });
      const folders = (data && (data.items || data)) || [];
      const first = Array.isArray(folders) ? folders[0] : null;
      if (first && first.projectId) {
        discoveredProjectId = first.projectId;
        return discoveredProjectId;
      }
    } catch { /* fall through */ }
    return null;
  }

  // The `results` field on a search response is a STRINGIFIED JSON object.
  // Parse it defensively into { items, totalCount }.
  function parseResultsField(data) {
    let r = data && data.results;
    if (r == null) return { items: [], totalCount: 0 };
    if (typeof r === "string") {
      try { r = JSON.parse(r); } catch { return { items: [], totalCount: 0 }; }
    }
    const items = Array.isArray(r.items) ? r.items : (Array.isArray(r) ? r : []);
    const totalCount = r.totalCount != null ? r.totalCount : ((r.metadata && r.metadata.total) != null ? r.metadata.total : items.length);
    return { items, totalCount };
  }

  // SEARCH IS TWO-STEP: POST /searches creates the search (results empty),
  // then GET /searches/{id}?projectId fetches the (async) results. Poll a
  // few times because RR computes the hits asynchronously.
  async function runSearch(body, { per = 10, page = 1, polls = 5, delay = 800 } = {}) {
    const pid = body && body.projectId;
    const created = await rrFetch("/searches", { method: "POST", body });
    const searchId = created && (created.id || (created.data && created.data.id));
    let pr = parseResultsField(created);
    if (pr.items.length) return { searchId, items: pr.items, totalCount: pr.totalCount };
    if (searchId) {
      for (let i = 0; i < polls; i++) {
        if (i > 0) await new Promise((res) => setTimeout(res, delay));
        const data = await rrFetch(`/searches/${encodeURIComponent(searchId)}`, { query: { projectId: pid, per, page } });
        pr = parseResultsField(data);
        if (pr.items.length) return { searchId, items: pr.items, totalCount: pr.totalCount };
      }
      return { searchId, items: pr.items, totalCount: pr.totalCount };
    }
    return { searchId: null, items: [], totalCount: 0 };
  }

  // --- mapping RR -> canonical shape ---------------------------------------

  function rrListItem(item, opts = {}) {
    const d = (item && item.details) || item || {};
    const numSeeds = opts.numSeeds || 0;
    const score = Number(item && item.score != null ? item.score : 0);
    const year = parseYear(d.publicationDate);
    const doi = Array.isArray(d.dois) ? d.dois[0] : d.doi;
    return {
      articleId: String(d.id != null ? d.id : (item && item.id != null ? item.id : "")),
      title: d.title || null,
      authors: d.authorString || d.firstAuthor || null,
      year,
      venue: d.publicationTitle || null,
      doi: shape.bareDoi(doi),
      url: d.url || shape.doiUrl(doi),
      citedBy: Number(d.backwardEdgeCount != null ? d.backwardEdgeCount : 0),
      references: Number(d.forwardEdgeCount != null ? d.forwardEdgeCount : 0),
      doctype: d.doctype || null,
      retracted: !!d.retracted,
      score,
      // RR's network `score` reflects seed consensus; clamp into a plausible
      // seedHits count so the agent can say "connected to N of your seeds".
      seedHits: numSeeds ? Math.min(Math.max(Math.round(score), 0), numSeeds) : 0,
      citationsPerYear: shape.citationsPerYear(d.backwardEdgeCount != null ? d.backwardEdgeCount : 0, year),
    };
  }

  function rrDetail(a) {
    a = a || {};
    const year = parseYear(a.publicationDate);
    const doi = Array.isArray(a.dois) ? a.dois[0] : a.doi;
    const authors = (Array.isArray(a.authors) ? a.authors : []).map((au) => ({
      name: au.authorDisplayName || null,
      authorId: au.authorId != null ? String(au.authorId) : null,
      orcid: null,
      hIndex: au.authorHIndex != null ? au.authorHIndex : null,
    }));
    return {
      articleId: String(a.id != null ? a.id : ""),
      title: a.title || null,
      authors,
      authorsString: a.authorString || authors.map((x) => x.name).filter(Boolean).join(", "),
      year,
      venue: a.publicationTitle || null,
      doi: shape.bareDoi(doi),
      url: a.url || shape.doiUrl(doi),
      citedBy: Number(a.backwardEdgeCount != null ? a.backwardEdgeCount : 0),
      references: Number(a.forwardEdgeCount != null ? a.forwardEdgeCount : 0),
      doctype: a.doctype || null,
      retracted: !!a.retracted,
      isOa: null,
      abstract: a.abstract || null,
      referencedWorkIds: [],
      relatedWorkIds: [],
      citationsPerYear: shape.citationsPerYear(a.backwardEdgeCount != null ? a.backwardEdgeCount : 0, year),
      primaryLocationUrl: a.url || null,
    };
  }

  function listResponse(query, items, totalCount) {
    return {
      query,
      totalCount: totalCount == null ? items.length : totalCount,
      seedCap: SEED_CAP,
      backend: "rr",
      items,
    };
  }

  // --- seed resolution (titles/DOIs -> RR numeric article ids) -------------
  // RR searches by `stringFilter` over title+abstract; top hit's id is the
  // resolved seed. DOIs are best-effort (RR may index them as a hit).
  async function resolveSeed(seed) {
    const q = String(seed || "").trim();
    if (!q) return null;
    if (/^\d+$/.test(q)) return Number(q); // RR numeric id — must be a NUMBER, RR 501s on string articleIds
    return cache.getOrFetch(`rr:seed:${q.toLowerCase()}`, async () => {
      const { items } = await runSearch({
        type: "singleSet", projectId: projectId || undefined,
        set: { userArticleIds: [], articleIds: [], authorIds: [], folderIds: [], tagIds: [] },
        outputType: "articles", showPlaceholders: true, per: 1, page: 1,
        stringFilter: q, stringFilterTypes: ["title", "abstract"],
      }, { per: 1, polls: 3, delay: 700 });
      const top = items[0];
      // RR requires articleIds as NUMBERS; a String id makes POST /searches
      // return 501 {"error":true,"reason":"Not Implemented"}. Verified live.
      if (!top) return null;
      const rawId = (top.details && top.details.id != null) ? top.details.id : top.id;
      return rawId != null ? Number(rawId) : null;
    });
  }

  async function resolveSeeds(seeds) {
    const resolved = [];
    const missing = [];
    for (const s of seeds || []) {
      const id = await resolveSeed(s);
      if (id) resolved.push(id);
      else missing.push(s);
    }
    return { resolved, missing };
  }

  // --- public adapter surface ----------------------------------------------

  return {
    backend: "rr",

    async health() {
      if (!configured) return { ok: true, backend: "rr", authOk: false, plan: "free", seedCap: SEED_CAP };
      try {
        await rrFetch("/users/me");
        const pid = await ensureProjectId();
        return { ok: true, backend: "rr", authOk: true, plan: "pro", seedCap: SEED_CAP, projectId: pid || projectId || null };
      } catch (e) {
        return { ok: true, backend: "rr", authOk: false, plan: "free", seedCap: SEED_CAP, error: e.message };
      }
    },

    context() {
      return {
        plan: configured ? "pro" : "free",
        seedCap: SEED_CAP,
        backend: "rr",
        projectId: projectId || null,
        authOk: configured,
        maxToolCalls: MAX_TOOL_CALLS,
      };
    },

    async validate() {
      // Used by /api/rr/connect and /api/rr/status. Returns the /users/me body or null.
      if (!configured) return null;
      try { return await rrFetch("/users/me"); } catch { return null; }
    },

    async discoverProjectId() {
      // Used by /api/rr/connect to auto-fill projectId from GET /projects.
      if (!configured) return null;
      try {
        const pid = await ensureProjectId();
        return pid || null;
      } catch { return null; }
    },

    async searchKeyword({ q, per }) {
      return guarded(async () => {
        if (!configured) return notConfigured("keyword search");
        const pid = await ensureProjectId();
        if (!pid) return needProject("keyword search");
        const n = Math.min(Math.max(Number(per) || 10, 1), 20);
        const { items, totalCount } = await runSearch({
          type: "singleSet", projectId: pid,
          set: { userArticleIds: [], articleIds: [], authorIds: [], folderIds: [], tagIds: [] },
          outputType: "articles", showPlaceholders: true, per: n, page: 1,
          stringFilter: String(q || ""), stringFilterTypes: ["title", "abstract"],
        }, { per: n });
        return listResponse({ kind: "keyword", q, per: n }, items.map((it) => rrListItem(it)), totalCount);
      });
    },

    async searchNetwork({ seeds, edgeMode = "both", sinceYear, per }) {
      return guarded(async () => {
        if (!configured) return notConfigured("network search");
        const pid = await ensureProjectId();
        if (!pid) return needProject("network search");
        const n = Math.min(Math.max(Number(per) || 10, 1), 20);
        const { resolved, missing } = await resolveSeeds(seeds);
        if (!resolved.length) return listResponse({ kind: "network", edgeMode, seeds, per: n, missing }, [], 0);
        const { items, totalCount } = await runSearch({
          type: "singleSet", projectId: pid,
          set: { userArticleIds: [], articleIds: resolved, authorIds: [], folderIds: [], tagIds: [], edgeMode },
          outputType: "articles", showPlaceholders: true, per: n, page: 1,
        }, { per: n });
        let mapped = items.map((it) => rrListItem(it, { numSeeds: resolved.length }));
        if (sinceYear) mapped = mapped.filter((it) => (it.year || 0) >= Number(sinceYear));
        return listResponse({ kind: "network", edgeMode, seeds, per: n, missing }, mapped, totalCount);
      });
    },

    async searchAuthor({ name, authorIds, per }) {
      // RR has no documented author-search endpoint; approximate by a keyword
      // search on the name and surface the matching author's h-index from the
      // first hit's authors[].
      return guarded(async () => {
        if (!configured) return notConfigured("author search");
        const pid = await ensureProjectId();
        if (!pid) return needProject("author search");
        const n = Math.min(Math.max(Number(per) || 10, 1), 20);
        let ids = [];
        if (Array.isArray(authorIds) && authorIds.length) ids = authorIds.map(Number); // RR requires numeric ids (string authorIds 501 the same way)
        else if (!name) return { backend: "rr", authors: [], ...listResponse({ kind: "author", name, authorIds, per: n }, [], 0) };
        if (!ids.length) {
          const { items, totalCount } = await runSearch({
            type: "singleSet", projectId: pid,
            set: { userArticleIds: [], articleIds: [], authorIds: [], folderIds: [], tagIds: [] },
            outputType: "articles", showPlaceholders: true, per: n, page: 1,
            stringFilter: String(name), stringFilterTypes: ["title", "abstract"],
          }, { per: n });
          const authorMeta = [];
          const lower = String(name).toLowerCase();
          for (const it of items) {
            const d = (it.details || it);
            for (const au of (d.authors || [])) {
              if (au.authorDisplayName && au.authorDisplayName.toLowerCase().includes(lower)) {
                authorMeta.push({
                  authorId: au.authorId != null ? String(au.authorId) : null,
                  name: au.authorDisplayName,
                  worksCount: au.authorArticleCount,
                  citedBy: au.authorCitationCount,
                  hIndex: au.authorHIndex,
                });
              }
            }
            if (authorMeta.length) break;
          }
          return { backend: "rr", authors: authorMeta, ...listResponse({ kind: "author", name, authorIds, per: n }, items.map((it) => rrListItem(it)), totalCount) };
        }
        // authorIds path: network search by author ids.
        const { items, totalCount } = await runSearch({
          type: "singleSet", projectId: pid,
          set: { userArticleIds: [], articleIds: [], authorIds: ids, folderIds: [], tagIds: [] },
          outputType: "articles", showPlaceholders: true, per: n, page: 1,
        }, { per: n });
        return { backend: "rr", authors: [], ...listResponse({ kind: "author", name, authorIds, per: n }, items.map((it) => rrListItem(it)), totalCount) };
      });
    },

    async expand({ seeds, iterations = 2, limit }) {
      // RR expands seeds server-side in one /searches call (edgeMode:both),
      // the faithful equivalent of the Grow-and-go loop.
      return guarded(async () => {
        if (!configured) return notConfigured("expand");
        const pid = await ensureProjectId();
        if (!pid) return needProject("expand");
        const lim = Math.min(Math.max(Number(limit) || 10, 1), 20);
        const iters = Math.min(Math.max(Number(iterations) || 2, 1), 4);
        const { resolved, missing } = await resolveSeeds(seeds);
        if (!resolved.length) return listResponse({ kind: "expand", seeds, iterations: iters, limit: lim, missing }, [], 0);
        const { items, totalCount } = await runSearch({
          type: "singleSet", projectId: pid,
          set: { userArticleIds: [], articleIds: resolved, authorIds: [], folderIds: [], tagIds: [], edgeMode: "both" },
          outputType: "articles", showPlaceholders: true, per: lim, page: 1,
        }, { per: lim });
        return listResponse({ kind: "expand", seeds, iterations: iters, limit: lim, missing }, items.map((it) => rrListItem(it, { numSeeds: resolved.length })), totalCount);
      });
    },

    async getArticle(idOrDoiOrTitle) {
      return guarded(async () => {
        if (!configured) return notConfigured("article lookup");
        const q = String(idOrDoiOrTitle || "").trim();
        if (!q) return null;
        let id = q;
        if (!/^\d+$/.test(q)) {
          id = await resolveSeed(q);
          if (!id) return null;
        }
        return cache.getOrFetch(`rr:art:${id}`, async () => {
          const a = await rrFetch(`/articles/${encodeURIComponent(id)}`);
          return rrDetail(a);
        });
      });
    },

    async resolve({ query }) {
      return guarded(async () => {
        if (!configured) return notConfigured("article resolution");
        const q = String(query || "").trim();
        if (!q) return { articleId: null, title: null, doi: null, confidence: 0 };
        if (/^\d+$/.test(q)) {
          const a = await rrFetch(`/articles/${encodeURIComponent(q)}`);
          const d = rrDetail(a);
          return { articleId: d.articleId, title: d.title, doi: d.doi, confidence: 1 };
        }
        const id = await resolveSeed(q);
        if (!id) return { articleId: null, title: null, doi: null, confidence: 0 };
        const a = await rrFetch(`/articles/${encodeURIComponent(id)}`);
        const d = rrDetail(a);
        const conf = /^10\.\d{4,9}\//.test(q) ? 1 : Math.round(shape.titleSimilarity(q, d.title) * 100) / 100;
        return { articleId: d.articleId, title: d.title, doi: d.doi, confidence: conf };
      });
    },

    async screen({ ids, items, yearMin, yearMax, doctype, minCitations, excludeRetracted }) {
      return guarded(async () => {
        if (!configured) return notConfigured("screening");
        let pool = [];
        if (Array.isArray(items)) pool = items.slice();
        if (Array.isArray(ids) && ids.length) {
          for (const id of ids) {
            const d = await this.getArticle(id);
            if (d && d.ok !== false && d.articleId) pool.push(d);
          }
        }
        let filtered = pool;
        if (yearMin) filtered = filtered.filter((it) => (it.year || 0) >= Number(yearMin));
        if (yearMax) filtered = filtered.filter((it) => (it.year || 0) <= Number(yearMax));
        if (doctype) filtered = filtered.filter((it) => String(it.doctype || "").toLowerCase() === String(doctype).toLowerCase());
        if (minCitations != null) filtered = filtered.filter((it) => (it.citedBy || 0) >= Number(minCitations));
        if (excludeRetracted) filtered = filtered.filter((it) => !it.retracted);
        return listResponse({ kind: "screen", yearMin, yearMax, doctype, minCitations, excludeRetracted }, filtered, filtered.length);
      });
    },

    async credibility({ id, doi, title }) {
      return guarded(async () => {
        if (!configured) return notConfigured("credibility checks");
        const query = id || doi || title;
        const detail = await this.getArticle(query);
        if (!detail || detail.ok === false) return (detail && detail.ok === false) ? detail : { ok: false, backend: "rr", error: "Could not resolve the article." };
        const topAuthor = detail.authors && detail.authors[0];
        return {
          ok: true,
          backend: "rr",
          articleId: detail.articleId,
          title: detail.title,
          doi: detail.doi,
          retracted: detail.retracted,
          doctype: detail.doctype,
          venue: detail.venue,
          year: detail.year,
          citedBy: detail.citedBy,
          citationsPerYear: detail.citationsPerYear,
          references: detail.references,
          topAuthor: topAuthor ? { name: topAuthor.name, hIndex: topAuthor.hIndex } : null,
          caveats: [
            "Counts are ResearchRabbit's own (backwardEdgeCount/forwardEdgeCount); they can differ from Google Scholar / Scopus / OpenAlex.",
            "h-index is ResearchRabbit's value for the first listed author only.",
            "This is a metadata triage, not peer judgement — read the paper before relying on it.",
          ],
        };
      });
    },

    async rank({ items, seeds, sortBy = "seedConsensus" }) {
      return guarded(async () => {
        if (!configured) return notConfigured("ranking");
        const numSeeds = Array.isArray(seeds) ? seeds.length : 0;
        const resolved = [];
        for (const it of items || []) {
          if (it && it.articleId && it.title && it.citedBy != null) resolved.push(it);
          else {
            const d = await this.getArticle(it.articleId || it.doi || it.id || it.title || it);
            if (d && d.ok !== false && d.articleId) {
              const li = { articleId: d.articleId, title: d.title, authors: d.authorsString, year: d.year, venue: d.venue, doi: d.doi, url: d.url, citedBy: d.citedBy, references: d.references, doctype: d.doctype, retracted: d.retracted, score: 0, seedHits: 0, citationsPerYear: d.citationsPerYear };
              resolved.push(li);
            }
          }
        }
        const cmp = (a, b) => {
          if (sortBy === "recency") return (b.year || 0) - (a.year || 0);
          if (sortBy === "citationsPerYear") return (b.citationsPerYear || 0) - (a.citationsPerYear || 0);
          if (sortBy === "citations") return (b.citedBy || 0) - (a.citedBy || 0);
          return (b.seedHits || 0) - (a.seedHits || 0) || (b.citationsPerYear || 0) - (a.citationsPerYear || 0);
        };
        const sorted = resolved.slice().sort(cmp);
        const ranked = sorted.map((it, i) => {
          const reasons = [];
          if (it.seedHits > 0) reasons.push(`connected to ${it.seedHits} of your seed${it.seedHits > 1 ? "s" : ""}`);
          reasons.push(`${it.citedBy} citations (${it.citationsPerYear}/yr)`);
          if (it.retracted) reasons.push("RETRACTED — flag before recommending");
          return { ...it, rank: i + 1, reason: reasons.join("; ") };
        });
        return { backend: "rr", sortBy, items: ranked, numSeeds };
      });
    },

    async exportBibtex({ ids, dois }) {
      return guarded(async () => {
        if (!configured) return notConfigured("BibTeX export");
        const idList = [];
        if (Array.isArray(ids)) ids.forEach((x) => idList.push(x));
        if (Array.isArray(dois)) dois.forEach((x) => idList.push(x));
        const entries = [];
        for (const x of idList) {
          const d = await this.getArticle(x);
          if (!d || d.ok === false) continue;
          const key = ((d.authors && d.authors[0] && d.authors[0].name) || "anon").split(" ").slice(-1)[0] + (d.year || "nd") + (d.articleId || "");
          const fields = [
            `title = {${(d.title || "").replace(/[{}]/g, "")}}`,
            `author = {${d.authorsString || ""}}`,
            `year = {${d.year || ""}}`,
            `journal = {${d.venue || ""}}`,
            `doi = {${d.doi || ""}}`,
            `url = {${d.url || ""}}`,
          ];
          entries.push(`@article{${key},\n  ${fields.join(",\n  ")}\n}`);
        }
        return { backend: "rr", count: entries.length, bibtex: entries.join("\n\n") };
      });
    },

    // --- sessions (rr-unique) ------------------------------------------------
    async createSession({ seeds, title } = {}) {
      // RR creates a session in TWO steps, in this order (verified live by
      // capturing the real app's POST /search-sessions body):
      //   1. POST /searches  -> searchId (the citation network for the seeds)
      //   2. POST /search-sessions with body
      //        { session:{projectId}, stepNumber:0, selected:[],
      //          inspectedType:null, inspectedId:null, view:"list", searchId }
      //      -> { id: sessionId, steps:[{ id: stepId, searchId, stepIndex:0 }] }
      // The step already points at the search, so NO separate PATCH is needed.
      // The previous code created the session first then the search + PATCH,
      // and sent a bare {projectId,title} body that RR 400'd with
      // "No such key 'session'".
      return guarded(async () => {
        if (!configured) return notConfigured("sessions");
        const pid = await ensureProjectId();
        if (!pid) return needProject("sessions");
        const { resolved, missing } = await resolveSeeds(seeds);
        // RR rejects searchId:null (expects a String), so we MUST create a
        // search first and pass its id. Network search when seeds resolve;
        // keyword-search fallback on the raw seed string otherwise.
        let searchId = null;
        try {
          if (resolved.length) {
            const r = await runSearch({
              type: "singleSet", projectId: pid,
              set: { userArticleIds: [], articleIds: resolved, authorIds: [], folderIds: [], tagIds: [], edgeMode: "both" },
              outputType: "articles", showPlaceholders: true, per: 20, page: 1,
            }, { per: 20, polls: 4 });
            searchId = r.searchId;
          } else if (Array.isArray(seeds) && seeds.length) {
            const r = await runSearch({
              type: "singleSet", projectId: pid,
              set: { userArticleIds: [], articleIds: [], authorIds: [], folderIds: [], tagIds: [] },
              outputType: "articles", showPlaceholders: true, per: 20, page: 1,
              stringFilter: String(seeds[0]), stringFilterTypes: ["title", "abstract"],
            }, { per: 20, polls: 4 });
            searchId = r.searchId;
          }
        } catch { /* fall through to the no-searchId guard */ }
        if (!searchId) {
          return { ok: false, backend: "rr", error: "Could not create a ResearchRabbit search for the session (no seeds resolved and keyword fallback failed).", missing };
        }
        const session = await rrFetch("/search-sessions", {
          method: "POST",
          body: {
            session: { projectId: pid, ...(title ? { title } : {}) },
            stepNumber: 0, selected: [], inspectedType: null, inspectedId: null,
            view: "list", searchId,
          },
        });
        const sessionId = session && (session.id || (session.data && session.data.id));
        const steps = (session && (session.steps || (session.data && session.data.steps))) || [];
        const stepId = steps[0] && steps[0].id;
        return {
          ok: true, backend: "rr", sessionId, stepId, searchId, missing, title: title || null,
          link: sessionId ? `${RR_APP_BASE}/search/${sessionId}/0` : null,
        };
      });
    },

    async getSession(id) {
      return guarded(async () => {
        if (!configured) return notConfigured("sessions");
        const pid = await ensureProjectId();
        if (!pid) return needProject("sessions");
        return await rrFetch(`/search-sessions/${encodeURIComponent(id)}`, { query: { projectId: pid } });
      });
    },

    async updateSessionStep({ sessionId, stepId, step } = {}) {
      return guarded(async () => {
        if (!configured) return notConfigured("sessions");
        return await rrFetch(`/search-sessions/${encodeURIComponent(sessionId)}/steps/${encodeURIComponent(stepId)}`, {
          method: "PATCH", body: step || {},
        });
      });
    },

    buildSessionLink({ sessionId, stepIndex } = {}) {
      if (!configured) return notConfigured("session links");
      const sid = sessionId || "{sessionId}";
      const step = stepIndex != null ? stepIndex : 0;
      return { ok: true, backend: "rr", url: `${RR_APP_BASE}/search/${sid}/${step}` };
    },

    // --- collections / library ----------------------------------------------
    async listCollections() {
      return guarded(async () => {
        if (!configured) return notConfigured("collections");
        const pid = await ensureProjectId();
        if (!pid) return needProject("collections");
        const data = await rrFetch("/folders", { query: { projectId: pid, includeItemCounts: "true", sortBy: "createdAt", sortDirection: "asc", page: 1, per: 50 } });
        const folders = (data && (data.items || data)) || [];
        const items = (Array.isArray(folders) ? folders : []).map((f) => ({
          collectionId: String(f.id), name: f.name, color: f.color,
          itemCount: Number(f.itemCount || 0), position: f.position, projectId: f.projectId,
        }));
        return { ok: true, backend: "rr", collections: items };
      });
    },

    async createCollection({ name, color } = {}) {
      return guarded(async () => {
        if (!configured) return notConfigured("collections");
        const pid = await ensureProjectId();
        if (!pid) return needProject("collections");
        const f = await rrFetch("/folders", {
          method: "POST",
          query: { projectId: pid, includeItemCounts: "true" },
          body: { name: String(name || ""), color: color || "#7c3aed", projectId: pid },
        });
        return { ok: true, backend: "rr", collectionId: String(f.id), name: f.name, color: f.color };
      });
    },

    async saveToLibrary({ ids, collectionId } = {}) {
      return guarded(async () => {
        if (!configured) return notConfigured("library");
        const pid = await ensureProjectId();
        if (!pid) return needProject("library");
        const articleIds = (Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean);
        const res = await rrFetch("/user-articles/batch", {
          method: "POST",
          query: { page: 1, per: Math.max(articleIds.length, 1) },
          body: { articleIds, projectId: pid, ...(collectionId ? { folderId: collectionId } : {}) },
        });
        return { ok: true, backend: "rr", saved: articleIds.length, result: res };
      });
    },

    async listLibrary() {
      return guarded(async () => {
        if (!configured) return notConfigured("library");
        const pid = await ensureProjectId();
        if (!pid) return needProject("library");
        const data = await rrFetch("/user-articles", { query: { projectId: pid, sortBy: "nickname", sortDirection: "asc", page: 1, per: 50 } });
        const items = ((data && (data.items || [])) || []).map((it) => rrListItem((it.details || it)));
        return listResponse({ kind: "library" }, items, data && data.totalCount);
      });
    },

    async listRecent() {
      return guarded(async () => {
        if (!configured) return notConfigured("recently found");
        const pid = await ensureProjectId();
        if (!pid) return needProject("recently found");
        const data = await rrFetch("/recent-articles", { query: { projectId: pid, isSaved: "false", page: 1, per: 20 } });
        const items = ((data && (data.items || [])) || []).map((it) => rrListItem((it.details || it)));
        return listResponse({ kind: "recent" }, items, data && data.totalCount);
      });
    },

    async listReadings() {
      return guarded(async () => {
        if (!configured) return notConfigured("reading list");
        const pid = await ensureProjectId();
        if (!pid) return needProject("reading list");
        const data = await rrFetch("/readings", { query: { projectId: pid, page: 0, per: 2000 } });
        const items = ((data && (data.items || [])) || []).map((it) => rrListItem((it.details || it)));
        return listResponse({ kind: "readings" }, items, data && data.totalCount);
      });
    },

    async getSearchResults(id) {
      return guarded(async () => {
        if (!configured) return notConfigured("search re-read");
        const pid = await ensureProjectId();
        if (!pid) return needProject("search re-read");
        const data = await rrFetch(`/searches/${encodeURIComponent(id)}`, { query: { projectId: pid } });
        const { items, totalCount } = parseResultsField(data);
        return listResponse({ kind: "search", id }, items.map((it) => rrListItem(it)), totalCount);
      });
    },

    async findGaps({ seeds, collectionId } = {}) {
      return guarded(async () => {
        if (!configured) return notConfigured("gap analysis");
        const pid = await ensureProjectId();
        if (!pid) return needProject("gap analysis");
        if (!collectionId) {
          return { ok: false, backend: "rr", error: "find_gaps needs a collectionId to compare the network against. Pass the target collection id." };
        }
        const { resolved } = await resolveSeeds(seeds || []);
        if (!resolved.length) return listResponse({ kind: "gaps", seeds, collectionId }, [], 0);
        const { items } = await runSearch({
          type: "singleSet", projectId: pid,
          set: { userArticleIds: [], articleIds: resolved, authorIds: [], folderIds: [], tagIds: [], edgeMode: "both" },
          outputType: "articles", showPlaceholders: true, per: 20, page: 1,
        }, { per: 20 });
        let collIds = new Set();
        try {
          const coll = await rrFetch(`/folders/${encodeURIComponent(collectionId)}`, { query: { projectId: pid } });
          const arts = (coll && (coll.articles || coll.items)) || [];
          collIds = new Set(arts.map((a) => String((a.details && a.details.id) || a.id || "")));
        } catch { /* best-effort */ }
        const mapped = items
          .map((it) => rrListItem(it, { numSeeds: resolved.length }))
          .filter((it) => it.articleId && !collIds.has(it.articleId));
        return listResponse({ kind: "gaps", seeds, collectionId }, mapped, mapped.length);
      });
    },

    cacheStats() { return { configured, entries: cache.size() }; },
  };
}

module.exports = createRrAdapter;
module.exports.createRrAdapter = createRrAdapter;
