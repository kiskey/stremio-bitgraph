// File: src/debrid/index.js
// Version: 2.1 – Use logger (not log)

import { debridService } from '../../config.js';
import realdebrid from './realdebrid.js';
import torbox from './torbox.js';
import { createCache } from './cache.js';
import { logger } from '../utils.js';

const disabledProvider = {
  isEnabled: false,
  async addMagnet() { throw new Error('Debrid not configured'); },
  async getTorrentInfo() { throw new Error('Debrid not configured'); },
  async selectFiles() { throw new Error('Debrid not configured'); },
  async unrestrictLink() { throw new Error('Debrid not configured'); },
  async addAndSelect() { throw new Error('Debrid not configured'); },
  async deleteTorrent() { throw new Error('Debrid not configured'); },
  async getTorrents() { throw new Error('Debrid not configured'); },
};

let instance = null;

function loadProvider() {
  if (!debridService) {
    logger.info('No debrid service configured – P2P only.');
    return disabledProvider;
  }

  switch (debridService.toLowerCase()) {
    case 'realdebrid':
      if (!realdebrid.isEnabled) {
        logger.warn('Real-Debrid API key missing, P2P only.');
        return disabledProvider;
      }
      logger.info('Using Real-Debrid provider');
      return realdebrid;

    case 'torbox':
      if (!torbox.isEnabled) {
        logger.warn('TorBox API key missing, P2P only.');
        return disabledProvider;
      }
      const cache = createCache('torbox');
      torbox.setup(cache);
      logger.info('Using TorBox provider with cache');
      return torbox;

    default:
      logger.warn(`Unknown debrid service: ${debridService}, P2P only.`);
      return disabledProvider;
  }
}

const handler = {
  get(_, prop) {
    if (!instance) {
      instance = loadProvider();
    }
    if (prop === 'checkCached') {
      if (typeof instance.checkCached === 'function') {
        return instance.checkCached.bind(instance);
      }
      return async (hashes) => {
        const result = {};
        for (const hash of hashes) result[hash] = false;
        return result;
      };
    }
    return instance[prop];
  }
};

const debridProxy = new Proxy({}, handler);
export default debridProxy;
