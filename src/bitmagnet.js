import axios from 'axios';
import { BITMAGNET_GRAPHQL_ENDPOINT } from '../config.js';
import { logger } from './utils.js';

// R27: This query has been removed as it was based on a faulty schema interpretation.
// const torrentContentSearchQuery = `...`;

// This is the correct, unified query for searching content.
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

// R27: This query is now structured to fetch torrents by infoHash and then get their files.
// This is a more standard and robust way to query nested data in GraphQL.
const torrentFilesQuery = `
query GetTorrentByInfoHash($infoHashes: [Hash20!]) {
  torrent(input: { infoHashes: $infoHashes }) {
    infoHash
    name
    files {
      index
      path
      size
      fileType
    }
  }
}`;


// R27: Added comprehensive logging of the raw API response.
async function queryGraphQL(query, variables) {
    logger.debug(`[BITMAGNET] Sending GraphQL query with variables: ${JSON.stringify(variables)}`);
    try {
        const response = await axios.post(BITMAGNET_GRAPHQL_ENDPOINT, { query, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Log the entire raw response for diagnostics
        logger.debug(`[BITMAGNET] Raw GraphQL response received: ${JSON.stringify(response.data, null, 2)}`);

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

// R27: Rewritten to use the new, correct query and handle its response.
export async function getTorrentFiles(infoHash) {
    const data = await queryGraphQL(torrentFilesQuery, {
        infoHashes: [infoHash]
    });
    
    // The new query returns an array of torrents (usually just one).
    const torrentData = data?.torrent?.[0];
    const files = torrentData?.files;

    if (!files) {
        logger.warn(`[BITMAGNET] File query for "${infoHash}" returned no files array.`);
        // Final fallback for single-file torrents where `files` might be null
        if (torrentData && torrentData.name) {
             logger.info(`[BITMAGNET] No files array found, but torrent name exists. Treating as single-file torrent: "${torrentData.name}".`);
             return [{
                 index: 0,
                 path: torrentData.name,
                 size: torrentData.size,
                 fileType: 'video'
             }];
        }
        return [];
    }

    logger.debug(`[BITMAGNET] Successfully retrieved ${files.length} file(s) for infohash ${infoHash}.`);
    return files;
}
