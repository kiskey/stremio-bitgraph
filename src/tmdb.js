/**
 * src/tmdb.js
 * TMDB API Client
 * Handles interactions with The Movie Database (TMDB) API for fetching TV show metadata.
 * Uses TMDB_API_KEY from config.js (environment variable).
 */

const axios = require('axios');
const config = require('../config');
const { retryWithExponentialBackoff, logger } = require('./utils');

/**
 * Fetches TV show details from TMDB.
 * @param {string} tmdbId - The TMDB ID of the TV show.
 * @returns {Promise<object|null>} The TV show details, or null if not found.
 */
async function getTvShowDetails(tmdbId) {
  if (!config.tmdb.apiKey) {
    logger.warn('TMDB API Key is missing in environment configuration. Cannot fetch TV show details.');
    return null;
  }
  const url = `${config.tmdb.baseUrl}/tv/${tmdbId}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.get(url, {
        params: {
          api_key: config.tmdb.apiKey, // Uses server's TMDB API key
          append_to_response: 'seasons', // Fetch season details along with show details
        },
      }),
      config.retry // Using general retry config
    );

    // CRITICAL FIX: Add explicit null/undefined check for response and response.data
    if (!response || !response.data) {
        logger.error(`TMDB API call for show ID ${tmdbId} returned an invalid or empty response object.`);
        return null;
    }

    return response.data;
  } catch (error) {
    logger.error(`Error fetching TMDB TV show details for ${tmdbId}: ${error.message}`);
    if (error.response) { // Log Axios specific error details
      logger.error('TMDB HTTP Response Status:', error.response.status);
      logger.error('TMDB HTTP Response Data:', JSON.stringify(error.response.data, null, 2));
    }
    logger.error(error); // Log the full error object for stack trace
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
  if (!config.tmdb.apiKey) {
    logger.warn('TMDB API Key is missing in environment configuration. Cannot fetch TV season details.');
    return null;
  }
  const url = `${config.tmdb.baseUrl}/tv/${tmdbId}/season/${seasonNumber}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.get(url, {
        params: {
          api_key: config.tmdb.apiKey, // Uses server's TMDB API key
          append_to_response: 'episodes', // Fetch episode details along with season details
        },
      }),
      config.retry // Using general retry config
    );

    // CRITICAL FIX: Add explicit null/undefined check for response and response.data
    if (!response || !response.data) {
        logger.error(`TMDB API call for season ${seasonNumber} of show ID ${tmdbId} returned an invalid or empty response object.`);
        return null;
    }

    return response.data;
  } catch (error) {
    logger.error(`Error fetching TMDB TV season ${seasonNumber} for ${tmdbId}: ${error.message}`);
    if (error.response) { // Log Axios specific error details
      logger.error('TMDB HTTP Response Status:', error.response.status);
      logger.error('TMDB HTTP Response Data:', JSON.stringify(error.response.data, null, 2));
    }
    logger.error(error); // Log the full error object for stack trace
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
  if (!config.tmdb.apiKey) {
    logger.warn('TMDB API Key is missing in environment configuration. Cannot fetch TV episode details.');
    return null;
  }
  const url = `${config.tmdb.baseUrl}/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`;
  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.get(url, {
        params: {
          api_key: config.tmdb.apiKey, // Uses server's TMDB API key
        },
      }),
      config.retry // Using general retry config
    );

    // CRITICAL FIX: Add explicit null/undefined check for response and response.data
    if (!response || !response.data) {
        logger.error(`TMDB API call for episode S${seasonNumber}E${episodeNumber} of show ID ${tmdbId} returned an invalid or empty response object.`);
        return null;
    }

    return response.data;
  } catch (error) {
    logger.error(`Error fetching TMDB TV episode S${seasonNumber}E${episodeNumber} for ${tmdbId}: ${error.message}`);
    if (error.response) { // Log Axios specific error details
      logger.error('TMDB HTTP Response Status:', error.response.status);
      logger.error('TMDB HTTP Response Data:', JSON.stringify(error.response.data, null, 2));
    }
    logger.error(error); // Log the full error object for stack trace
    return null;
  }
}

module.exports = {
  getTvShowDetails,
  getTvSeasonDetails,
  getTvEpisodeDetails,
};
