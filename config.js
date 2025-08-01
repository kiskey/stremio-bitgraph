import dotenv from 'dotenv';
dotenv.config();

// Server and Addon Configuration
export const PORT = parseInt(process.env.PORT) || 7000;
export const API_PORT = PORT + 1;
export const APP_HOST = process.env.APP_HOST || `http://127.0.0.1:${API_PORT}`;
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const ADDON_ID = 'org.stremio.realdebrid.bitmagnet';
export const ADDON_NAME = 'Bitmagnet RD';
export const ADDON_VERSION = '3.0.0'; // Major version for movie support

// Service API Keys and Endpoints
export const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const BITMAGNET_GRAPHQL_ENDPOINT = process.env.BITMAGNET_GRAPHQL_ENDPOINT;
export const DATABASE_URL = process.env.DATABASE_URL;

// User Preferences
const langs = process.env.PREFERRED_LANGUAGES;
export const PREFERRED_LANGUAGES = langs ? langs.split(',').map(l => l.trim()) : [];
export const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD) || 0.75;
// NEW: Optional strict language filtering
export const STRICT_LANGUAGE_FILTER = process.env.STRICT_LANGUAGE_FILTER === 'true';
// The number of streams to return for each language/quality combination.
export const STREAM_LIMIT_PER_QUALITY = parseInt(process.env.STREAM_LIMIT_PER_QUALITY) || 2;

// Critical validation
if (!REALDEBRID_API_KEY || !TMDB_API_KEY || !BITMAGNET_GRAPHQL_ENDPOINT || !DATABASE_URL) {
    const missing = [
        !REALDEBRID_API_KEY && 'REALDEBRID_API_KEY',
        !TMDB_API_KEY && 'TMDB_API_KEY',
        !BITMAGNET_GRAPHQL_ENDPOINT && 'BITMAGNET_GRAPHQL_ENDPOINT',
        !DATABASE_URL && 'DATABASE_URL'
    ].filter(Boolean).join(', ');
    throw new Error(`Missing critical environment variables: ${missing}. Check your .env file.`);
}
