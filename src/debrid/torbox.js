// File: src/debrid/torbox.js
// Version: 3.0 – Verified TorBox API endpoints, rate‑limiting, dedup, slot management

import axios from 'axios';
import FormData from 'form-data';
import { TORBOX_API_KEY, TORBOX_MAX_ACTIVE_TORRENTS } from '../../config.js';
import { logger } from '../utils.js';

const BASE_URL = 'https://api.torbox.app/v1/api';
const apiKey = TORBOX_API_KEY;

// ── Custom Error ─────────────────────────────────────────────────
class ResourceNotFoundError extends Error {
  constructor(message = 'TorBox resource not found') {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

// ── Cache (injected by factory) ─────────────────────────────────
let cache = null;

export function setup(cacheInstance) {
  cache = cacheInstance;
}

// ── In‑Memory Helpers ────────────────────────────────────────────
const torrentSelections = new Map();   // torrentId → Set of real file IDs
const recentMagnetAdds = new Map();    // infoHash → { timestamp, torrentId }
const addMagnetTimestamps = [];       // rate‑limit tracking
const MAX_ADDS_PER_MINUTE = 8;
const ADD_COOLDOWN_MS = 60_000;
const DEDUP_WINDOW_MS = 30_000;
const RATE_LIMIT_WINDOW = 2000;       // kept for backward compat but overridden by token‑bucket

// ── Helper: extract info hash ────────────────────────────────────
function extractInfoHash(magnet) {
  const m = magnet.match(/btih:([a-fA-F0-9]{40})/);
  return m ? m[1].toLowerCase() : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Rate‑Limiting (token bucket style, as in model) ──────────────
function checkAddMagnetRateLimit() {
  const now = Date.now();
  while (addMagnetTimestamps.length > 0 && addMagnetTimestamps[0] < now - ADD_COOLDOWN_MS) {
    addMagnetTimestamps.shift();
  }
  if (addMagnetTimestamps.length >= MAX_ADDS_PER_MINUTE) return false;
  addMagnetTimestamps.push(now);
  return true;
}

// ── Active Slot Management ───────────────────────────────────────
const ACTIVE_STATES = new Set([
  'downloading', 'metadl', 'checkingresumedata',
  'stalled (no seeds)', 'uploading', 'seeding'
]);
const STALE_STATES = new Set([
  'stalled (no seeds)', 'paused', 'error', 'failed', 'missingfiles', 'expired'
]);

async function getActiveTorrentCount() {
  try {
    const response = await axios.get(`${BASE_URL}/torrents/mylist`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const list = response.data.data || response.data;
    if (!Array.isArray(list)) return { count: -1, staleList: [] };
    const active = list.filter(t => ACTIVE_STATES.has((t.status || '').toLowerCase()));
    const stale = active.filter(t => STALE_STATES.has((t.status || '').toLowerCase()));
    return { count: active.length, staleList: stale.map(t => t.id) };
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to count active torrents.');
    return { count: -1, staleList: [] };
  }
}

async function deleteTorrentFromProvider(torrentId) {
  try {
    logger.info({ torrentId }, 'Deleting torrent from TorBox...');
    const form = new FormData();
    form.append('id', torrentId);
    form.append('action', 'delete');
    await axios.post(`${BASE_URL}/torrents/controltorrent`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
    });
    return true;
  } catch (error) {
    logger.warn({ torrentId, err: error.message }, 'Failed to delete torrent from TorBox.');
    return false;
  }
}

async function cleanupStaleActiveTorrents(maxActive) {
  if (maxActive <= 0) return;
  const { count, staleList } = await getActiveTorrentCount();
  if (count < 0 || count < maxActive) return;
  const needToRemove = count - maxActive + 1;
  const toRemove = staleList.slice(0, Math.min(needToRemove, staleList.length));
  if (toRemove.length === 0) {
    logger.warn({ activeCount: count, maxActive }, 'All active torrent slots full, no stale ones.');
    return;
  }
  logger.info({ activeCount: count, maxActive, removing: toRemove }, 'Cleaning stale active torrents.');
  for (const id of toRemove) {
    await deleteTorrentFromProvider(id);
    // remove mapping
    if (cache) {
      const row = await cache.getByProviderId(id);
      if (row) await cache.update(row.hash, { status: 'deleted' });
    }
  }
}

// ── Fetch full torrent info (via mylist? id=) ────────────────────
async function fetchFullTorrentInfo(torrentId) {
  const { data } = await axios.get(`${BASE_URL}/torrents/mylist`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { id: torrentId },
  });
  const list = data.data || data;
  const item = Array.isArray(list) ? list[0] : list;
  if (!item) throw new ResourceNotFoundError(`Torrent ID ${torrentId} not found.`);
  return item;
}

// ── Map status ───────────────────────────────────────────────────
function mapStatus(tbStatus) {
  const s = (tbStatus || '').toLowerCase();
  if (['completed', 'cached', 'uploading', 'seeding', 'active', 'downloaded'].includes(s)) return 'downloaded';
  if (['downloading', 'metadl', 'checkingresumedata', 'stalled', 'queued'].includes(s)) return 'downloading';
  if (['error', 'failed', 'missingfiles', 'expired'].includes(s)) return 'error';
  return 'downloading';
}

// ── The Provider Object ──────────────────────────────────────────
const torbox = {
  setup,                     // ← must be attached
  isEnabled: !!apiKey,

  // ── 1. addMagnet ──────────────────────────────────────────────
  async addMagnet(magnet) {
    const infohash = extractInfoHash(magnet);
    if (!infohash) throw new Error('Invalid magnet link');

    // Deduplicate recent additions
    if (infohash && recentMagnetAdds.has(infohash)) {
      const prev = recentMagnetAdds.get(infohash);
      if (Date.now() - prev.timestamp < DEDUP_WINDOW_MS) {
        logger.info({ infohash, torrentId: prev.torrentId }, 'Torrent recently added, reusing ID.');
        return { id: prev.torrentId, hash: infohash, cached: true };
      }
    }

    // Rate limit
    if (!checkAddMagnetRateLimit()) {
      logger.warn('addMagnet rate limit exceeded.');
      throw new Error('TorBox addMagnet rate limit exceeded. Please wait.');
    }

    // Active slot management
    const maxActive = TORBOX_MAX_ACTIVE_TORRENTS || 0;
    if (maxActive > 0) {
      await cleanupStaleActiveTorrents(maxActive);
    }

    // Check local cache for existing mapping
    if (cache) {
      const cached = await cache.get(infohash);
      if (cached && cached.provider_torrent_id) {
        try {
          const info = await this.getTorrentInfo(cached.provider_torrent_id);
          return { id: cached.provider_torrent_id, hash: infohash, cached: true, ...info };
        } catch (e) { /* stale, will add fresh */ }
      }
    }

    // Retry loop
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const form = new FormData();
        form.append('magnet', magnet);
        const response = await axios.post(`${BASE_URL}/torrents/createtorrent`, form, {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
        });
        const payload = response.data.data || response.data;
        const torrentId = payload.torrent_id || payload.id;
        const hash = payload.hash;
        const isCachedTorrent = (response.data.detail || '').toLowerCase().includes('cached torrent');

        if (torrentId && hash) {
          // Save mapping
          if (cache) {
            await cache.set(hash, { provider_torrent_id: torrentId, status: 'active', extra: {} });
          }
          if (infohash) recentMagnetAdds.set(infohash, { timestamp: Date.now(), torrentId });
          return { id: torrentId, hash, name: payload.name, cached: isCachedTorrent, ...payload };
        }
        logger.error({ rawResponse: JSON.stringify(response.data) }, 'Missing id/hash in createtorrent response.');
        lastError = new Error('addMagnet response missing id/hash');
        break;
      } catch (error) {
        lastError = error;
        const errCode = (error.response?.data || {}).error || '';
        if (errCode === 'ACTIVE_LIMIT' && attempt < 2) {
          await sleep(5000 * (attempt + 1));
          continue;
        }
        break;
      }
    }
    throw lastError || new Error('Failed to add magnet to TorBox.');
  },

