/**
 * config.js
 * Environment Variables and Configuration Management
 * Loads environment variables and provides centralized access to application settings.
 */

require('dotenv').config(); // Load environment variables from .env file

const config = {
  // Application Port
  port: process.env.PORT || 7000,

  // TMDB API Configuration
  tmdb: {
    apiKey: process.env.TMDB_API_KEY, // Set via environment variable
    baseUrl: 'https://api.themoviedb.org/3',
  },

  // Real-Debrid API Configuration
  realDebrid: {
    // client_id and client_secret are typically for OAuth flows.
    // For this addon, the user's API token is provided directly via Stremio config.
    // These are placeholders if you ever expand to a full OAuth implementation.
    clientId: process.env.REALDEBRID_CLIENT_ID || 'YOUR_REALDEBRID_CLIENT_ID',
    clientSecret: process.env.REALDEBRID_CLIENT_SECRET || 'YOUR_REALDEBRID_CLIENT_SECRET',
    baseUrl: 'https://api.real-debrid.com/api/v2',
    // Rate limit: 250 requests per minute
    rateLimitDelayMs: 240, // Approximately 250 requests per minute (60000ms / 250 = 240ms)
    // Retry strategy for Real-Debrid API calls
    retry: {
      maxAttempts: 5,
      initialDelayMs: 1000, // 1 second
      maxDelayMs: 16000,    // 16 seconds (2^4 * 1s)
    }
  },

  // Bitmagnet GraphQL Endpoint
  bitmagnet: {
    graphqlEndpoint: process.env.BITMAGNET_GRAPHQL_ENDPOINT || 'http://localhost:4000/graphql',
    // Retry strategy for Bitmagnet API calls
    retry: {
      maxAttempts: 3,
      initialDelayMs: 500, // 0.5 seconds
      maxDelayMs: 4000,    // 4 seconds (2^3 * 0.5s)
    }
  },

  // Database Configuration (for Prisma)
  database: {
    url: process.env.DATABASE_URL,
  },

  // Intelligent Matching Configuration
  // Default Levenshtein distance threshold (can be overridden by addon config)
  levenshteinThreshold: process.env.LEVENSHTEIN_THRESHOLD ? parseInt(process.env.LEVENSHTEIN_THRESHOLD) : 7,

  // Logging level (e.g., 'info', 'debug', 'error')
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Validate essential environment variables
if (!config.tmdb.apiKey) {
  console.warn('WARNING: TMDB_API_KEY is not set. TMDB functionality will be limited.');
}
if (!config.bitmagnet.graphqlEndpoint || config.bitmagnet.graphqlEndpoint === 'YOUR_BITMAGNET_GRAPHQL_ENDPOINT') {
  console.warn('WARNING: BITMAGNET_GRAPHQL_ENDPOINT is not set or is default. Bitmagnet functionality will not work.');
}
if (!config.database.url || config.database.url.includes('user:password')) {
  console.warn('WARNING: DATABASE_URL is not set or is default. Database persistence will not work.');
}

module.exports = config;
