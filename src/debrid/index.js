// File: src/debrid/index.js
// Version: 1.0 - Debrid provider factory

import { debridService } from '../../config.js';
import realdebrid from './realdebrid.js';
import torbox from './torbox.js';
import { log } from '../utils.js';

// Disabled (no‑op) provider
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
    log('info', 'No debrid service configured. P2P only mode.');
    return disabledProvider;
  }
  switch (debridService.toLowerCase()) {
    case 'realdebrid':
      if (!realdebrid.isEnabled) {
        log('warn', 'Real-Debrid API key missing, falling back to P2P');
        return disabledProvider;
      }
      log('info', 'Using Real-Debrid provider');
      return realdebrid;
    case 'torbox':
      if (!torbox.isEnabled) {
        log('warn', 'TorBox API key missing, falling back to P2P');
        return disabledProvider;
      }
      log('info', 'Using TorBox provider');
      return torbox;
    default:
      log('warn', `Unknown debrid service: ${debridService}. P2P only.`);
      return disabledProvider;
  }
}

const handler = {
  get(_, prop) {
    if (!instance) {
      instance = loadProvider();
    }
    // Ensure checkCached is available; if provider doesn't have it, provide a fallback
    if (prop === 'checkCached') {
      if (typeof instance.checkCached === 'function') {
        return (...args) => instance.checkCached(...args);
      }
      // Fallback: return all false
      return async (hashes) => {
        const result = {};
        for (const hash of hashes) {
          result[hash] = false;
        }
        return result;
      };
    }
    if (prop in instance) {
      return instance[prop];
    }
    return undefined;
  }
};

const debridProxy = new Proxy({}, handler);

export default debridProxy;
