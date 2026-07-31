// OpenAlex adapter — the default, credentials-free backend (§6 / §14.0).
// Public, free, polite-pool (mailto). Exposes the same method surface the
// gateway routes call; the `rr` adapter mirrors it behind RR_BACKEND=rr.
//
// `articleId` on this backend is the short OpenAlex id (W123), per §6.
// Seeds are always TITLES or DOIs — the adapter resolves them to OpenAlex ids.

const shape = require("../shape");
const { TtlCache } = require("../cache");

const OA_BASE = "https://api.openalex.org";
const MAILTO = process.env.OPENALEX_MAILTO || "warren-copilot@example.com";
const SEED_CAP = Number(process.env.SEED_CAP) || 50;
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS_PER_CONV) || 40;

// Slim field set for list endpoints (includes referenced_works/related_works so
// seedHits and the `references` count can be derived without a second fetch).
const LIST_SELECT = [
  "id", "doi", "title", "publication_year", "type", "is_retracted",
  "cited_by_count", "relevance_score", "authorships", "primary_location",
  "referenced_works", "related_works", "open_access",
].join(",");

const cache = new TtlCache();

// --- low-level fetch --------------------------------------------------------

async function oaFetch(pathname, query = {}) {
  const url = new URL(OA_BASE + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  url.searchParams.set("mailto", MAILTO);
  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const err = new Error(`OpenAlex returned non-JSON (${res.status}) for ${url.pathname}`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `OpenAlex ${res.status} for ${url.pathname}`);
    err.status = res.status;
    err.upstream = body;
    throw err;
  }
  return body;
}

function worksByFilter(filter, { per = 10, select = LIST_SELECT, sort } = {}) {
  const q = { filter, "per-page": Math.min(Math.max(Number(per) || 10, 1), 25) };
  if (select) q.select = select;
  if (sort) q.sort = sort;
  return oaFetch("/works", q);
}

// Batch-fetch many works by OpenAlex id and/or DOI (chunked). W-ids go through
// the `openalex:` filter; DOIs through the `doi:` filter (both accept OR pipes).
async function batchWorks(bareIds, { select = LIST_SELECT } = {}) {
  const entries = [...new Set((bareIds || []).map((s) => String(s).trim()).filter(Boolean))];
  const wIds = entries.filter((s) => /^W\d+$/i.test(shape.bareOpenalexId(s))).map(shape.bareOpenalexId);
  const dois = entries.filter((s) => looksLikeDoi(s)).map((s) => shape.bareDoi(s)).filter(Boolean);
  const out = [];
  for (let i = 0; i < wIds.length; i += 50) {
    const data = await worksByFilter(`openalex:${wIds.slice(i, i + 50).join("|")}`, { per: 50, select });
    out.push(...(data.results || []));
  }
  for (let i = 0; i < dois.length; i += 50) {
    const data = await worksByFilter(`doi:${dois.slice(i, i + 50).join("|")}`, { per: 50, select });
    out.push(...(data.results || []));
  }
  // Dedup by OpenAlex id.
  const seen = new Set();
  return out.filter((w) => { const b = shape.bareOpenalexId(w.id); if (!b || seen.has(b)) return false; seen.add(b); return true; });
}

// Fetch one work fully (no select) — gives abstract_inverted_index etc. Cached.
async function fetchWorkFull(bareOrDoi) {
  const key = `full:${shape.bareOpenalexId(bareOrDoi) || shape.bareDoi(bareOrDoi)}`;
  return cache.getOrFetch(key, async () => {
    const bare = shape.bareOpenalexId(bareOrDoi);
    if (bare && /^W\d+$/i.test(bare)) return oaFetch(`/works/${bare}`);
    const doi = shape.bareDoi(bareOrDoi);
    if (doi) return oaFetch(`/works/doi:${doi}`);
    return null;
  });
}

// Fetch author records (for h-index) in one batched call. Returns Map<bareId, h_index>.
async function authorHIndexMap(bareAuthorIds) {
  const ids = [...new Set(bareAuthorIds.map(shape.bareOpenalexId).filter(Boolean))];
  if (!ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const data = await oaFetch("/authors", {
        filter: `openalex:${chunk.join("|")}`,
        "per-page": 50,
        select: "id,summary_stats",
      });
      for (const a of data.results || []) {
        const h = a.summary_stats && a.summary_stats.h_index;
        out.set(shape.bareOpenalexId(a.id), h == null ? null : h);
      }
    } catch {
      /* non-fatal: h-index is best-effort */
    }
  }
  return out;
}

