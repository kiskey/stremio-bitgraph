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
 * CRITICAL FIX: Re-aligned precisely with fields observed in the user's
 * working 'query_log.txt' for the `torrentContent.search.items` structure.
 * This includes `magnetUri` and `files` directly on TorrentContent,
 * while also fetching essential nested `torrent` and `content` fields.
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
    createdAt
    updatedAt
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
    }
    content { 
      source
      id
      title
      releaseDate
      releaseYear
      overview
      runtime
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
 * Fragment for TorrentFile fields.
 */
const TORRENT_FILE_FRAGMENT = `
  fragment TorrentFileFields on TorrentFile {
    infoHash
    index
    path
    size
    fileType
    createdAt
    updatedAt
  }
`;

/**
 * Fragment for TorrentFilesQueryResult.
 */
const TORRENT_FILES_QUERY_RESULT_FRAGMENT = `
  ${TORRENT_FILE_FRAGMENT}
  fragment TorrentFilesQueryResultFields on TorrentFilesQueryResult {
    items {
      ...TorrentFileFields
    }
    totalCount
    hasNextPage
  }
`;

/**
 * GraphQL query for getting files within a specific torrent.
 * Uses the TorrentFilesQueryResult fragment.
 */
const TORRENT_FILES_QUERY = `
  ${TORRENT_FILES_QUERY_RESULT_FRAGMENT}
  query TorrentFiles($input: TorrentFilesQueryInput!) {
    torrent {
      files(input: $input) {
        ...TorrentFilesQueryResultFields
      }
    }
  }
`;


/**
 * Searches for torrents on Bitmagnet.
 * @param {string} searchQuery - The search string (e.g., "Game of Thrones").
 * @param {number} minSeeders - Minimum seeders to filter results.
 * @returns {Promise<Array<object>>} An array of torrent objects from Bitmagnet.
 */
async function searchTorrents(searchQuery, minSeeders = 1) {
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured.');
    return [];
  }

  logger.info(`Searching Bitmagnet for query: "${searchQuery}"`);
  logger.debug(`Bitmagnet GraphQL endpoint being used for search: ${BITMAGNET_GRAPHQL_ENDPOINT}`);

  const payload = {
    query: TORRENT_CONTENT_SEARCH_QUERY,
    variables: {
      input: {
        queryString: searchQuery,
        limit: 50,
        orderBy: [
          { field: 'seeders', descending: true },
          { field: 'published_at', descending: true }
        ],
        facets: {
          contentType: {
            filter: ['tv_show']
          }
        }
      },
    },
  };

  logger.debug(`Bitmagnet GraphQL Request Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload),
      config.bitmagnet.retry
    );

    if (!response || !response.data) {
        logger.error(`Bitmagnet API call for search query "${searchQuery}" returned an invalid or empty response object.`);
        return [];
    }

    const torrents = response.data.data?.torrentContent?.search?.items || [];
    logger.debug(`Bitmagnet search found ${torrents.length} torrents.`);
    logger.debug(`Bitmagnet raw response data (truncated for brevity): ${JSON.stringify(response.data).substring(0, 500)}...`);

    return torrents.filter(torrent => torrent.seeders >= minSeeders);

  } catch (error) {
    logger.error(`Error searching Bitmagnet for "${searchQuery}":`, error.message);
    if (error.response) {
      logger.error('Bitmagnet HTTP Response Status:', error.response.status);
      logger.error('Bitmagnet HTTP Response Headers:', error.response.headers);
      logger.error('Bitmagnet HTTP Response Data:', JSON.stringify(error.response.data, null, 2));
      if (error.response.data && error.response.data.errors) {
        logger.error('Bitmagnet GraphQL Errors Array:', JSON.stringify(error.response.data.errors, null, 2));
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
 * @param {string} infoHash - The infohash of the torrent.
 * @returns {Promise<Array<object>>} An array of file objects for the torrent.
 */
async function getTorrentFiles(infoHash) {
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured.');
    return [];
  }

  logger.debug(`Fetching files for infohash: ${infoHash}`);
  logger.debug(`Bitmagnet GraphQL endpoint being used for files: ${BITMAGNET_GRAPHQL_ENDPOINT}`);

  const payload = {
    query: TORRENT_FILES_QUERY,
    variables: {
      input: {
        infoHashes: [infoHash],
      },
    },
  };
  logger.debug(`Bitmagnet Torrent Files Request Payload: ${JSON.stringify(payload, null, 2)}`);

  try {
    const response = await retryWithExponentialBackoff(
      async () => axios.post(BITMAGNET_GRAPHQL_ENDPOINT, payload),
      config.bitmagnet.retry
    );

    if (!response || !response.data) {
        logger.error(`Bitmagnet API call for files of infoHash "${infoHash}" returned an invalid or empty response object.`);
        return [];
    }

    const files = response.data.data?.torrent?.files?.items || [];
    logger.debug(`Found ${files.length} files for infohash ${infoHash}.`);
    logger.debug(`Bitmagnet torrent files raw response data (truncated for brevity): ${JSON.stringify(response.data).substring(0, 500)}...`);

    return files;
  } catch (error) {
    logger.error(`Error fetching torrent files for ${infoHash} from Bitmagnet: ${error.message}`);
    if (error.response) {
      logger.error('Bitmagnet HTTP Response Status:', error.response.status);
      logger.error('Bitmagnet HTTP Response Headers:', error.response.headers);
      logger.error('Bitmagnet HTTP Response Data:', JSON.stringify(error.response.data, null, 2));
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
