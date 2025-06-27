/**
 * src/tmdb.js
 * TMDB API Client
 * Handles interactions with The Movie Database (TMDB) API for fetching TV show metadata.
 */

const axios = require('axios');
const config = require('../config');
const { retryWithExponentialBackoff, logger } = require('./utils');

const TMDB_BASE_URL = config.tmdb.baseUrl;
const TMDB_API_KEY = config.tmdb.apiKey;

/**
 * Fetches TV show details from TMDB.
 * @param {string} tmdbId - The TMDB ID of the TV show.
 * @returns {Promise<object|null>} The TV show details, or null if not found.
 */
async function getTvShowDetails(tmdbId) {
  if (!TMDB_API_KEY) {
    logger.warn('TMDB API Key is missing. Cannot fetch TV show details.');
    return null;
  }
  const url = `${TMDB_BASE_URL}/tv/${tmdbId}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.get(url, {
        params: {
          api_key: TMDB_API_KEY,
          append_to_response: 'seasons', // Fetch season details along with show details
        },
      }),
      config.realDebrid.retry // Reusing retry config, adjust if TMDB needs different
    );
    return response.data;
  } catch (error) {
    logger.error(`Error fetching TMDB TV show details for ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Fetches TV season details from TMDB.
 * @param {string} tmdbId - The TMDB ID of the TV show.
 * @param {number} seasonNumber - The season number.
 * @returns {Promise<object|null>} The TV season details, or null if not found.
 */
async function getTvSeasonDetails(tmdbId, seasonNumber) {
  if (!TMDB_API_KEY) {
    logger.warn('TMDB API Key is missing. Cannot fetch TV season details.');
    return null;
  }
  const url = `${TMDB_BASE_URL}/tv/${tmdbId}/season/${seasonNumber}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.get(url, {
        params: {
          api_key: TMDB_API_KEY,
          append_to_response: 'episodes', // Fetch episode details along with season details
        },
      }),
      config.realDebrid.retry // Reusing retry config, adjust if TMDB needs different
    );
    return response.data;
  } catch (error) {
    logger.error(`Error fetching TMDB TV season ${seasonNumber} for ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Fetches TV episode details from TMDB.
 * @param {string} tmdbId - The TMDB ID of the TV show.
 * @param {number} seasonNumber - The season number.
 * @param {number} episodeNumber - The episode number.
 * @returns {Promise<object|null>} The TV episode details, or null if not found.
 */
async function getTvEpisodeDetails(tmdbId, seasonNumber, episodeNumber) {
  if (!TMDB_API_KEY) {
    logger.warn('TMDB API Key is missing. Cannot fetch TV episode details.');
    return null;
  }
  const url = `${TMDB_BASE_URL}/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.get(url, {
        params: {
          api_key: TMDB_API_KEY,
        },
      }),
      config.realDebrid.retry // Reusing retry config, adjust if TMDB needs different
    );
    return response.data;
  } catch (error) {
    logger.error(`Error fetching TMDB TV episode S${seasonNumber}E${episodeNumber} for ${tmdbId}:`, error.message);
    return null;
  }
}

module.exports = {
  getTvShowDetails,
  getTvSeasonDetails,
  getTvEpisodeDetails,
};
