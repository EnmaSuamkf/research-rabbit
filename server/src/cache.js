// Tiny in-memory article-metadata cache. OpenAlex is fast and free, but a
// resolution/expand loop can hit the same work many times in one conversation,
// so caching for CACHE_TTL_SECONDS (default 1 day) keeps tool calls cheap and
// repeatable. RR refreshes weekly, so a day is safe per §14.3.

const DEFAULT_TTL = Number(process.env.CACHE_TTL_SECONDS) || 86400;

class TtlCache {
  constructor(ttlSeconds = DEFAULT_TTL) {
    this.ttl = ttlSeconds * 1000;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expires: Date.now() + this.ttl });
  }

  // Memoise an async producer.
  async getOrFetch(key, producer) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    if (value !== undefined && value !== null) this.set(key, value);
    return value;
  }

  size() {
    return this.store.size;
  }

  stats() {
    return { hits: this.hits, misses: this.misses, entries: this.store.size, ttlSeconds: this.ttl / 1000 };
  }
}

module.exports = { TtlCache };
