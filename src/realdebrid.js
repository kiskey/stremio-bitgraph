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
        logger.error(`[RD] Error adding magnet: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

export async function getTorrentInfo(torrentId, apiKey) {
    try {
        const response = await rd.get(`/torrents/info/${torrentId}`, getAuthHeader(apiKey));
        return response.data;
    } catch (error) {
        logger.error(`[RD] Error getting torrent info: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

export async function selectFiles(torrentId, fileIds, apiKey) {
    const formData = new URLSearchParams();
    formData.append('files', fileIds); // Can be 'all' or comma-separated IDs

    try {
        await rd.post(`/torrents/selectFiles/${torrentId}`, formData, getAuthHeader(apiKey));
        return true;
    } catch (error) {
        logger.error(`[RD] Error selecting files: ${error.response?.data?.error || error.message}`);
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
        logger.error(`[RD] Error unrestricting link: ${error.response?.data?.error || error.message}`);
        return null;
    }
}

export async function pollTorrentUntilReady(torrentId, apiKey) {
    // Adjusted polling to time out around the 3-minute mark
    let attempts = 0;
    const maxAttempts = 12; // 12 attempts
    let delay = 5000; // Start with 5 seconds
    const maxDelay = 20000; // Cap at 20 seconds

    while (attempts < maxAttempts) {
        const torrentInfo = await getTorrentInfo(torrentId, apiKey);
        if (!torrentInfo) {
            throw new Error('Failed to get torrent info during polling.');
        }

        if (['magnet_error', 'error', 'dead'].includes(torrentInfo.status)) {
            throw new Error(`Torrent failed on Real-Debrid with status: ${torrentInfo.status}`);
        }

        if (torrentInfo.status === 'downloaded') {
            logger.info(`[RD] Torrent ${torrentId} is ready.`);
            return torrentInfo;
        }

        logger.debug(`[RD] Polling for torrent ${torrentId}, status: ${torrentInfo.status}, attempt ${attempts + 1}/${maxAttempts}`);
        await sleep(delay);
        delay = Math.min(delay * 1.5, maxDelay); // Exponential backoff
        attempts++;
    }

    throw new Error('Torrent polling timed out after ~3 minutes.');
}
