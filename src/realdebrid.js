/**
 * src/realdebrid.js
 * Real-Debrid API Client
 * Handles interactions with the Real-Debrid API for adding, monitoring, and unrestricting torrents.
 */

const axios = require('axios');
const config = require('../config');
const { retryWithExponentialBackoff, sleep, logger } = require('./utils');

const REALDEBRID_BASE_URL = config.realDebrid.baseUrl;

/**
 * Creates an Axios instance with Real-Debrid specific headers.
 * @param {string} accessToken - The user's Real-Debrid API token.
 * @returns {axios.AxiosInstance} Configured Axios instance.
 */
function createRealDebridClient(accessToken) {
  if (!accessToken) {
    throw new Error('Real-Debrid API Token is required.');
  }
  return axios.create({
    baseURL: REALDEBRID_BASE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    // Real-Debrid has a rate limit of 250 requests per minute.
    // Adding a small delay between requests for this client.
    // This is a basic way to manage, more advanced might use a queue.
    // transformRequest: [function (data, headers) {
    //   return new Promise(resolve => setTimeout(() => resolve(data), config.realDebrid.rateLimitDelayMs));
    // }, ...axios.defaults.transformRequest],
  });
}

/**
 * Adds a magnet link to Real-Debrid.
 * @param {string} accessToken - User's Real-Debrid API token.
 * @param {string} magnetLink - The magnet link to add.
 * @returns {Promise<object|null>} Real-Debrid torrent object, or null on error.
 */
async function addMagnet(accessToken, magnetLink) {
  const client = createRealDebridClient(accessToken);
  const url = '/torrents/addMagnet';
  logger.info(`Adding magnet to Real-Debrid: ${magnetLink.substring(0, 50)}...`); // Log first 50 chars

  try {
    const response = await retryWithExponentialBackoff(
      async () => client.post(url, `magnet=${encodeURIComponent(magnetLink)}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }),
      config.realDebrid.retry
    );
    logger.debug('Real-Debrid addMagnet response:', response.data);
    return response.data;
  } catch (error) {
    logger.error(`Error adding magnet to Real-Debrid: ${error.message}`);
    return null;
  }
}

/**
 * Gets info about an added torrent on Real-Debrid.
 * @param {string} accessToken - User's Real-Debrid API token.
 * @param {string} torrentId - The Real-Debrid internal torrent ID.
 * @returns {Promise<object|null>} Torrent info object, or null on error.
 */
async function getTorrentInfo(accessToken, torrentId) {
  const client = createRealDebridClient(accessToken);
  const url = `/torrents/info/${torrentId}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => client.get(url),
      config.realDebrid.retry
    );
    return response.data;
  } catch (error) {
    logger.error(`Error getting torrent info for ${torrentId} from Real-Debrid: ${error.message}`);
    return null;
  }
}

/**
 * Selects files within an added torrent to start download on Real-Debrid.
 * @param {string} accessToken - User's Real-Debrid API token.
 * @param {string} torrentId - The Real-Debrid internal torrent ID.
 * @param {string} files - Comma-separated file IDs (e.g., "0" for the first file, or "all").
 * @returns {Promise<object|null>} Success object, or null on error.
 */
async function selectFiles(accessToken, torrentId, files) {
  const client = createRealDebridClient(accessToken);
  const url = `/torrents/selectFiles/${torrentId}`;
  logger.info(`Selecting files ${files} for torrent ${torrentId} on Real-Debrid.`);
  try {
    const response = await retryWithExponentialBackoff(
      async () => client.post(url, `files=${files}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }),
      config.realDebrid.retry
    );
    return response.data;
  } catch (error) {
    logger.error(`Error selecting files for torrent ${torrentId} on Real-Debrid: ${error.message}`);
    return null;
  }
}

/**
 * Polls Real-Debrid until a torrent is ready for streaming or a timeout occurs.
 * @param {string} accessToken - User's Real-Debrid API token.
 * @param {string} torrentId - The Real-Debrid internal torrent ID.
 * @param {number} timeoutMs - Maximum time to poll in milliseconds.
 * @param {number} intervalMs - Initial polling interval in milliseconds.
 * @returns {Promise<object|null>} The torrent info object when ready, or null if timeout.
 */
async function pollForTorrentCompletion(accessToken, torrentId, timeoutMs = 300000, intervalMs = 3000) { // 5 minutes timeout, 3s initial interval
  const startTime = Date.now();
  let currentInterval = intervalMs;
  const maxInterval = config.realDebrid.retry.maxDelayMs || 16000; // Cap polling interval

  logger.info(`Polling Real-Debrid for torrent ${torrentId} status...`);

  while (Date.now() - startTime < timeoutMs) {
    const torrentInfo = await getTorrentInfo(accessToken, torrentId);

    if (torrentInfo && torrentInfo.status === 'downloaded' && torrentInfo.links && torrentInfo.links.length > 0) {
      logger.info(`Torrent ${torrentId} is downloaded and ready.`);
      return torrentInfo;
    }

    if (torrentInfo && (torrentInfo.status === 'error' || torrentInfo.status === 'dead')) {
      logger.error(`Torrent ${torrentId} encountered an error or is dead on Real-Debrid. Status: ${torrentInfo.status}`);
      return null;
    }

    logger.debug(`Torrent ${torrentId} status: ${torrentInfo ? torrentInfo.status : 'unknown'}. Retrying in ${currentInterval / 1000}s...`);
    await sleep(currentInterval);

    // Exponential backoff with jitter
    currentInterval = Math.min(maxInterval, currentInterval * 2 + Math.random() * 1000);
  }

  logger.warn(`Polling for torrent ${torrentId} timed out after ${timeoutMs / 1000} seconds.`);
  return null;
}

/**
 * Unrestricts a Real-Debrid generated link to a direct streaming URL.
 * @param {string} accessToken - User's Real-Debrid API token.
 * @param {string} realDebridLink - The link provided by Real-Debrid after torrent completion.
 * @returns {Promise<string|null>} The direct streaming URL, or null on error.
 */
async function unrestrictLink(accessToken, realDebridLink) {
  const client = createRealDebridClient(accessToken);
  const url = '/unrestrict/link';
  logger.info(`Unrestricting Real-Debrid link: ${realDebridLink.substring(0, 50)}...`);
  try {
    const response = await retryWithExponentialBackoff(
      async () => client.post(url, `link=${encodeURIComponent(realDebridLink)}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }),
      config.realDebrid.retry
    );
    logger.debug('Real-Debrid unrestrictLink response:', response.data);
    return response.data.download; // This typically contains the direct download URL
  } catch (error) {
    logger.error(`Error unrestricting link ${realDebridLink} on Real-Debrid: ${error.message}`);
    return null;
  }
}

module.exports = {
  addMagnet,
  getTorrentInfo,
  selectFiles,
  pollForTorrentCompletion,
  unrestrictLink,
};
