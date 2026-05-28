// File: src/debrid/utils.js
// Version: 2.1 – Timeout message includes "timed out", increased max attempts

import { logger } from '../utils.js';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollTorrentUntilReady(torrentId, getInfoFn, options = {}) {
  const maxAttempts = options.maxAttempts || 90;   // ~3 minutes
  const intervalMs = options.intervalMs || 2000;
  const readyStatuses = ['downloaded', 'finished'];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let info;
    try {
      info = await getInfoFn(torrentId);
    } catch (err) {
      if (err.name === 'ResourceNotFoundError') {
        logger.warn(`[POLL] 404 for ${torrentId} (attempt ${attempt+1}/${maxAttempts}) – waiting...`);
        await sleep(intervalMs);
        continue;
      }
      throw err;
    }

    if (!info) {
      logger.warn(`[POLL] null info for ${torrentId} (attempt ${attempt+1}/${maxAttempts}) – waiting...`);
      await sleep(intervalMs);
      continue;
    }

    const status = info.status;
    if (readyStatuses.includes(status)) {
      logger.debug(`[POLL] ${torrentId} ready (${status})`);
      return info;
    }

    logger.debug(`[POLL] ${torrentId} status: ${status} (attempt ${attempt+1}/${maxAttempts})`);
    await sleep(intervalMs);
  }

  // ✅ This error message is now caught by the "isTimeout" check
  throw new Error(`Torrent ${torrentId} polling timed out after ${maxAttempts} attempts`);
}
