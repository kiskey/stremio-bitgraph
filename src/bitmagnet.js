import axios from 'axios';
import { BITMAGNET_GRAPHQL_ENDPOINT } from '../config.js';
import { logger } from './utils.js';

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

// --- CORRECTED FUNCTION SIGNATURE AND LOGIC ---
// It now accepts a contentType to correctly filter the search.
export async function searchTorrents(searchString, contentType = 'tv_show') {
    logger.debug(`[BITMAGNET] Searching for contentType: "${contentType}"`);
    const data = await queryGraphQL(torrentContentSearchQuery, {
        input: {
            queryString: searchString,
            limit: 100,
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
        logger.warn(`[BITMAGNET] File query for "${infoHash}" returned no items.`);
        return [];
    }
    return items;
}
