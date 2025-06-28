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
 * GraphQL fragment for common TorrentContent fields.
 * This aligns with the user's provided "working" query model and the Bitmagnet schema.
 */
const TORRENT_CONTENT_FIELDS_FRAGMENT = `
  fragment TorrentContentFields on TorrentContent {
    id
    infoHash
    contentType
    title
    languages {
      id
      name
    }
    episodes {
      label
      seasons {
        season
        episodes
      }
    }
    video3d
    videoCodec
    videoModifier
    videoResolution
    videoSource
    releaseGroup
    seeders
    leechers
    publishedAt
    magnetUri 
    files { 
      path
      size
      index
      extension
      fileType
    }
    torrent { 
      name
      size
      fileType
      tagNames
      # infoHash is directly on TorrentContent, no need to duplicate here
      # magnetUri is directly on TorrentContent, no need to duplicate here
      seeders # Seeders from torrent level if available
      leechers # Leechers from torrent level if available
    }
    content { 
      source
      id
      title
      releaseDate
      releaseYear
      runtime
      overview
      externalLinks {
        url
      }
      originalLanguage {
        id
        name
      }
    }
  }
`;

/**
 * GraphQL query for searching torrent content.
 * Uses the fragment and includes totalCount and hasNextPage.
 */
const TORRENT_CONTENT_SEARCH_QUERY = `
  ${TORRENT_CONTENT_FIELDS_FRAGMENT}
  query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
    torrentContent {
      search(input: $input) {
        items {
          ...TorrentContentFields 
        }
        totalCount 
        hasNextPage 
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
 * @returns {Promise<Array<object>>} An array of torrent objects from Bitmagnet.
 */
async function searchTorrents(searchQuery, minSeeders = 1) { // Removed preferredLanguages from signature
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured. Please set BITMAGNET_GRAPHQL_ENDPOINT in your environment variables.');
    return [];
  }

  logger.info(`Searching Bitmagnet for: "${searchQuery}" with min seeders: ${minSeeders}`);
  logger.debug(`Bitmagnet GraphQL endpoint being used for search: ${BITMAGNET_GRAPHQL_ENDPOINT}`);

  const payload = {
    query: TORRENT_CONTENT_SEARCH_QUERY,
    variables: {
      input: {
        queryString: searchQuery,
        orderBy: [
          { field: 'seeders', descending: true } 
        ],
        facets: {
          contentType: {
            filter: ['tv_show'] 
          }
        }
      },
    },
  };

  logger.debug(`Bitmagnet GraphQL Request Payload: ${JSON.stringify(payload, null, 2)}`); // Log the full payload

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload), // Use the prepared payload
      config.retry // Using general retry config
    );

    // CRITICAL FIX: Add explicit null/undefined check for response and response.data
    if (!response || !response.data) {
        logger.error(`Bitmagnet API call for search query "${searchQuery}" returned an invalid or empty response object.`);
        return [];
    }

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
      logger.error('Bitmagnet Request was made but no response was received (network issue, CORS, etc.):', error.request);
    } else {
      logger.error('Error setting up Bitmagnet request (e.g., malformed URL):', error.message);
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
    logger.error('Bitmagnet GraphQL endpoint is not configured. Please set BITMAGNET_GRAPHQL_ENDPOINT in your environment variables.');
    return [];
  }

  logger.debug(`Fetching files for infohash: ${infoHash}`);
  logger.debug(`Bitmagnet GraphQL endpoint being used for files: ${BITMAGNET_GRAPHQL_ENDPOINT}`);

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
      config.retry // Using general retry config
    );

    // CRITICAL FIX: Add explicit null/undefined check for response and response.data
    if (!response || !response.data) {
        logger.error(`Bitmagnet API call for files of infoHash "${infoHash}" returned an invalid or empty response object.`);
        return [];
    }

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
      logger.error('Bitmagnet Request was made but no response was received (network issue, CORS, etc.):', error.request);
    } else {
      logger.error('Error setting up Bitmagnet torrent files request (e.g., malformed URL):', error.message);
    }
    return [];
  }
}

module.exports = {
  searchTorrents,
  getTorrentFiles,
};
