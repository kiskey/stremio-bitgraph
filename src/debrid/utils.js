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

  throw new Error(`Torrent ${torrentId} did not reach ready state after ${maxAttempts} attempts`);
}
