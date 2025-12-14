import axios from 'axios';
import { TMDB_API_KEY, OMDB_API_KEY, TRAKT_CLIENT_ID } from '../config.js';
import { logger } from './utils.js';

const tmdb = axios.create({ baseURL: 'https://api.themoviedb.org/3', params: { api_key: TMDB_API_KEY } });
const cinemeta = axios.create({ baseURL: 'https://v3-cinemeta.strem.io/meta' });

// Conditional clients for optional APIs
const omdb = OMDB_API_KEY ? axios.create({ baseURL: 'http://www.omdbapi.com', params: { apikey: OMDB_API_KEY } }) : null;
const trakt = TRAKT_CLIENT_ID ? axios.create({ baseURL: 'https://api.trakt.tv', headers: { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CLIENT_ID } }) : null;

const metaCache = new Map();

/**
 * Normalized Metadata Object Structure:
 * { 
 *   name: "Title", 
 *   year: "2020", 
 *   source: "ProviderName" 
 * }
 */

// --- PROVIDER IMPLEMENTATIONS ---

async function fetchTmdb(imdbId, type) {
    try {
        const route = type === 'series' ? 'tv' : 'movie';
        // TMDB 'find' endpoint is robust
        const findResponse = await tmdb.get(`/find/${imdbId}`, { params: { external_source: 'imdb_id' } });
        
        const results = type === 'series' ? findResponse.data.tv_results : findResponse.data.movie_results;
        if (!results || results.length === 0) throw new Error('Not found');
        
        const item = results[0];
        // Normalize
        return {
            name: type === 'series' ? item.name : item.title,
            year: type === 'series' ? (item.first_air_date ? item.first_air_date.split('-')[0] : null) : (item.release_date ? item.release_date.split('-')[0] : null),
            source: 'TMDB'
        };
    } catch (e) {
        throw new Error(`TMDB lookup failed: ${e.message}`);
    }
}

async function fetchCinemeta(imdbId, type) {
    try {
        // Cinemeta uses 'series' or 'movie' directly in URL
        const response = await cinemeta.get(`/${type}/${imdbId}.json`);
        const meta = response.data?.meta;
        if (!meta) throw new Error('Not found');
        
        // V6.1 Tweak: Robust Year Extraction
        // Checks 'year' OR 'releaseInfo', then uses regex to find the first 4-digit number.
        // Handles "2025–", "2023", "2010-2014", etc.
        const yearStr = meta.year || meta.releaseInfo || '';
        const extractedYear = yearStr.match(/\d{4}/)?.[0] || null;

        return {
            name: meta.name,
            year: extractedYear,
            source: 'Cinemeta'
        };
    } catch (e) {
        throw new Error(`Cinemeta lookup failed: ${e.message}`);
    }
}

async function fetchOmdb(imdbId) {
    if (!omdb) throw new Error('OMDb not configured');
    try {
        const response = await omdb.get('', { params: { i: imdbId } });
        if (response.data.Response === 'False') throw new Error(response.data.Error);
        
        return {
            name: response.data.Title,
            year: response.data.Year ? response.data.Year.replace(/–.*/, '') : null,
            source: 'OMDb'
        };
    } catch (e) {
        throw new Error(`OMDb lookup failed: ${e.message}`);
    }
}

async function fetchTrakt(imdbId, type) {
    if (!trakt) throw new Error('Trakt not configured');
    try {
        const searchType = type === 'series' ? 'show' : 'movie';
        const response = await trakt.get(`/search/imdb/${imdbId}`, { params: { type: searchType } });
        
        if (!response.data || response.data.length === 0) throw new Error('Not found');
        const item = response.data[0][searchType];
        
        return {
            name: item.title,
            year: item.year ? item.year.toString() : null,
            source: 'Trakt'
        };
    } catch (e) {
        throw new Error(`Trakt lookup failed: ${e.message}`);
    }
}

// --- ORCHESTRATION ---

export async function getMetaDetails(imdbId, type) {
    const cacheKey = `${imdbId}_${type}`;
    if (metaCache.has(cacheKey)) {
        logger.debug(`[METADATA] Cache hit for ${imdbId} (${type})`);
        return metaCache.get(cacheKey);
    }

    logger.info(`[METADATA] resolving metadata for ${imdbId} (${type})...`);

    // TIER 1: Parallel Execution (TMDB + Cinemeta)
    // V6 Fix: Attach .catch() immediately to silence unhandled background rejections
    const tmdbPromise = fetchTmdb(imdbId, type);
    const cinemetaPromise = fetchCinemeta(imdbId, type).catch(err => {
        logger.debug(`[METADATA] Background Cinemeta lookup failed/ignored: ${err.message}`);
        return null; 
    });

    let result = null;

    try {
        // Wait for TMDB (Primary)
        result = await tmdbPromise;
        logger.debug(`[METADATA] Resolved via TMDB: "${result.name}"`);
    } catch (tmdbError) {
        logger.warn(`[METADATA] TMDB failed for ${imdbId}. Falling back to Cinemeta... Error: ${tmdbError.message}`);
        try {
            // Fallback to Cinemeta
            result = await cinemetaPromise;
            
            if (result) {
                logger.info(`[METADATA] Resolved via Cinemeta: "${result.name}"`);
            } else {
                logger.warn(`[METADATA] Cinemeta also failed (returned null).`);
            }
        } catch (cinemetaError) {
            logger.warn(`[METADATA] Cinemeta fallback error: ${cinemetaError.message}`);
        }
    }

    // TIER 2: Parallel Execution (OMDb + Trakt) - Last Resort
    if (!result && (omdb || trakt)) {
        logger.info(`[METADATA] Tier 1 failed. Attempting Tier 2 (OMDb/Trakt)...`);
        
        const tier2Promises = [];
        if (omdb) tier2Promises.push(fetchOmdb(imdbId));
        if (trakt) tier2Promises.push(fetchTrakt(imdbId, type));

        try {
            result = await Promise.any(tier2Promises);
            logger.info(`[METADATA] Resolved via Tier 2 (${result.source}): "${result.name}"`);
        } catch (aggregateError) {
            logger.error(`[METADATA] All Tier 2 providers failed.`);
        }
    }

    if (result) {
        metaCache.set(cacheKey, result);
        return result;
    }

    logger.error(`[METADATA] CRITICAL: Failed to resolve metadata for ${imdbId} using all available providers.`);
    return null;
}
