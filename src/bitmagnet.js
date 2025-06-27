/**
 * src/bitmagnet.js
 * Bitmagnet GraphQL Client
 * Handles interactions with the Bitmagnet GraphQL API for torrent searching.
 */

const axios = require('axios');
const config = require('../config');
const { retryWithExponentialBackoff, logger } = require('./utils');

const BITMAGNET_GRAPHQL_ENDPOINT = config.bitmagnet.graphqlEndpoint;

// Removed BITMAGNET_LANGUAGE_MAP as language filtering will be handled client-side.

/**
 * GraphQL query for searching torrent content.
 * Adjusted to match Bitmagnet's `torrentContent { search(input: $input) }` structure.
 */
const TORRENT_CONTENT_SEARCH_QUERY = `
  query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
    torrentContent {
      search(input: $input) {
        items {
          infoHash
          name
          size
          extension
          contentType
          magnetLink
          files {
            path
            size
            index
          }
          content {
            type
            title
            releaseDate
            season
            episode
            seasonEpisode
            originalTitle
            imdbId
            tmdbId
            tvdbId
            episodes {
              season
              episode
            }
          }
          seeders # Directly available on TorrentContent type
          leechers # Directly available on TorrentContent type
          languages { # Assuming 'languages' field is available for content
            id
            name
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for getting files within a specific torrent.
 * Adjusted to match Bitmagnet's `torrent { files(input: $input) }` structure.
 */
const TORRENT_FILES_QUERY = `
  query TorrentFiles($input: TorrentFilesQueryInput!) {
    torrent {
      files(input: $input) {
        items {
          infoHash
          index
          path
          extension
          fileType
          size
        }
      }
    }
  }
`;


/**
 * Searches for torrents on Bitmagnet.
 * @param {string} searchQuery - The search string (e.g., "Game of Thrones S01E01").
 * @param {number} minSeeders - Minimum seeders to filter results.
 * @param {Array<string>} preferredLanguages - Array of preferred language codes (e.g., ['en', 'fr']).
 * Note: This parameter is kept for consistency with the caller, but language filtering is no longer
 * applied directly in the Bitmagnet query; it's delegated to client-side matching.
 * @returns {Promise<Array<object>>} An array of torrent objects from Bitmagnet.
 */
async function searchTorrents(searchQuery, minSeeders = 1, preferredLanguages = ['en']) {
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured.');
    return [];
  }

  logger.info(`Searching Bitmagnet for: "${searchQuery}" with min seeders: ${minSeeders}`);
  // Removed logging of preferred languages here as they are not used in the Bitmagnet query

  const payload = {
    query: TORRENT_CONTENT_SEARCH_QUERY,
    variables: {
      input: {
        queryString: searchQuery,
        orderBy: [
          { field: 'seeders', descending: true } // 'seeders' (lowercase) is correct from schema
        ],
        facets: {
          contentType: {
            filter: ['tv_show'] // 'tv_show' (lowercase) to match enum
          }
        }
        // Removed language facet filter as per requirement
      },
    },
  };

  logger.debug(`Bitmagnet GraphQL Request Payload: ${JSON.stringify(payload, null, 2)}`); // Log the full payload

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload), // Use the prepared payload
      config.bitmagnet.retry
    );

    // Bitmagnet's schema defines `torrentContent.search.items` for results
    const torrents = response.data.data?.torrentContent?.search?.items || [];
    logger.debug(`Bitmagnet search found ${torrents.length} torrents.`);
    logger.debug(`Bitmagnet raw response data (truncated for brevity): ${JSON.stringify(response.data).substring(0, 500)}...`);


    // Client-side filtering for minSeeders (still good practice)
    return torrents.filter(torrent => torrent.seeders >= minSeeders);

  } catch (error) {
    logger.error(`Error searching Bitmagnet for "${searchQuery}":`, error.message);
    if (error.response) {
      logger.error('Bitmagnet HTTP Response Status:', error.response.status);
      logger.error('Bitmagnet HTTP Response Headers:', error.response.headers);
      logger.error('Bitmagnet HTTP Response Data:', JSON.stringify(error.response.data, null, 2)); // Log full response data
      if (error.response.data && error.response.data.errors) {
        logger.error('Bitmagnet GraphQL Errors Array:', JSON.stringify(error.response.data.errors, null, 2)); // Log GraphQL specific errors
      }
    } else if (error.request) {
      logger.error('Bitmagnet Request was made but no response was received:', error.request);
    } else {
      logger.error('Error setting up Bitmagnet request:', error.message);
    }
    return [];
  }
}

/**
 * Fetches files for a specific torrent infohash from Bitmagnet.
 * This is crucial for matching episodes within season packs.
 * @param {string} infoHash - The infohash of the torrent.
 * @returns {Promise<Array<object>>} An array of file objects for the torrent.
 */
async function getTorrentFiles(infoHash) {
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured.');
    return [];
  }

  logger.debug(`Fetching files for infohash: ${infoHash}`);
  const payload = {
    query: TORRENT_FILES_QUERY,
    variables: {
      input: { // Wrap infoHash in an 'input' object
        infoHashes: [infoHash], // Expects an array of infoHashes
      },
    },
  };
  logger.debug(`Bitmagnet Torrent Files Request Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload),
      config.bitmagnet.retry
    );

    // Access files through torrent.files.items based on the new schema structure
    const files = response.data.data?.torrent?.files?.items || [];
    logger.debug(`Found ${files.length} files for infohash ${infoHash}.`);
    logger.debug(`Bitmagnet torrent files raw response data (truncated for brevity): ${JSON.stringify(response.data).substring(0, 500)}...`);

    return files;
  } catch (error) {
    logger.error(`Error fetching torrent files for ${infoHash} from Bitmagnet: ${error.message}`);
    if (error.response) {
      logger.error('Bitmagnet HTTP Response Status:', error.response.status);
      logger.error('Bitmagnet HTTP Response Headers:', error.response.headers);
      logger.error('Bitmagnet HTTP Response Data:', JSON.stringify(error.response.data, null, 2)); // Log full response data
      if (error.response.data && error.response.data.errors) {
        logger.error('Bitmagnet GraphQL Errors Array:', JSON.stringify(error.response.data.errors, null, 2));
      }
    } else if (error.request) {
      logger.error('Bitmagnet Request was made but no response was received:', error.request);
    } else {
      logger.error('Error setting up Bitmagnet torrent files request:', error.message);
    }
    return [];
  }
}

module.exports = {
  searchTorrents,
  getTorrentFiles,
};
