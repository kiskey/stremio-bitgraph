/**
 * src/bitmagnet.js
 * Bitmagnet GraphQL Client
 * Handles interactions with the Bitmagnet GraphQL API for torrent searching.
 */

const axios = require('axios');
const config = require('../config');
const { retryWithExponentialBackoff, logger } = require('./utils');

const BITMAGNET_GRAPHQL_ENDPOINT = config.bitmagnet.graphqlEndpoint;

/**
 * GraphQL query for searching torrent content.
 * Adjust fields as needed based on Bitmagnet's actual schema.
 */
const TORRENT_CONTENT_SEARCH_QUERY = `
  query TorrentContentSearch($query: String!, $orderBy: [TorrentContentOrderByWithNulls!]!) {
    torrentContentSearch(query: $query, orderBy: $orderBy, type: TV_SERIES) {
      items {
        infoHash
        name
        size
        extension
        contentType
        releaseDate
        magnetLink
        files {
          path
          size
          index
        }
        source {
          source
          url
          infoHash
          publishedAt
          torrentId
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
        # Assuming these exist based on schema examples or introspection
        # If not, remove them or get them via another query
        # tags {
        #   tag
        # }
        # languages {
        #   language
        # }
      }
    }
  }
`;

/**
 * GraphQL query for getting files within a specific torrent.
 */
const TORRENT_FILES_QUERY = `
  query TorrentFiles($infoHash: String!) {
    torrent(infoHash: $infoHash) {
      files {
        path
        size
        index
      }
    }
  }
`;


/**
 * Searches for torrents on Bitmagnet.
 * @param {string} searchQuery - The search string (e.g., "Game of Thrones S01E01").
 * @param {number} minSeeders - Minimum seeders to filter results.
 * @returns {Promise<Array<object>>} An array of torrent objects from Bitmagnet.
 */
async function searchTorrents(searchQuery, minSeeders = 1) {
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured.');
    return [];
  }

  logger.info(`Searching Bitmagnet for: "${searchQuery}" with min seeders: ${minSeeders}`);

  const payload = {
    query: TORRENT_CONTENT_SEARCH_QUERY,
    variables: {
      query: searchQuery,
      orderBy: [
        { field: 'SEEDERS', direction: 'DESC' }
      ],
      // Bitmagnet's text search guide allows `min_seeders` in query string
      // If `minSeeders` is a direct filter in GraphQL, it would be here.
      // Assuming it's part of the `TorrentContentSearch` filter arguments.
      // If not, client-side filtering would be needed after results.
    },
  };

  logger.debug(`Bitmagnet GraphQL Request Payload: ${JSON.stringify(payload, null, 2)}`); // Log the full payload

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload), // Use the prepared payload
      config.bitmagnet.retry
    );

    // Bitmagnet's schema might be different. Adjust response parsing if needed.
    const torrents = response.data.data?.torrentContentSearch?.items || [];
    logger.debug(`Bitmagnet search found ${torrents.length} torrents.`);

    // Client-side filtering for minSeeders if not directly supported by Bitmagnet GraphQL query
    return torrents.filter(torrent => torrent.seeders >= minSeeders);

  } catch (error) {
    logger.error(`Error searching Bitmagnet for "${searchQuery}":`, error.message);
    if (error.response) {
      logger.error('Bitmagnet HTTP Response Status:', error.response.status);
      logger.error('Bitmagnet HTTP Response Data:', JSON.stringify(error.response.data, null, 2)); // Log full response data
    } else if (error.request) {
      logger.error('Bitmagnet Request was made but no response was received:', error.request);
    } else {
      logger.error('Error setting up Bitmagnet request:', error.message);
    }
    if (error.response && error.response.data && error.response.data.errors) {
      logger.error('Bitmagnet GraphQL Errors:', JSON.stringify(error.response.data.errors, null, 2));
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
      infoHash: infoHash,
    },
  };
  logger.debug(`Bitmagnet Torrent Files Request Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload),
      config.bitmagnet.retry
    );

    const files = response.data.data?.torrent?.files || [];
    logger.debug(`Found ${files.length} files for infohash ${infoHash}.`);
    return files;
  } catch (error) {
    logger.error(`Error fetching torrent files for ${infoHash} from Bitmagnet: ${error.message}`);
    if (error.response) {
      logger.error('Bitmagnet HTTP Response Status:', error.response.status);
      logger.error('Bitmagnet HTTP Response Data:', JSON.stringify(error.response.data, null, 2)); // Log full response data
    } else if (error.request) {
      logger.error('Bitmagnet Request was made but no response was received:', error.request);
    } else {
      logger.error('Error setting up Bitmagnet torrent files request:', error.message);
    }
    if (error.response && error.response.data && error.response.data.errors) {
      logger.error('Bitmagnet GraphQL Errors:', JSON.stringify(error.response.data.errors, null, 2));
    }
    return [];
  }
}


module.exports = {
  searchTorrents,
  getTorrentFiles,
};
