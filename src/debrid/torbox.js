// File: src/debrid/torbox.js
// Version: 2.1 – Fixed _getHashFromTorrentId implementation

import axios from 'axios';
import { TORBOX_API_KEY, TORBOX_MAX_ACTIVE_TORRENTS } from '../../config.js';
import { log } from '../utils.js';

const BASE_URL = 'https://api.torbox.app/v1';
const apiKey = TORBOX_API_KEY;

const activeAdds = new Map();
const RATE_LIMIT_WINDOW = 2000;
let lastAddTime = 0;

class ResourceNotFoundError extends Error {
  constructor(message = 'TorBox resource not found') {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

let cache = null;

export function setup(cacheInstance) {
  cache = cacheInstance;
}

function _extractHash(magnet) {
  const match = magnet.match(/btih:([a-fA-F0-9]{40})/);
  return match ? match[1].toLowerCase() : null;
}

const torbox = {
  isEnabled: !!apiKey,

  async _request(method, path, data = null, headers = {}) {
    const url = `${BASE_URL}${path}`;
    const response = await axios({
      method,
      url,
      headers: { Authorization: `Bearer ${apiKey}`, ...headers },
      data,
    });
    return response.data;
  },

  async addMagnet(magnet) {
    const hash = _extractHash(magnet);
    if (!hash) throw new Error('Invalid magnet link');

    const now = Date.now();
    if (now - lastAddTime < RATE_LIMIT_WINDOW) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WINDOW - (now - lastAddTime)));
    }
    lastAddTime = Date.now();

    if (activeAdds.has(magnet)) {
      return activeAdds.get(magnet);
    }

    const promise = (async () => {
      try {
        if (cache) {
          const cached = await cache.get(hash);
          if (cached && cached.provider_torrent_id) {
            try {
              const info = await this.getTorrentInfo(cached.provider_torrent_id);
              return info;
            } catch (e) {
              // not found, proceed to add
            }
          }
        }

        const result = await this._request('post', '/torrents/add', { magnet });
        const torrentId = result.data?.id;
        log('info', `TorBox magnet added: ${torrentId}`);

        if (cache && torrentId) {
          await cache.set(hash, {
            provider_torrent_id: torrentId,
            status: 'active',
            extra: {},
          });
        }
        return result.data;
      } catch (error) {
        log('error', `TorBox addMagnet failed: ${error.message}`);
        throw error;
      }
    })();

    activeAdds.add(magnet, promise);
    try {
      return await promise;
    } finally {
      activeAdds.delete(magnet);
    }
  },

  async getTorrentInfo(id) {
    const data = await this._request('get', `/torrents/info/${id}`);
    return data.data;
  },

  async selectFiles(id, fileIds) {
    await this._request('post', `/torrents/${id}/select`, { files: fileIds });
    log('info', `TorBox files selected for ${id}`);
  },

  async unrestrictLink(link) {
    return { download: link };
  },

  async addAndSelect(magnet) {
    const torrent = await this.addMagnet(magnet);
    const info = await this.getTorrentInfo(torrent.id);
    const videoFiles = (info.files || []).filter(f => /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(f.name));
    if (videoFiles.length) {
      const largest = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
      await this.selectFiles(torrent.id, [largest.id]);
    }
    return this.getTorrentInfo(torrent.id);
  },

  async deleteTorrent(id) {
    await this._request('delete', `/torrents/${id}`);
    log('info', `TorBox torrent deleted: ${id}`);
    if (cache) {
      const hash = await this._getHashFromTorrentId(id);
      if (hash) {
        await cache.update(hash, { status: 'deleted' });
      }
    }
  },

  async getTorrents() {
    const data = await this._request('get', '/torrents/list');
    return data.data || [];
  },

  async checkCached(hashes) {
    if (!hashes?.length) return {};
    try {
      const response = await this._request('post', '/torrents/checkcached', { hashes });
      return response.data || {};
    } catch (err) {
      log('error', `checkCached error: ${err.message}`);
      return {};
    }
  },

  getCachedFileInfo(hash, fileName, cachedResults) {
    const cached = cachedResults?.[hash];
    if (!cached || typeof cached === 'boolean') return null;
    return (cached.files || []).find(f => f.name === fileName) || null;
  },

  async getDownloadLinkForFile(torrentId, fileId) {
    try {
      const data = await this._request('get', `/torrents/${torrentId}/files/${fileId}/download`);
      return data.download || data.link;
    } catch (err) {
      log('error', `getDownloadLinkForFile error: ${err.message}`);
      return null;
    }
  },

  // ✅ Proper implementation using cache.getByProviderId
  async _getHashFromTorrentId(torrentId) {
    if (!cache) return null;
    try {
      const row = await cache.getByProviderId(torrentId);
      return row?.hash || null;
    } catch (error) {
      log('error', `Failed to find hash for TorBox ID ${torrentId}: ${error.message}`);
      return null;
    }
  },

  ResourceNotFoundError,
};

export default torbox;
