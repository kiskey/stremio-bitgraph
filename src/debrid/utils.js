// File: src/debrid/utils.js
// Version: 2.0 – Null-safe polling, handles transient 404s

import { logger } from '../utils.js';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function pollTorrentUntilReady(torrentId, getInfoFn, options = {}) {
  const maxAttempts = options.maxAttempts || 60;
  const intervalMs = options.intervalMs || 2000;
  const readyStatuses = ['downloaded', 'finished'];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let info;
    try {
      info = await getInfoFn(torrentId);
    } catch (err) {
      // If the provider throws a ResourceNotFoundError, treat as not ready yet
      if (err.name === 'ResourceNotFoundError') {
        logger.warn(`[POLL] 404 for ${torrentId} (attempt ${attempt+1}/${maxAttempts}) – waiting...`);
        await sleep(intervalMs);
        continue;
      }
      throw err;  // other errors propagate
    }

    if (!info) {
      // Provider returned null (transient error) – treat same as not ready
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

  throw new Error(`Torrent ${torrentId} did not reach ready state after ${maxAttempts} attempts`);
}
