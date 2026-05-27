// File: src/debrid/cachedInfoCache.js
// Version: 1.0 – In-memory TTL cache for pre-resolved torrent info

/**
 * A simple in‑memory cache with per‑entry TTL (time‑to‑live).
 * Entries are discarded after `ttlMs` milliseconds.
 */
class TTLCache {
  constructor(defaultTTLMs = 12 * 60 * 60 * 1000) { // 12 hours
    this.store = new Map();
    this.defaultTTL = defaultTTLMs;
  }

  set(key, value, ttlMs = this.defaultTTL) {
    const expires = Date.now() + ttlMs;
    this.store.set(key, { value, expires });
    // Lazy clean of this key when accessed via get, but we can also schedule cleanup
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

export const torrentInfoCache = new TTLCache();
