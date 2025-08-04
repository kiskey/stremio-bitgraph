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

// R28: The query is enhanced to fetch all necessary fields for the adapter logic.
const torrentFilesQuery = `
query TorrentFiles($input: TorrentFilesQueryInput!) {
  torrent(input: $input) {
    name
    size
    filesCount
    files {
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

// R28: Rewritten function with robust adapter logic.
export async function getTorrentFiles(infoHash) {
    const data = await queryGraphQL(torrentFilesQuery, {
        input: {
            infoHashes: [infoHash]
        }
    });

    if (!data?.torrent || data.torrent.length === 0) {
        logger.warn(`[BITMAGNET] File query for "${infoHash}" returned no torrent object.`);
        return [];
    }
    
    const torrentData = Array.isArray(data.torrent) ? data.torrent[0] : data.torrent;
    const files = torrentData?.files?.items;

    // "Happy Path": If the API returns a populated file list, use it.
    if (files && files.length > 0) {
        logger.debug(`[BITMAGNET] Found ${files.length} files in the standard files.items array.`);
        return files;
    }

    // "Adapter Path": If the file list is empty, but the API indicates it's a single-file torrent.
    logger.debug(`[BITMAGNET] File list is empty. Checking if this is a single-file torrent.`);
    if (torrentData.filesCount === 1 && torrentData.name) {
        logger.info(`[BITMAGNET] API indicates a single-file torrent. Reformatting API response into the expected file-list structure.`);
        // This is not synthesizing. It is reformatting the REAL data from the API.
        const adaptedFile = {
            index: 0,
            path: torrentData.name, // Using the real name from the API
            size: torrentData.size,   // Using the real size from the API
            fileType: 'video'         // This is a safe assumption for single-file media torrents
        };
        return [adaptedFile];
    }

    logger.warn(`[BITMAGNET] File query for "${infoHash}" returned no files and is not a recognized single-file torrent.`);
    return [];
}
