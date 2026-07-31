// Shared mapping from an OpenAlex work to the §7 item shape returned by every
// list endpoint, plus the two derived fields that do most of the explaining:
// `seedHits` (how many of the user's seeds connect to an item) and
// `citationsPerYear` (stops an old, well-cited paper from always winning).
//
// OpenAlex ids are full URLs (https://openalex.org/W123); the gateway exposes
// the short bare form (W123) as `articleId`, matching the §6 OpenAlex strategy.

const OA = "https://openalex.org/";

// --- id / doi normalisation -------------------------------------------------

function bareOpenalexId(full) {
  if (!full) return null;
  const s = String(full);
  return s.startsWith(OA) ? s.slice(OA.length) : s;
}

function fullOpenalexId(bare) {
  if (!bare) return null;
  const s = String(bare);
  return s.startsWith(OA) ? s : OA + s;
}

// "https://doi.org/10.1016/…" | "doi:10.1016/…" | "10.1016/…" -> "10.1016/…"
function bareDoi(doi) {
  if (!doi) return null;
  let s = String(doi).trim();
  if (s.toLowerCase().startsWith("https://doi.org/")) s = s.slice("https://doi.org/".length);
  else if (s.toLowerCase().startsWith("http://doi.org/")) s = s.slice("http://doi.org/".length);
  else if (s.toLowerCase().startsWith("doi:")) s = s.slice(4);
  return s || null;
}

function doiUrl(doi) {
  const b = bareDoi(doi);
  return b ? "https://doi.org/" + b : null;
}

// --- text helpers ------------------------------------------------------------

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Token Jaccard similarity, 0..1. Good enough for "did we resolve the right paper?".
function titleSimilarity(a, b) {
  const ta = new Set(normTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normTitle(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// OpenAlex stores the abstract as an inverted index: { word: [pos, pos, ...] }.
function reconstructAbstract(inverted) {
  if (!inverted || typeof inverted !== "object") return null;
  const positions = [];
  for (const [word, idxs] of Object.entries(inverted)) {
    for (const i of idxs) positions[i] = word;
  }
  const text = positions.filter(Boolean).join(" ");
  return text || null;
}

// --- derived metrics ---------------------------------------------------------

function currentYear() {
  return new Date().getFullYear();
}

function citationsPerYear(citedByCount, year) {
  const y = Number(year);
  if (!y || y <= 0) return 0;
  const denom = Math.max(1, currentYear() - y);
  return Math.round((Number(citedByCount) || 0) / denom);
}

// Which of the user's seeds connect to this candidate work? A seed "connects"
// if the candidate cites the seed (seed id is in candidate.referenced_works) OR
// the seed cites the candidate (candidate id is in the seed's referenced_works).
// Returns the SET of connecting seed ids (so seedHits = set.size).
function connectingSeeds(work, seedIds, seedRefsBySeed) {
  const connected = new Set();
  const candBare = bareOpenalexId(work.id);
  if (seedIds && seedIds.size) {
    const refs = Array.isArray(work.referenced_works) ? work.referenced_works : [];
    for (const r of refs) {
      const b = bareOpenalexId(r);
      if (seedIds.has(b)) connected.add(b);
    }
  }
  if (seedRefsBySeed && seedRefsBySeed.size) {
    for (const [seedId, refSet] of seedRefsBySeed.entries()) {
      if (refSet && refSet.has(candBare)) connected.add(seedId);
    }
  }
  return connected;
}

// --- formatters --------------------------------------------------------------

// One §7 list item. opts: { seedIds:Set, seedRefsBySeed:Map, scoreOverride }.
function shapeListItem(work, opts = {}) {
  const seedSet = opts.seedIds || null;
  const seedRefs = opts.seedRefsBySeed || null;
  const connected = connectingSeeds(work, seedSet, seedRefs);
  const seedHits = connected.size;
  const authors = Array.isArray(work.authorships)
    ? work.authorships.map((a) => a && a.author && a.author.display_name).filter(Boolean)
    : [];
  const venue =
    (work.primary_location && work.primary_location.source && work.primary_location.source.display_name) || null;
  const year = Number(work.publication_year) || null;
  const score =
    opts.scoreOverride !== undefined && opts.scoreOverride !== null
      ? opts.scoreOverride
      : seedSet
      ? seedHits
      : Number(work.relevance_score) || 0;
  return {
    articleId: bareOpenalexId(work.id),
    title: work.title || null,
    authors: authors.join(", "),
    year,
    venue,
    doi: bareDoi(work.doi),
    url: doiUrl(work.doi),
    citedBy: Number(work.cited_by_count) || 0,
    references: Array.isArray(work.referenced_works) ? work.referenced_works.length : 0,
    doctype: work.type || null,
    retracted: !!work.is_retracted,
    score,
    seedHits,
    citationsPerYear: citationsPerYear(work.cited_by_count, year),
  };
}

// Full metadata for /api/articles/:idOrDoi. authorHIndex is a Map<bareAuthorId, h_index>.
function shapeDetail(work, authorHIndex = new Map()) {
  const authors = (Array.isArray(work.authorships) ? work.authorships : [])
    .map((a) => {
      const bare = bareOpenalexId(a && a.author && a.author.id);
      return {
        name: a && a.author && a.author.display_name,
        authorId: bare,
        orcid: a && a.author && a.author.orcid ? String(a.author.orcid).replace("https://orcid.org/", "") : null,
        hIndex: bare && authorHIndex.has(bare) ? authorHIndex.get(bare) : null,
      };
    });
  const venue =
    (work.primary_location && work.primary_location.source && work.primary_location.source.display_name) || null;
  const year = Number(work.publication_year) || null;
  return {
    articleId: bareOpenalexId(work.id),
    title: work.title || null,
    authors,
    authorsString: authors.map((a) => a.name).filter(Boolean).join(", "),
    year,
    venue,
    doi: bareDoi(work.doi),
    url: doiUrl(work.doi),
    citedBy: Number(work.cited_by_count) || 0,
    references: Array.isArray(work.referenced_works) ? work.referenced_works.length : 0,
    doctype: work.type || null,
    retracted: !!work.is_retracted,
    isOa: !!(work.open_access && work.open_access.is_oa),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    referencedWorkIds: (Array.isArray(work.referenced_works) ? work.referenced_works : []).map(bareOpenalexId),
    relatedWorkIds: (Array.isArray(work.related_works) ? work.related_works : []).map(bareOpenalexId),
    citationsPerYear: citationsPerYear(work.cited_by_count, year),
    primaryLocationUrl:
      (work.primary_location && work.primary_location.landing_page_url) ||
      (work.primary_location && work.primary_location.source && work.primary_location.source.host_organization_name) ||
      null,
  };
}

module.exports = {
  OA,
  bareOpenalexId,
  fullOpenalexId,
  bareDoi,
  doiUrl,
  normTitle,
  titleSimilarity,
  reconstructAbstract,
  currentYear,
  citationsPerYear,
  connectingSeeds,
  shapeListItem,
  shapeDetail,
};
