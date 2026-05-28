// File: src/debrid/realdebrid.js
// Version: 2.3 – getTorrentInfo returns null on transient 404 (matching original)

import axios from 'axios';
import { REALDEBRID_API_KEY } from '../../config.js';
import { logger } from '../utils.js';

const BASE_URL = 'https://api.real-debrid.com/rest/1.0';
const apiKey = REALDEBRID_API_KEY;

class ResourceNotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

let axiosInstance;

function getAxios() {
  if (!axiosInstance) {
    axiosInstance = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });
  }
  return axiosInstance;
}

async function request(method, path, data = null) {
  const client = getAxios();
  try {
    const response = await client({ method, url: path, data });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      throw new ResourceNotFoundError();
    }
    throw error;
  }
}

const realdebrid = {
  isEnabled: !!apiKey,

  async addMagnet(magnet) {
    const body = `magnet=${encodeURIComponent(magnet)}`;
    const data = await request('post', '/torrents/addMagnet', body);
    logger.info(`Real-Debrid magnet added: ${data.id}`);
    return data;
  },

  // ✅ Returns null on 404 (transient during processing), throws on other errors
  async getTorrentInfo(id) {
    try {
      return await request('get', `/torrents/info/${id}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        logger.warn(`[RD] getTorrentInfo returned 404 for ${id} – torrent may still be processing.`);
        return null;   // ← matches original behavior: caller will retry
      }
      throw error;     // ← other errors still propagate
    }
  },

  async selectFiles(id, fileIds) {
    const filesParam = fileIds === 'all' ? 'all' : fileIds.join(',');
    const body = `files=${filesParam}`;
    try {
      await request('post', `/torrents/selectFiles/${id}`, body);
      logger.info(`Real-Debrid files selected for ${id}`);
    } catch (error) {
      if (error.response && error.response.status === 202) {
        logger.info(`Real-Debrid files already selected for ${id}`);
        return;
      }
      // For selectFiles, 404 with error_code 7 means the torrent truly expired
      throw error;
    }
  },

  async unrestrictLink(link) {
    const body = `link=${encodeURIComponent(link)}`;
    return request('post', '/unrestrict/link', body);
  },

  async addAndSelect(magnet) {
    const torrent = await this.addMagnet(magnet);
    const info = await this.getTorrentInfo(torrent.id);
    if (!info) return null;   // torrent not ready yet
    const videoFiles = (info.files || []).filter(f => /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(f.path || f.name));
    if (videoFiles.length) {
      const largest = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
      const fileIdx = info.files.indexOf(largest);
      await this.selectFiles(torrent.id, [fileIdx]);
    }
    return this.getTorrentInfo(torrent.id);
  },

  async deleteTorrent(id) {
    await request('delete', `/torrents/delete/${id}`);
    logger.info(`Real-Debrid torrent deleted: ${id}`);
  },

  async getTorrents() {
    return request('get', '/torrents');
  },

  ResourceNotFoundError,
};

export default realdebrid;
