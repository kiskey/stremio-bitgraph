// File: src/debrid/utils.js
// Version: 1.1 – Use logger

import { logger } from '../utils.js';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollTorrentUntilReady(torrentId, getInfoFn, options = {}) {
  const maxAttempts = options.maxAttempts || 60;
  const intervalMs = options.intervalMs || 2000;
  const readyStatuses = ['downloaded', 'finished'];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const info = await getInfoFn(torrentId);
    const status = info.status;

    if (readyStatuses.includes(status)) {
      logger.debug(`Torrent ${torrentId} is ready (${status})`);
      return info;
    }

    logger.debug(`Torrent ${torrentId} status: ${status}, waiting ${intervalMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
    await sleep(intervalMs);
  }

  throw new Error(`Torrent ${torrentId} did not reach ready state after ${maxAttempts} attempts`);
}
