/**
 * config.js
 * Server-side Configuration for the Stremio Addon.
 * Loads ALL configuration variables from environment variables.
 */

require('dotenv').config(); // Loads environment variables from .env file

module.exports = {
  // Server port for the addon
  port: parseInt(process.env.PORT || '7000', 10),

  // The public facing host of your addon (e.g., https://youraddon.example.com)
  // CRITICAL: Must be set to the external URL Stremio will use to access your addon.
  appHost: process.env.APP_HOST,

  // PostgreSQL Database connection URL
  database: {
    url: process.env.DATABASE_URL, // e.g., "postgresql://user:password@host:port/database"
  },

  // Real-Debrid API Key - NOW FROM ENVIRONMENT VARIABLE ONLY
  realDebridApiKey: process.env.REAL_DEBRID_API_KEY,

  // Preferred Languages - NOW FROM ENVIRONMENT VARIABLE ONLY
  // Expected format: "en,fr,es"
  preferredLanguages: process.env.PREFERRED_LANGUAGES ?
    process.env.PREFERRED_LANGUAGES.split(',').map(lang => lang.trim().toLowerCase()) :
    ['en'], // Default to English if not set

  // TMDB API configuration for the addon's internal direct calls
  tmdb: {
    baseUrl: 'https://api.themoviedb.org/3',
    // This is YOUR server's TMDB API key, NOW FROM ENVIRONMENT VARIABLE ONLY
    apiKey: process.env.TMDB_API_KEY,
  },

  // Bitmagnet GraphQL Endpoint - NOW FROM ENVIRONMENT VARIABLE ONLY
  bitmagnet: {
    graphqlEndpoint: process.env.BITMAGNET_GRAPHQL_ENDPOINT || 'http://bitmagnet:3333/graphql',
  },

  // Minimum seeders for torrent search - NOW FROM ENVIRONMENT VARIABLE ONLY
  minSeeders: parseInt(process.env.MIN_SEEDERS || '5', 10),

  // Levenshtein distance threshold for fuzzy matching - NOW FROM ENVIRONMENT VARIABLE ONLY
  levenshteinThreshold: parseInt(process.env.LEVENSHTEIN_THRESHOLD || '7', 10),

  // Real-Debrid API URL (static)
  realDebrid: {
    baseUrl: 'https://api.real-debrid.com/rest/1.0',
    // Retry configuration for Real-Debrid API calls
    retry: {
      maxAttempts: parseInt(process.env.RD_RETRY_MAX_ATTEMPTS || '5', 10),
      initialDelayMs: parseInt(process.env.RD_RETRY_INITIAL_DELAY_MS || '2000', 10), // 2 seconds
      maxDelayMs: parseInt(process.env.RD_RETRY_MAX_DELAY_MS || '32000', 10), // 32 seconds
    },
  },

  // General retry configurations for other utilities (e.g., Bitmagnet, TMDB)
  retry: {
    maxRetries: parseInt(process.env.RETRY_MAX_RETRIES || '3', 10),
    initialDelay: parseInt(process.env.RETRY_INITIAL_DELAY_MS || '1000', 10), // in milliseconds
  },

  // Logging level (e.g., 'info', 'debug', 'warn', 'error')
  logLevel: process.env.LOG_LEVEL || 'info',
};
