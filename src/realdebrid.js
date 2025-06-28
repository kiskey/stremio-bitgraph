import axios from 'axios';
import { logger, sleep } from './utils.js';

const rd = axios.create({
    baseURL: 'https://api.real-debrid.com/rest/1.0',
});

function getAuthHeader(apiKey) {
    return { headers: { Authorization: `Bearer ${apiKey}` } };
}

export async function addMagnet(magnetLink, apiKey) {
    const formData = new URLSearchParams();
    formData.append('magnet', magnetLink);

    try {
        const response = await rd.post('/torrents/addMagnet', formData, getAuthHeader(apiKey));
        return response.data;
    } catch (error) {
        logger.error(`RD Error adding magnet: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

export async function getTorrentInfo(torrentId, apiKey) {
    try {
        const response = await rd.get(`/torrents/info/${torrentId}`, getAuthHeader(apiKey));
        return response.data;
    } catch (error) {
        logger.error(`RD Error getting torrent info: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

export async function selectFiles(torrentId, fileIds, apiKey) {
    const formData = new URLSearchParams();
    formData.append('files', fileIds); // 'all' or comma-separated IDs

    try {
        await rd.post(`/torrents/selectFiles/${torrentId}`, formData, getAuthHeader(apiKey));
        return true;
    } catch (error) {
        logger.error(`RD Error selecting files: ${error.response?.data?.error || error.message}`);
        return false;
    }
}

export async function unrestrictLink(link, apiKey) {
    const formData = new URLSearchParams();
    formData.append('link', link);

    try {
        const response = await rd.post('/unrestrict/link', formData, getAuthHeader(apiKey));
        return response.data;
    } catch (error) {
        logger.error(`RD Error unrestricting link: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

export async function pollTorrentUntilReady(torrentId, apiKey) {
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes with increasing delay
    let delay = 2000; // Start with 2 seconds

    while (attempts < maxAttempts) {
        const torrentInfo = await getTorrentInfo(torrentId, apiKey);
        if (!torrentInfo) {
            throw new Error('Failed to get torrent info during polling.');
        }

        // Check for error states
        if (['magnet_error', 'error', 'dead'].includes(torrentInfo.status)) {
            throw new Error(`Torrent failed on Real-Debrid with status: ${torrentInfo.status}`);
        }

        // Success state
        if (torrentInfo.status === 'downloaded') {
            logger.info(`Torrent ${torrentId} is ready.`);
            return torrentInfo;
        }

        // Still processing, wait and retry
        logger.info(`Polling RD for torrent ${torrentId}, status: ${torrentInfo.status}, attempt ${attempts + 1}/${maxAttempts}`);
        await sleep(delay);
        delay = Math.min(delay * 1.5, 20000); // Exponential backoff with a cap
        attempts++;
    }

    throw new Error('Torrent polling timed out after several attempts.');
}
