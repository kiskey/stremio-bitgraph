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

// Optional Fallback API Keys (Tier 2)
export const OMDB_API_KEY = process.env.OMDB_API_KEY; // Optional
export const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID; // Optional

// User Preferences
const langs = process.env.PREFERRED_LANGUAGES;
export const PREFERRED_LANGUAGES = langs ? langs.split(',').map(l => l.trim()) : [];
export const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD) || 0.75;
export const STRICT_LANGUAGE_FILTER = process.env.STRICT_LANGUAGE_FILTER === 'true';
export const STREAM_LIMIT_PER_QUALITY = parseInt(process.env.STREAM_LIMIT_PER_QUALITY) || 2;

// ================== NEW: Modular Debrid Configuration ==================
export const DEBRID_SERVICE = (process.env.DEBRID_SERVICE || '').toLowerCase() || null;

export const TORBOX_API_KEY = process.env.TORBOX_API_KEY || null;
export const TORBOX_ENABLED = !!TORBOX_API_KEY;
export const TORBOX_MAX_ACTIVE_TORRENTS = parseInt(process.env.TORBOX_MAX_ACTIVE_TORRENTS) || 0;

export const REALDEBRID_ENABLED = !!REALDEBRID_API_KEY;

// Auto‑detect debrid service if not explicitly set
export let debridService = DEBRID_SERVICE;
if (!debridService) {
  if (REALDEBRID_ENABLED) debridService = 'realdebrid';
  else if (TORBOX_ENABLED) debridService = 'torbox';
}
// Cache table name (for generic debrid mapping)
export const DEBRID_CACHE_TABLE = process.env.DEBRID_CACHE_TABLE || 'debrid_cache';

// ================== Validation (modified) ==================
// We still need TMDB, Bitmagnet and DB, but the debrid key is mandatory only if
// no debrid service is set. (If neither RD nor TorBox is provided, the addon
// will still work in pure P2P mode.)
const missing = [];
if (!TMDB_API_KEY) missing.push('TMDB_API_KEY');
if (!BITMAGNET_GRAPHQL_ENDPOINT) missing.push('BITMAGNET_GRAPHQL_ENDPOINT');
if (!DATABASE_URL) missing.push('DATABASE_URL');

// Warn if a debrid service is selected but the corresponding key is missing
if (debridService === 'realdebrid' && !REALDEBRID_API_KEY) {
  console.warn('DEBRID_SERVICE set to realdebrid but REALDEBRID_API_KEY is missing. Falling back to P2P only.');
}
if (debridService === 'torbox' && !TORBOX_API_KEY) {
  console.warn('DEBRID_SERVICE set to torbox but TORBOX_API_KEY is missing. Falling back to P2P only.');
}

if (missing.length) {
  throw new Error(`Missing critical environment variables: ${missing.join(', ')}. Check your .env file.`);
}