  // ── 2. getTorrentInfo (full info, real file IDs) ──────────────
  async getTorrentInfo(id) {
    try {
      const torrent = await fetchFullTorrentInfo(id);
      const rawStatus = torrent.download_state || torrent.status || 'MISSING';
      const tbStatus = mapStatus(rawStatus);

      const selectedSet = torrentSelections.get(id) || new Set();
      const files = (torrent.files || []).map(f => ({
        id: f.id,                  // real file ID from TorBox
        path: f.name,
        bytes: f.size,
        selected: selectedSet.size === 0 || selectedSet.has(f.id) ? 1 : 0,
      }));

      const links = [];
      if (tbStatus === 'downloaded' && torrent.files) {
        torrent.files.forEach(() => links.push(null));  // placeholders – real links obtained via unrestrictLink
      }

      return { id, filename: torrent.name, status: tbStatus, files, links };
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      if (error.response?.status === 404) throw new ResourceNotFoundError(`Torrent ID ${id} not found.`);
      throw error;
    }
  },

  // ── 3. selectFiles (in‑memory) ─────────────────────────────────
  async selectFiles(id, fileIds = 'all') {
    try {
      const torrent = await fetchFullTorrentInfo(id);
      if (fileIds === 'all') {
        const allIds = (torrent.files || []).map(f => f.id);
        torrentSelections.set(id, new Set(allIds));
      } else {
        const ids = (Array.isArray(fileIds) ? fileIds : String(fileIds).split(',')).map(Number);
        if (!torrentSelections.has(id)) torrentSelections.set(id, new Set());
        const set = torrentSelections.get(id);
        ids.forEach(fid => set.add(fid));
      }
      return true;
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw error;
      throw error;
    }
  },

