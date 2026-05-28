// File: src/debrid/utils.js
// Version: 2.3 – Random polling jitter + AbortSignal for client disconnect

import { logger } from '../utils.js';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls a torrent until it reaches a ready status or the operation is aborted.
 *
 * @param {string} torrentId
 * @param {(id: string) => Promise<Object>} getInfoFn – function that returns torrent info with .status
 * @param {Object} options
 * @param {number} [options.maxAttempts=90]      – maximum polling attempts
 * @param {number} [options.intervalMs=2000]     – base interval in ms (random jitter added)
 * @param {AbortSignal} [options.signal]         – if provided, polling stops when the signal is aborted
 * @returns {Promise<Object>} – final torrent info
 */
export async function pollTorrentUntilReady(torrentId, getInfoFn, options = {}) {
  const maxAttempts = options.maxAttempts || 90;
  const baseInterval = options.intervalMs || 2000;
  const readyStatuses = ['downloaded', 'finished'];
  const signal = options.signal;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check if the client has disconnected
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    let info;
    try {
      info = await getInfoFn(torrentId);
    } catch (err) {
      // Transient errors: resource not found, rate limited, or server errors
      if (
        err.name === 'ResourceNotFoundError' ||
        err.response?.status === 429 ||
        err.response?.status >= 500
      ) {
        logger.warn(
          `[POLL] Transient error for ${torrentId} (${err.message || err.response?.status}) – attempt ${attempt + 1}/${maxAttempts}`
        );
        const jitter = Math.floor(Math.random() * 1000); // 0-1000ms extra
        await sleep(baseInterval + jitter);
        continue;
      }
      throw err;
    }

    if (!info) {
      logger.warn(`[POLL] null info for ${torrentId} – attempt ${attempt + 1}/${maxAttempts}`);
      const jitter = Math.floor(Math.random() * 1000);
      await sleep(baseInterval + jitter);
      continue;
    }

    const status = info.status;
    if (readyStatuses.includes(status)) {
      logger.debug(`[POLL] ${torrentId} ready (${status})`);
      return info;
    }

    logger.debug(`[POLL] ${torrentId} status: ${status} – attempt ${attempt + 1}/${maxAttempts}`);
    const jitter = Math.floor(Math.random() * 1000);
    await sleep(baseInterval + jitter);
  }

  throw new Error(`Torrent ${torrentId} polling timed out after ${maxAttempts} attempts`);
}
