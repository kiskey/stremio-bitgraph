import axios from 'axios';
import { BITMAGNET_GRAPHQL_ENDPOINT } from '../config.js';
import { logger } from './utils.js';

// R29: The search query is enhanced to fetch the critical `hasFilesInfo` status.
const torrentContentSearchQuery = `
query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
  torrentContent {
    search(input: $input) {
      items {
        infoHash
        title
        seeders
        leechers
        publishedAt
        videoResolution
        languages { id }
        torrent {
          name
          size
          filesStatus
          filesCount
          hasFilesInfo
        }
      }
    }
  }
}`;

const torrentFilesQuery = `
query TorrentFiles($input: TorrentFilesQueryInput!) {
  torrent {
    files(input: $input) {
      items {
        index
        path
        size
        fileType
      }
    }
  }
}`;

async function queryGraphQL(query, variables) {
    logger.debug(`[BITMAGNET] Sending GraphQL query with variables: ${JSON.stringify(variables)}`);
    try {
        const response = await axios.post(BITMAGNET_GRAPHQL_ENDPOINT, { query, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });

        // logger.debug(`[BITMAGNET] Raw GraphQL response received: ${JSON.stringify(response.data, null, 2)}`);

        if (response.data.errors) {
            throw new Error(response.data.errors.map(e => e.message).join(', '));
        }
        if (!response.data || !response.data.data) {
            logger.warn('[BITMAGNET] Received empty data object from GraphQL server.');
            return null;
        }
        return response.data.data;
    } catch (error) {
        const errorMessage = error.response ? `Request failed with status code ${error.response.status}` : error.message;
        logger.error(`[BITMAGNET] GraphQL query failed: ${errorMessage}`);
        return null;
    }
}

/**
 * Searches Bitmagnet for torrents.
 * @param {string} searchString - The query string.
 * @param {string} contentType - 'tv_show' or 'movie'.
 * @param {number} limit - Max results to return (default 100).
 */
export async function searchTorrents(searchString, contentType = 'tv_show', limit = 100) {
    logger.debug(`[BITMAGNET] Searching for: "${searchString}" (Type: ${contentType}, Limit: ${limit})`);
    
    // Clean up search string to avoid GraphQL syntax errors if special chars exist
    // Removing quotes and backslashes is usually enough to prevent JSON injection/syntax issues
    const cleanQuery = searchString.replace(/["\\]/g, ''); 

    const data = await queryGraphQL(torrentContentSearchQuery, {
        input: {
            queryString: cleanQuery,
            limit: limit,
            orderBy: [
                { field: 'published_at', descending: true },
                { field: 'seeders', descending: true }
            ],
            facets: { contentType: { filter: [contentType] } }
        }
    });
    const items = data?.torrentContent?.search?.items;
    if (!items) {
        logger.warn(`[BITMAGNET] Search for "${searchString}" returned no items or unexpected structure.`);
        return [];
    }
    return items;
}

export async function getTorrentFiles(infoHash) {
    const data = await queryGraphQL(torrentFilesQuery, {
        input: {
            infoHashes: [infoHash],
            limit: 1000
        }
    });
    
    const items = data?.torrent?.files?.items;

    if (!items) {
        logger.warn(`[BITMAGNET] File query for "${infoHash}" returned no items or an unexpected structure.`);
        return [];
    }

    logger.debug(`[BITMAGNET] Successfully retrieved ${items.length} file(s) for infohash ${infoHash}.`);
    return items;
}
