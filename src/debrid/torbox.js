// File: src/debrid/torbox.js
// Version: 1.0 - TorBox integration (ported from smvshows)

import axios from 'axios';
import { TORBOX_API_KEY, TORBOX_MAX_ACTIVE_TORRENTS } from '../../config.js';
import { log } from '../utils.js';
import { pollTorrentUntilReady } from './utils.js';

const BASE_URL = 'https://api.torbox.app/v1';
const apiKey = TORBOX_API_KEY;

// Dedup and rate‑limiting
const activeAdds = new Map();
const RATE_LIMIT_WINDOW = 2000; // 2 seconds
let lastAddTime = 0;

class ResourceNotFoundError extends Error {
  constructor(message = 'TorBox resource not found') {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

let models = null; // will be set via setModels

const torbox = {
  isEnabled: !!apiKey,
  models: null,

  setModels(modelObjects) {
    models = modelObjects;
    this.models = models;
  },

  async _request(method, path, data = null, headers = {}) {
    const url = `${BASE_URL}${path}`;
    const config = {
      method,
      url,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      data,
    };
    try {
      const response = await axios(config);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        throw new ResourceNotFoundError();
      }
      throw error;
    }
  },

  async addMagnet(magnet) {
    // Simple rate‑limiting
    const now = Date.now();
    if (now - lastAddTime < RATE_LIMIT_WINDOW) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WINDOW - (now - lastAddTime)));
    }
    lastAddTime = Date.now();

    // Deduplicate identical requests in flight
    if (activeAdds.has(magnet)) {
      return activeAdds.get(magnet);
    }
    const promise = (async () => {
      const result = await this._request('post', '/torrents/add', { magnet });
      log('info', `TorBox magnet added: ${result.data?.id}`);
      const torrentId = result.data?.id;
      // Persist mapping if models available
      if (models && torrentId) {
        const hash = this._extractHashFromMagnet(magnet);
        if (hash) {
          try {
            await models.TorboxTorrent.create({
              hash,
              torbox_id: torrentId,
              status: 'active',
            });
          } catch (err) {
            log('warn', `Failed to save TorBox mapping: ${err.message}`);
          }
        }
      }
      return result.data;
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
    // TorBox requires file IDs as array of numbers
    const result = await this._request('post', `/torrents/${id}/select`, { files: fileIds });
    log('info', `TorBox files selected for ${id}`);
    return result.data;
  },

  async unrestrictLink(link) {
    // TorBox uses "download" endpoints; simulate similar interface
    // We'll extract the torrent ID and file ID from the link if possible, else return a direct link
    // For now, assume link is a direct TorBox download URL.
    return { download: link };
  },

  async addAndSelect(magnet) {
    const torrent = await this.addMagnet(magnet);
    // Auto-select the largest video file
    const info = await this.getTorrentInfo(torrent.id);
    const files = info.files || [];
    const videoFiles = files.filter(f =>
      /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(f.name)
    );
    if (videoFiles.length) {
      const largest = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
      await this.selectFiles(torrent.id, [largest.id]);
    }
    return this.getTorrentInfo(torrent.id);
  },

  async deleteTorrent(id) {
    await this._request('delete', `/torrents/${id}`);
    log('info', `TorBox torrent deleted: ${id}`);
    // Clean up mapping
    if (models) {
      await models.TorboxTorrent.update(
        { status: 'deleted' },
        { where: { torbox_id: id } }
      );
    }
  },

  async getTorrents() {
    const data = await this._request('get', '/torrents/list');
    return data.data || [];
  },

  /**
   * TorBox-specific cached check
   * @param {string[]} hashes
   * @returns {Promise<Object>} { hash: boolean|object }
   */
  async checkCached(hashes) {
    if (!hashes || !hashes.length) return {};
    const response = await this._request('post', '/torrents/checkcached', { hashes });
    return response.data || {};
  },

  /**
   * Get file info within a cached torrent result
   */
  getCachedFileInfo(hash, fileName, cachedResults) {
    const cached = cachedResults?.[hash];
    if (!cached || typeof cached === 'boolean') return null;
    const files = cached.files || [];
    return files.find(f => f.name === fileName) || null;
  },

  /**
   * Get a direct download link for a specific file in a TorBox torrent
   */
  async getDownloadLinkForFile(torrentId, fileId) {
    const data = await this._request('get', `/torrents/${torrentId}/files/${fileId}/download`);
    return data.download || data.link;
  },

  _extractHashFromMagnet(magnet) {
    const match = magnet.match(/btih:([a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : null;
  },

  ResourceNotFoundError,
};

export default torbox;