// --- resolution (the anti-hallucination keystone) --------------------------

function looksLikeDoi(s) {
  const v = String(s || "").trim();
  return /^doi:/i.test(v) || /^https?:\/\/(dx\.)?doi\.org\//i.test(v) || /^10\.\d{4,9}\//.test(v);
}

// OpenAlex treats * and ? as wildcard operators in `search=`. Titles/phrases
// often end with "?" or contain them, so strip wildcards before searching.
function sanitizeSearch(s) {
  return String(s || "").replace(/[.*?]/g, " ").replace(/\s+/g, " ").trim();
}

// Resolve a title or DOI to ONE OpenAlex work (full). Cached by query.
async function resolveWork(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  return cache.getOrFetch(`resolve:${q.toLowerCase()}`, async () => {
    if (looksLikeDoi(q)) {
      const doi = shape.bareDoi(q);
      try {
        return await oaFetch(`/works/doi:${doi}`);
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    }
    // Title search: take the top hit. Strip OpenAlex wildcard chars first.
    const cleaned = sanitizeSearch(q);
    if (!cleaned) return null;
    const res = await oaFetch("/works", { search: cleaned, "per-page": 1, select: LIST_SELECT });
    const top = res.results && res.results[0];
    if (!top) return null;
    // Promote to a full work (with abstract) lazily only if caller needs detail;
    // for resolution the slim work is enough, but callers of resolveWork often
    // need referenced_works for seedHits — LIST_SELECT already includes them.
    return top;
  });
}

// Resolve an array of seed titles/DOIs to full-ish works. Returns { resolved, missing }.
async function resolveSeeds(seeds) {
  const resolved = [];
  const missing = [];
  for (const s of seeds || []) {
    const w = await resolveWork(s);
    if (w) resolved.push(w);
    else missing.push(s);
  }
  return { resolved, missing };
}

// Build the seed context: a Set of seed ids + a Map seedId -> Set(referenced bare ids).
function seedContext(seedWorks) {
  const seedIds = new Set(seedWorks.map((w) => shape.bareOpenalexId(w.id)).filter(Boolean));
  const seedRefsBySeed = new Map();
  for (const w of seedWorks) {
    const id = shape.bareOpenalexId(w.id);
    const refs = new Set((w.referenced_works || []).map(shape.bareOpenalexId));
    seedRefsBySeed.set(id, refs);
  }
  return { seedIds, seedRefsBySeed };
}

// --- response wrappers ------------------------------------------------------

function listResponse(query, items, totalCount) {
  return {
    query,
    totalCount: totalCount == null ? items.length : totalCount,
    seedCap: SEED_CAP,
    backend: "openalex",
    items,
  };
}

// --- public adapter surface -------------------------------------------------

module.exports = {
  backend: "openalex",

  health() {
    return { ok: true, backend: "openalex", authOk: true, plan: "free", seedCap: SEED_CAP };
  },

  context() {
    return { plan: "free", seedCap: SEED_CAP, backend: "openalex", projectId: null, maxToolCalls: MAX_TOOL_CALLS };
  },

  async searchKeyword({ q, per }) {
    const n = Math.min(Math.max(Number(per) || 10, 1), 20);
    const cleaned = sanitizeSearch(q);
    if (!cleaned) return listResponse({ kind: "keyword", q, per: n }, [], 0);
    const data = await oaFetch("/works", { search: cleaned, "per-page": n, select: LIST_SELECT });
    const items = (data.results || []).map((w) => shape.shapeListItem(w, { scoreOverride: Number(w.relevance_score) || 0 }));
    return listResponse({ kind: "keyword", q, per: n }, items, data.meta && data.meta.count);
  },

  async searchNetwork({ seeds, edgeMode = "both", sinceYear, per }) {
    const n = Math.min(Math.max(Number(per) || 10, 1), 20);
    const { resolved, missing } = await resolveSeeds(seeds);
    if (!resolved.length) {
      return listResponse({ kind: "network", edgeMode, seeds, per: n, missing }, [], 0);
    }
    const { seedIds, seedRefsBySeed } = seedContext(resolved);
    const pool = new Map(); // bareId -> work
    const add = (works) => works.forEach((w) => { const b = shape.bareOpenalexId(w.id); if (b && !seedIds.has(b)) pool.set(b, w); });

    const yearFilter = sinceYear ? `,from_publication_date:${Number(sinceYear)}-01-01` : "";

    if (edgeMode === "forward" || edgeMode === "both") {
      const f = await worksByFilter(`cites:${[...seedIds].join("|")}${yearFilter}`, { per: Math.min(n, 25) });
      add(f.results || []);
    }
    if (edgeMode === "backward" || edgeMode === "both") {
      const refIds = [];
      for (const w of resolved) for (const r of w.referenced_works || []) refIds.push(shape.bareOpenalexId(r));
      const refs = await batchWorks(refIds);
      add(refs);
    }
    if (edgeMode === "both") {
      const relIds = [];
      for (const w of resolved) for (const r of w.related_works || []) relIds.push(shape.bareOpenalexId(r));
      const rels = await batchWorks(relIds);
      add(rels);
    }

    const items = [...pool.values()]
      .map((w) => shape.shapeListItem(w, { seedIds, seedRefsBySeed }))
      .sort((a, b) => b.seedHits - a.seedHits || b.citationsPerYear - a.citationsPerYear)
      .slice(0, n);
    return listResponse({ kind: "network", edgeMode, seeds, per: n, missing }, items, pool.size);
  },

  async searchAuthor({ name, authorIds, per }) {
    const n = Math.min(Math.max(Number(per) || 10, 1), 20);
    let ids = [];
    if (authorIds && authorIds.length) {
      ids = authorIds.map(shape.bareOpenalexId).filter(Boolean);
    } else if (name) {
      const a = await oaFetch("/authors", { search: String(name).trim(), "per-page": 5, select: "id,display_name,works_count,summary_stats" });
      ids = (a.results || []).map((x) => shape.bareOpenalexId(x.id));
    }
    if (!ids.length) return { backend: "openalex", authors: [], ...listResponse({ kind: "author", name, authorIds, per: n }, [], 0) };

    const authors = (await oaFetch("/authors", { filter: `openalex:${ids.join("|")}`, "per-page": 50, select: "id,display_name,works_count,cited_by_count,summary_stats" })).results || [];
    const authorMeta = authors.map((a) => ({
      authorId: shape.bareOpenalexId(a.id),
      name: a.display_name,
      worksCount: a.works_count,
      citedBy: a.cited_by_count,
      hIndex: a.summary_stats && a.summary_stats.h_index,
    }));

    const data = await worksByFilter(`author.id:${ids.join("|")}`, { per: n, sort: "cited_by_count:desc" });
    const items = (data.results || []).map((w) => shape.shapeListItem(w, { scoreOverride: Number(w.relevance_score) || 0 }));
    return { backend: "openalex", authors: authorMeta, ...listResponse({ kind: "author", name, authorIds, per: n }, items, data.meta && data.meta.count) };
  },

  async expand({ seeds, iterations = 2, limit }) {
    const lim = Math.min(Math.max(Number(limit) || 10, 1), 20);
    const iters = Math.min(Math.max(Number(iterations) || 2, 1), 4);
    const { resolved, missing } = await resolveSeeds(seeds);
    if (!resolved.length) return listResponse({ kind: "expand", seeds, iterations: iters, limit: lim, missing }, [], 0);

    const { seedIds, seedRefsBySeed } = seedContext(resolved);
    const pool = new Map();
    const expanded = new Set();
    const add = (works) => works.forEach((w) => { const b = shape.bareOpenalexId(w.id); if (b && !seedIds.has(b)) pool.set(b, w); });

    // Seed the pool with the full both-direction network of the original seeds.
    const fwd = await worksByFilter(`cites:${[...seedIds].join("|")}`, { per: 25 });
    add(fwd.results || []);
    const refIds = []; const relIds = [];
    for (const w of resolved) {
      (w.referenced_works || []).forEach((r) => refIds.push(shape.bareOpenalexId(r)));
      (w.related_works || []).forEach((r) => relIds.push(shape.bareOpenalexId(r)));
    }
    add(await batchWorks(refIds));
    add(await batchWorks(relIds));

    // Grow: expand the top candidates' own references + related (bounded).
    const BRANCH = 3;
    for (let it = 1; it < iters; it++) {
      const ranked = [...pool.values()]
        .map((w) => shape.shapeListItem(w, { seedIds, seedRefsBySeed }))
        .sort((a, b) => b.seedHits - a.seedHits || b.citationsPerYear - a.citationsPerYear);
      const frontier = ranked.slice(0, BRANCH).filter((c) => !expanded.has(c.articleId));
      if (!frontier.length) break;
      const newIds = [];
      for (const c of frontier) {
        expanded.add(c.articleId);
        const w = pool.get(c.articleId);
        if (!w) continue;
        (w.referenced_works || []).slice(0, 20).forEach((r) => newIds.push(shape.bareOpenalexId(r)));
        (w.related_works || []).forEach((r) => newIds.push(shape.bareOpenalexId(r)));
      }
      if (newIds.length) add(await batchWorks(newIds));
    }

    const items = [...pool.values()]
      .map((w) => shape.shapeListItem(w, { seedIds, seedRefsBySeed }))
      .sort((a, b) => b.seedHits - a.seedHits || b.citationsPerYear - a.citationsPerYear)
      .slice(0, lim);
    return listResponse({ kind: "expand", seeds, iterations: iters, limit: lim, missing }, items, pool.size);
  },

  async getArticle(idOrDoiOrTitle) {
    const w = await resolveWork(idOrDoiOrTitle);
    if (!w) return null;
    // Ensure we have the full record (abstract). Slim resolved work lacks abstract.
    const full = (w.abstract_inverted_index === undefined)
      ? await fetchWorkFull(shape.bareOpenalexId(w.id))
      : w;
    const authorIds = (full.authorships || []).map((a) => shape.bareOpenalexId(a.author && a.author.id)).filter(Boolean);
    const hindex = await authorHIndexMap(authorIds);
    return shape.shapeDetail(full, hindex);
  },

  async resolve({ query }) {
    const w = await resolveWork(query);
    if (!w) return { articleId: null, title: null, doi: null, confidence: 0 };
    const sim = shape.titleSimilarity(query, w.title);
    let confidence;
    if (looksLikeDoi(query)) confidence = 1;
    else if (shape.normTitle(query) === shape.normTitle(w.title)) confidence = 1;
    else if (shape.normTitle(w.title).includes(shape.normTitle(query)) || shape.normTitle(query).includes(shape.normTitle(w.title))) confidence = 0.95;
    else confidence = Math.round(sim * 100) / 100;
    return {
      articleId: shape.bareOpenalexId(w.id),
      title: w.title,
      doi: shape.bareDoi(w.doi),
      confidence,
    };
  },

  async screen({ ids, items, yearMin, yearMax, doctype, minCitations, excludeRetracted }) {
    // Accept either bare ids/DOIs (`ids`) or already-shaped items (`items`).
    const idList = [];
    if (Array.isArray(ids)) ids.forEach((x) => idList.push(x));
    if (Array.isArray(items)) items.forEach((it) => idList.push(it.articleId || it.doi || it.id));
    const works = await batchWorks(idList);
    let filtered = works;
    if (yearMin) filtered = filtered.filter((w) => Number(w.publication_year) >= Number(yearMin));
    if (yearMax) filtered = filtered.filter((w) => Number(w.publication_year) <= Number(yearMax));
    if (doctype) {
      const want = String(doctype).toLowerCase();
      filtered = filtered.filter((w) => String(w.type || "").toLowerCase() === want);
    }
    if (minCitations != null) filtered = filtered.filter((w) => Number(w.cited_by_count) >= Number(minCitations));
    if (excludeRetracted) filtered = filtered.filter((w) => !w.is_retracted);
    const out = filtered.map((w) => shape.shapeListItem(w, {}));
    return listResponse({ kind: "screen", yearMin, yearMax, doctype, minCitations, excludeRetracted }, out, filtered.length);
  },

  async credibility({ id, doi, title }) {
    const query = id || doi || title;
    const detail = await module.exports.getArticle(query);
    if (!detail) return { ok: false, backend: "openalex", error: "Could not resolve the article." };
    const topAuthor = detail.authors && detail.authors[0];
    return {
      ok: true,
      backend: "openalex",
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
        "OpenAlex has no dedicated retraction-watch feed; `retracted` is OpenAlex's own flag and may lag.",
        "h-index is OpenAlex's computed value for the first listed author only.",
        "This is a metadata triage, not peer judgement — read the paper before relying on it.",
      ],
    };
  },

  async rank({ items, seeds, sortBy = "seedConsensus" }) {
    // Resolve any bare id/DOI/title entries to shaped items.
    let seedIds = null, seedRefsBySeed = null;
    if (Array.isArray(seeds) && seeds.length) {
      const { resolved } = await resolveSeeds(seeds);
      const ctx = seedContext(resolved);
      seedIds = ctx.seedIds; seedRefsBySeed = ctx.seedRefsBySeed;
    }
    const resolved = [];
    for (const it of items || []) {
      if (it && it.articleId && it.title && it.citedBy != null) {
        resolved.push(it);
      } else {
        const w = await resolveWork(it.articleId || it.doi || it.id || it.title || it);
        if (w) resolved.push(shape.shapeListItem(w, { seedIds, seedRefsBySeed }));
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
    return { backend: "openalex", sortBy, items: ranked };
  },

  async exportBibtex({ ids, dois }) {
    const idList = [];
    if (Array.isArray(ids)) ids.forEach((x) => idList.push(x));
    if (Array.isArray(dois)) dois.forEach((x) => idList.push(x));
    const works = await batchWorks(idList, { select: LIST_SELECT });
    const entries = works.map((w) => {
      const key = (w.authorships && w.authorships[0] && w.authorships[0].author && w.authorships[0].author.display_name || "anon")
        .split(" ").slice(-1)[0] + (w.publication_year || "nd") + (shape.bareOpenalexId(w.id) || "");
      const authors = (w.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean).join(" and ");
      const fields = [
        `title = {${(w.title || "").replace(/[{}]/g, "")}}`,
        `author = {${authors}}`,
        `year = {${w.publication_year || ""}}`,
        `journal = {${(w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || ""}}`,
        `doi = {${shape.bareDoi(w.doi) || ""}}`,
        `url = {${shape.doiUrl(w.doi) || ""}}`,
      ];
      return `@article{${key},\n  ${fields.join(",\n  ")}\n}`;
    });
    return { backend: "openalex", count: entries.length, bibtex: entries.join("\n\n") };
  },

  // --- RR-only endpoints: openalex has no session/collection/library model ---
  _rrOnly(what) {
    return {
      ok: false,
      backend: "openalex",
      error: `ResearchRabbit ${what} require the 'rr' backend. Current backend is 'openalex'.`,
    };
  },
  createSession() { return this._rrOnly("sessions"); },
  getSession() { return this._rrOnly("sessions"); },
  updateSessionStep() { return this._rrOnly("sessions"); },
  buildSessionLink({ sessionId, stepIndex, query } = {}) {
    const fallbackUrl = query ? `https://openalex.org/works?search=${encodeURIComponent(query)}` : null;
    return {
      ok: false,
      backend: "openalex",
      error: "ResearchRabbit session deep links (app.researchrabbit.ai/search/…) require the 'rr' backend.",
      fallback: fallbackUrl
        ? `OpenAlex search URL (no RR session): ${fallbackUrl}`
        : "On the openalex backend, share the DOI URL or an OpenAlex search URL instead.",
    };
  },
  listCollections() { return this._rrOnly("collections"); },
  createCollection() { return this._rrOnly("collections"); },
  saveToLibrary() { return this._rrOnly("library"); },
  listLibrary() { return this._rrOnly("library"); },
  listRecent() { return this._rrOnly("recently found"); },
  listReadings() { return this._rrOnly("reading list"); },
  getSearchResults(idOrDoi) { return module.exports.getArticle(idOrDoi); }, // alias of get_article on openalex
  findGaps() {
    return {
      ok: false,
      backend: "openalex",
      error: "Gap analysis against a ResearchRabbit collection requires the 'rr' backend. Use expand_frontier on openalex for a similar 'what am I missing?' exploration.",
    };
  },

  cacheStats() { return cache.stats(); },
};
