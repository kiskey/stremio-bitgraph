import axios from 'axios';
import { TMDB_API_KEY } from '../config.js';
import { logger } from './utils.js';

const tmdb = axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    params: {
        api_key: TMDB_API_KEY,
    },
});

// In-memory cache to avoid re-fetching the same show details repeatedly
const showCache = new Map();

export async function getShowDetails(imdbId) {
    if (showCache.has(imdbId)) {
        return showCache.get(imdbId);
    }

    try {
        const findResponse = await tmdb.get(`/find/${imdbId}`, {
            params: { external_source: 'imdb_id' },
        });

        if (!findResponse.data.tv_results || findResponse.data.tv_results.length === 0) {
            throw new Error(`No TV show found on TMDB for IMDb ID: ${imdbId}`);
        }

        const show = findResponse.data.tv_results[0];
        showCache.set(imdbId, show); // Cache the result
        return show;

    } catch (error) {
        logger.error(`Error fetching show details from TMDB for ${imdbId}: ${error.message}`);
        return null;
    }
}
