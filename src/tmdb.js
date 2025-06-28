import axios from 'axios';
import { TMDB_API_KEY } from '../config.js';
import { logger } from './utils.js';

const tmdb = axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    params: {
        api_key: TMDB_API_KEY,
    },
});

const showCache = new Map();

export async function getShowDetails(imdbId) {
    if (showCache.has(imdbId)) {
        logger.debug(`[TMDB] Returning cached details for ${imdbId}`);
        return showCache.get(imdbId);
    }

    try {
        logger.debug(`[TMDB] Finding TV show with IMDb ID: ${imdbId}`);
        const findResponse = await tmdb.get(`/find/${imdbId}`, {
            params: { external_source: 'imdb_id' },
        });

        if (!findResponse.data.tv_results || findResponse.data.tv_results.length === 0) {
            throw new Error(`No TV show found on TMDB for IMDb ID: ${imdbId}`);
        }

        const show = findResponse.data.tv_results[0];
        logger.debug(`[TMDB] Found show: "${show.name}" (ID: ${show.id})`);
        showCache.set(imdbId, show);
        return show;

    } catch (error) {
        logger.error(`[TMDB] Error fetching show details for ${imdbId}: ${error.message}`);
        return null;
    }
}
