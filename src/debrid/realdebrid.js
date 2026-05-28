// File: src/debrid/realdebrid.js
// Version: 2.3 – Returns null on transient 404; uses real file IDs

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

const realdebrid = {
  isEnabled: !!apiKey,

  async addMagnet(magnet) {
    const body = `magnet=${encodeURIComponent(magnet)}`;
    const { data } = await getAxios().post('/torrents/addMagnet', body);
    logger.info(`Real-Debrid magnet added: ${data.id}`);
    return data;
  },

  // Returns null on 404 so callers can retry
  async getTorrentInfo(id) {
    try {
      const { data } = await getAxios().get(`/torrents/info/${id}`);
      return data;
    } catch (error) {
      if (error.response?.status === 404) {
        logger.warn(`[RD] getTorrentInfo 404 for ${id} – still processing?`);
        return null;
      }
      throw error;
    }
  },

  async selectFiles(id, fileIds) {
    const param = fileIds === 'all' ? 'all' : fileIds.join(',');
    try {
      await getAxios().post(`/torrents/selectFiles/${id}`, `files=${param}`);
      logger.info(`Real-Debrid files selected for ${id}`);
    } catch (error) {
      if (error.response?.status === 202) {
        logger.info(`Files already selected for ${id}`);
        return;
      }
      throw error;
    }
  },

  async unrestrictLink(link) {
    const { data } = await getAxios().post('/unrestrict/link', `link=${encodeURIComponent(link)}`);
    return data;
  },

  async deleteTorrent(id) {
    await getAxios().delete(`/torrents/delete/${id}`);
    logger.info(`Real-Debrid torrent deleted: ${id}`);
  },

  async getTorrents() {
    const { data } = await getAxios().get('/torrents');
    return data;
  },

  ResourceNotFoundError,
};

export default realdebrid;
