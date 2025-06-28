import dotenv from 'dotenv';
dotenv.config();

export const PORT = process.env.PORT || 7000;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const BITMAGNET_GRAPHQL_ENDPOINT = process.env.BITMAGNET_GRAPHQL_ENDPOINT;
export const DATABASE_URL = process.env.DATABASE_URL;
export const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD) || 0.75;
export const ADDON_ID = 'org.stremio.realdebrid.bitmagnet';
export const ADDON_NAME = 'Bitmagnet RD';
export const ADDON_VERSION = '1.0.0';

// Basic validation
if (!TMDB_API_KEY || !BITMAGNET_GRAPHQL_ENDPOINT || !DATABASE_URL) {
    throw new Error('Missing critical environment variables. Check your .env file.');
}
