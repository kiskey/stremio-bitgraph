import axios from 'axios';
import { BITMAGNET_GRAPHQL_ENDPOINT } from '../config.js';
import { logger } from './utils.js';

const torrentContentSearchQuery = `
query TorrentContentSearch($input: TorrentContentSearchQueryInput!) {
  torrentContent {
    search(input: $input) {
      items {
        infoHash
        name
        size
        seeders
        leechers
        filesStatus
        filesCount
        videoResolution
        languages { id }
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
    try {
        const response = await axios.post(BITMAGNET_GRAPHQL_ENDPOINT, { query, variables }, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.data.errors) {
            throw new Error(response.data.errors.map(e => e.message).join(', '));
        }
        return response.data.data;
    } catch (error) {
        logger.error(`Bitmagnet GraphQL query failed: ${error.message}`);
        return null;
    }
}

export async function searchTorrents(searchString) {
    const data = await queryGraphQL(torrentContentSearchQuery, {
        input: {
            queryString: searchString,
            limit: 100, // Fetch a good number of results to process
            orderBy: [{ field: 'seeders', descending: true }],
            facets: { contentType: { filter: ["tv_show"] } }
        }
    });
    return data ? data.torrentContent.search.items : [];
}

export async function getTorrentFiles(infoHash) {
    const data = await queryGraphQL(torrentFilesQuery, {
        input: {
            infoHashes: [infoHash],
            limit: 1000 // Ensure all files in a pack are fetched
        }
    });
    return data ? data.torrent.files.items : [];
}
