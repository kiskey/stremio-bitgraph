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

// R29: This query is now 100% compliant with the provided GraphQL schema.
// It correctly follows the nested structure `query { torrent { files(input: ...) } }`.
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

// R29: The function and its call are now fully schema-compliant, removing the need for complex workarounds.
// The second argument `torrentDataFromSearch` is no longer needed as the query is now reliable.
export async function getTorrentFiles(infoHash) {
    const data = await queryGraphQL(torrentFilesQuery, {
        input: {
            infoHashes: [infoHash],
            limit: 1000 // A reasonable limit for files in a pack
        }
    });
    
    // According to the schema, the response will always be in `data.torrent.files.items`.
    const items = data?.torrent?.files?.items;

    if (!items) {
        logger.warn(`[BITMAGNET] File query for "${infoHash}" returned no items or an unexpected structure. This may indicate an actual empty torrent or an API issue.`);
        return [];
    }

    // Now that the query is correct, we can trust the API's response directly.
    logger.debug(`[BITMAGNET] Successfully retrieved ${items.length} file(s) for infohash ${infoHash}.`);
    return items;
}
