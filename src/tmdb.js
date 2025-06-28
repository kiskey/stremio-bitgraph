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
const movieCache = new Map();

export async function getShowDetails(imdbId) {
    if (showCache.has(imdbId)) {
        logger.debug(`[TMDB] Returning cached series details for ${imdbId}`);
        return showCache.get(imdbId);
    }
    try {
        const findResponse = await tmdb.get(`/find/${imdbId}`, { params: { external_source: 'imdb_id' } });
        if (!findResponse.data.tv_results || findResponse.data.tv_results.length === 0) {
            throw new Error(`No TV show found on TMDB for IMDb ID: ${imdbId}`);
        }
        const show = findResponse.data.tv_results[0];
        logger.debug(`[TMDB] Found series: "${show.name}" (ID: ${show.id})`);
        showCache.set(imdbId, show);
        return show;
    } catch (error) {
        logger.error(`[TMDB] Error fetching series details for ${imdbId}: ${error.message}`);
        return null;
    }
}

// NEW: Function to get movie details
export async function getMovieDetails(imdbId) {
    if (movieCache.has(imdbId)) {
        logger.debug(`[TMDB] Returning cached movie details for ${imdbId}`);
        return movieCache.get(imdbId);
    }
    try {
        const findResponse = await tmdb.get(`/find/${imdbId}`, { params: { external_source: 'imdb_id' } });
        if (!findResponse.data.movie_results || findResponse.data.movie_results.length === 0) {
            throw new Error(`No movie found on TMDB for IMDb ID: ${imdbId}`);
        }
        const movie = findResponse.data.movie_results[0];
        logger.debug(`[TMDB] Found movie: "${movie.title}" (ID: ${movie.id})`);
        movieCache.set(imdbId, movie);
        return movie;
    } catch (error) {
        logger.error(`[TMDB] Error fetching movie details for ${imdbId}: ${error.message}`);
        return null;
    }
}