  // ── 4. unrestrictLink (TorBox direct links are ready) ──────────
  async unrestrictLink(link) {
    if (link && (link.startsWith('http://') || link.startsWith('https://'))) {
      return { download: link };
    }
    throw new Error('TorBox does not support hoster link unrestriction.');
  },

  // ── 5. addAndSelect ────────────────────────────────────────────
  async addAndSelect(magnet) {
    const addRes = await this.addMagnet(magnet);
    const torrentId = addRes.id;
    if (torrentId) {
      await this.selectFiles(torrentId, 'all');
      return this.getTorrentInfo(torrentId);
    }
    return null;
  },

  // ── 6. deleteTorrent ──────────────────────────────────────────
  async deleteTorrent(id) {
    await deleteTorrentFromProvider(id);
    if (cache) {
      const row = await cache.getByProviderId(id);
      if (row) await cache.update(row.hash, { status: 'deleted' });
    }
  },

  // ── 7. getTorrents (list all active torrents) ──────────────────
  async getTorrents() {
    const { data } = await axios.get(`${BASE_URL}/torrents/mylist`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const list = data.data || data;
    if (!Array.isArray(list)) return [];
    return list.map(t => ({
      id: t.id,
      hash: t.hash,
      name: t.name,
      status: t.status || t.download_state,
    }));
  },

  // ── 8. checkCached (native endpoint) ───────────────────────────
  async checkCached(hashes) {
    if (!Array.isArray(hashes) || hashes.length === 0) return {};
    const body = { hashes };
    const params = { format: 'object', list_files: true };
    try {
      const response = await axios.post(`${BASE_URL}/torrents/checkcached`, body, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params,
      });
      const payload = response.data.data || response.data;
      const result = {};
      for (const hash of hashes) {
        const value = payload[hash];
        if (typeof value === 'object' && value !== null) {
          result[hash] = {
            cached: true,
            name: value.name,
            size: value.size,
            files: value.files || [],
          };
        } else {
          result[hash] = { cached: !!value, files: [] };
        }
      }
      const cachedCount = Object.values(result).filter(v => v.cached).length;
      logger.info({ hashCount: hashes.length, cachedCount }, 'TorBox checkCached result');
      return result;
    } catch (err) {
      logger.error({ err: err.message }, 'checkCached failed');
      const empty = {};
      hashes.forEach(h => empty[h] = { cached: false, files: [] });
      return empty;
    }
  },

  // ── 9. getCachedFileInfo (by hash & fileName) ──────────────────
  async getCachedFileInfo(hash, fileName) {
    const cacheResult = await this.checkCached([hash]);
    const info = cacheResult[hash];
    if (!info || !info.cached || !Array.isArray(info.files)) return null;
    const file = info.files.find(f => f.name.endsWith(fileName) || f.name === fileName);
    if (!file) return null;
    return {
      id: file.id,
      path: file.name,
      bytes: file.size,
      torrentName: info.name,
      torrentSize: info.size,
    };
  },

  // ── 10. getDownloadLinkForFile ─────────────────────────────────
  async getDownloadLinkForFile(torrentId, fileId) {
    try {
      const { data } = await axios.get(`${BASE_URL}/torrents/requestdl`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        params: { token: apiKey, torrent_id: torrentId, file_id: fileId, redirect: false },
      });
      const payload = data.data || data;
      return payload.url || payload;
    } catch (err) {
      logger.error({ torrentId, fileId, err: err.message }, 'Failed to get download link.');
      return null;
    }
  },

  ResourceNotFoundError,
};

export default torbox;
