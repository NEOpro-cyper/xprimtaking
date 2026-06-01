/**
 * In-Memory Cache with configurable TTL
 *
 * Stores successful stream responses so subsequent requests
 * for the same movie/show are instant (no Altcha re-solve needed).
 *
 * Cache key = "movie:{tmdbId}" or "tv:{tmdbId}:{season}:{episode}"
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class StreamCache {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.stats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

    // Auto-cleanup every 2 minutes
    this._cleanupInterval = setInterval(() => this._cleanup(), 2 * 60 * 1000);
  }

  buildKey({ tmdbId, type = 'movie', season, episode }) {
    if (type === 'tv' && season != null && episode != null) {
      return `tv:${tmdbId}:s${season}:e${episode}`;
    }
    return `${type}:${tmdbId}`;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      this.stats.evictions++;
      return null;
    }

    entry.hitCount++;
    this.stats.hits++;

    const remainingSec = Math.round((entry.expiresAt - Date.now()) / 1000);
    console.log(`[CACHE] HIT "${key}" (hits: ${entry.hitCount}, TTL: ${remainingSec}s left)`);

    return { ...entry, remainingTtl: entry.expiresAt - Date.now() };
  }

  set(key, data) {
    const now = Date.now();
    const entry = { data, cachedAt: now, expiresAt: now + this.ttlMs, hitCount: 0 };

    this.cache.set(key, entry);
    this.stats.sets++;

    console.log(`[CACHE] SET "${key}" (expires in ${this.ttlMs / 1000}s)`);
    return entry;
  }

  getAll() {
    const entries = [];
    const now = Date.now();

    for (const [key, entry] of this.cache) {
      entries.push({
        key,
        cachedAt: new Date(entry.cachedAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString(),
        remainingSec: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
        hitCount: entry.hitCount,
        hasUrl: !!(entry.data?.url || entry.data?.streams),
      });
    }

    return entries.sort((a, b) => b.hitCount - a.hitCount);
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      ttlSeconds: this.ttlMs / 1000,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? `${((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(1)}%`
        : 'N/A',
    };
  }

  clear(key) {
    if (key) return this.cache.delete(key);
    this.cache.clear();
    console.log('[CACHE] Cleared all entries');
    return true;
  }

  _cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        this.stats.evictions++;
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[CACHE] Cleaned ${cleaned} expired entries (${this.cache.size} remaining)`);
    }
  }
}
