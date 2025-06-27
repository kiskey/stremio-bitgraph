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
 * Fragment for TorrentContent fields.
 * Derived from the provided 'app_log.txt' which includes TorrentContent, Torrent, and Content fragments.
 * This combines them to fetch all necessary data for our matching logic.
 */
const TORRENT_CONTENT_FRAGMENT = `
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
    torrent { # Nested Torrent fragment (fields from 'fragment Torrent')
      infoHash
      name
      size
      filesStatus
      filesCount
      hasFilesInfo
      singleFile
      fileType
      sources {
        key
        name
      }
      seeders
      leechers
      tagNames
      magnetUri
      createdAt
      updatedAt
    }
    content { # Nested Content fragment (fields from 'fragment Content')
      type
      source
      id
      metadataSource {
        key
        name
      }
      title
      releaseDate
      releaseYear
      overview
      runtime
      voteAverage
      voteCount
      originalLanguage {
        id
        name
      }
      attributes {
        metadataSource {
          key
          name
        }
        source
        key
        value
        createdAt
        updatedAt
      }
      collections {
        metadataSource {
          key
          name
        }
        type
        source
        id
        name
        createdAt
        updatedAt
      }
      externalLinks {
        metadataSource {
          key
          name
        }
        url
      }
      createdAt
      updatedAt
    }
  }
`;

/**
 * Fragment for TorrentContentSearchResult.
 * This defines the shape of the search results including items, totalCount, hasNextPage, and aggregations.
 */
const TORRENT_CONTENT_SEARCH_RESULT_FRAGMENT = `
  ${TORRENT_CONTENT_FRAGMENT} # Include the TorrentContent fragment
  fragment TorrentContentSearchResultFields on TorrentContentSearchResult {
    items {
      ...TorrentContentFields
    }
    totalCount
    totalCountIsEstimate
    hasNextPage
    aggregations {
      contentType { value label count isEstimate }
      torrentSource { value label count isEstimate }
      torrentTag { value label count isEstimate }
      torrentFileType { value label count isEstimate }
      language { value label count isEstimate }
      genre { value label count isEstimate }
      releaseYear { value label count isEstimate }
      videoResolution { value label count isEstimate }
      videoSource { value label count isEstimate }
    }
  }
`;

/**
 * GraphQL query for searching torrent content.
 * Directly uses the TorrentContentSearchResult fragment.
 * Includes orderBy for seeders and publishedAt, and limit for results.
 */
const TORRENT_CONTENT_SEARCH_QUERY = `
  ${TORRENT_CONTENT_SEARCH_RESULT_FRAGMENT}
  query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
    torrentContent {
      search(input: $input) {
        ...TorrentContentSearchResultFields
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
 * @param {string} searchQuery - The search string (e.g., "Game of Thrones S01E01").
 * NOTE: This parameter will now contain the refined search string (e.g., "Show Title" SXXEXX).
 * @param {number} minSeeders - Minimum seeders for client-side filtering.
 * @returns {Promise<Array<object>>} An array of torrent objects from Bitmagnet.
 */
async function searchTorrents(searchQuery, minSeeders = 1) {
  if (!BITMAGNET_GRAPHQL_ENDPOINT || BITMAGNET_GRAPHQL_ENDPOINT === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
    logger.error('Bitmagnet GraphQL endpoint is not configured.');
    return [];
  }

  // CRITICAL FIX: Removed mention of min seeders in log, as it's not applied in Bitmagnet query
  logger.info(`Searching Bitmagnet for query: "${searchQuery}"`);

  const payload = {
    query: TORRENT_CONTENT_SEARCH_QUERY,
    variables: {
      input: {
        queryString: searchQuery,
        limit: 50, // Limit to 50 results as requested
        orderBy: [
          { field: 'seeders', descending: true }, // Order by highest seeders first
          { field: 'published_at', descending: true } // Then by most recent published date
        ],
        facets: {
          contentType: {
            filter: ['tv_show'] // 'tv_show' (lowercase) to match enum
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

    const torrents = response.data.data?.torrentContent?.search?.items || [];
    logger.info(`Bitmagnet returned ${torrents.length} potential torrents for "${searchQuery}".`);
    logger.debug(`Bitmagnet raw response data (truncated for brevity): ${JSON.stringify(response.data).substring(0, 500)}...`);

    // Client-side filtering for minSeeders (still applied here)
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
      logger.error('Bitmagnet Request was made but no response was received:', error.request);
    } else {
      logger.error('Error setting up Bitmagnet request:', error.message);
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
