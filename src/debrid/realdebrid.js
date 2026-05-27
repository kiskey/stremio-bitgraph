// File: src/debrid/realdebrid.js
// Version: 2.0 - Unified debrid module (Real-Debrid)

import axios from 'axios';
import { REALDEBRID_API_KEY } from '../../config.js';
import { log } from '../utils.js';

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

// Standard debrid interface methods
const realdebrid = {
  isEnabled: !!apiKey,

  async addMagnet(magnet) {
    const form = new URLSearchParams();
    form.append('magnet', magnet);
    const data = await request('post', '/torrents/addMagnet', form.toString());
    log('info', `Real-Debrid magnet added: ${data.id}`);
    return data;
  },

  async getTorrentInfo(id) {
    return request('get', `/torrents/info/${id}`);
  },

  async selectFiles(id, fileIds) {
    const form = new URLSearchParams();
    form.append('files', fileIds.join(','));
    await request('post', `/torrents/selectFiles/${id}`, form.toString());
    log('info', `Real-Debrid files selected for ${id}`);
  },

  async unrestrictLink(link) {
    const form = new URLSearchParams();
    form.append('link', link);
    return request('post', '/unrestrict/link', form.toString());
  },

  async addAndSelect(magnet) {
    const torrent = await this.addMagnet(magnet);
    // Auto-select all files (or largest video file – kept simple)
    const files = torrent?.files || [];
    const fileIds = files.map((f, i) => i).filter(i => {
      const name = files[i].path;
      return /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(name);
    });
    if (fileIds.length) {
      await this.selectFiles(torrent.id, fileIds);
    }
    return this.getTorrentInfo(torrent.id);
  },

  async deleteTorrent(id) {
    await request('delete', `/torrents/delete/${id}`);
    log('info', `Real-Debrid torrent deleted: ${id}`);
  },

  async getTorrents() {
    return request('get', '/torrents');
  },

  ResourceNotFoundError,
};

export default realdebrid;
