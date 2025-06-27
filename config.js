/**
 * config.js
 * Application Configuration
 * Loads environment variables and provides configuration settings for the addon.
 */

require('dotenv').config(); // Load environment variables from .env file

module.exports = {
  port: process.env.PORT || 7000,
  appHost: process.env.APP_HOST, // CRITICAL FIX: Add appHost from environment variable
  logLevel: process.env.LOG_LEVEL || 'info',
  minSeeders: parseInt(process.env.MIN_SEEDERS || '5', 10),
  levenshteinThreshold: parseInt(process.env.LEVENSHTEIN_THRESHOLD || '7', 10),

  tmdb: {
    apiKey: process.env.TMDB_API_KEY,
    baseUrl: 'https://api.themoviedb.org/3',
  },

  bitmagnet: {
    graphqlEndpoint: process.env.BITMAGNET_GRAPHQL_ENDPOINT,
    retry: {
      maxAttempts: 5,
      initialDelayMs: 1000, // 1 second
      maxDelayMs: 16000, // 16 seconds
    },
  },

  realDebrid: {
    baseUrl: 'https://api.real-debrid.com/rest/1.0',
    clientId: process.env.REALDEBRID_CLIENT_ID, // Currently not used for token exchange, but kept for future OAuth
    clientSecret: process.env.REALDEBRID_CLIENT_SECRET, // Currently not used for token exchange
    // The user's access token is passed dynamically via Stremio addon config
    retry: {
      maxAttempts: 5,
      initialDelayMs: 2000, // 2 seconds
      maxDelayMs: 32000, // 32 seconds
    },
  },

  database: {
    url: process.env.DATABASE_URL,
  },
};
