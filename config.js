import dotenv from 'dotenv';
dotenv.config();

// Server and Addon Configuration
export const PORT = parseInt(process.env.PORT) || 7000;
export const API_PORT = PORT + 1; // Internal port for the API server
export const APP_HOST = process.env.APP_HOST || `http://127.0.0.1:${API_PORT}`;
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // 'debug', 'info', 'warn', 'error'

export const ADDON_ID = 'org.stremio.realdebrid.bitmagnet';
export const ADDON_NAME = 'Bitmagnet RD (Env)';
export const ADDON_VERSION = '1.3.0'; // Version bump for new features

// Service API Keys and Endpoints
export const REALDEBRID_API_KEY = process.env.REALDEBRID_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const BITMAGNET_GRAPHQL_ENDPOINT = process.env.BITMAGNET_GRAPHQL_ENDPOINT;
export const DATABASE_URL = process.env.DATABASE_URL;

// User Preferences
export const PREFERRED_LANGUAGES = (process.env.PREFERRED_LANGUAGES || 'en').split(',').map(l => l.trim());
export const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD) || 0.75;

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
