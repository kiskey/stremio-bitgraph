/**
 * manifest.js
 * Stremio Addon Manifest Definition
 * Defines the capabilities and metadata of the Stremio addon.
 * All configuration is now managed via server-side environment variables.
 */

module.exports = {
  id: 'com.yourcompany.realdebridaddon', // Unique ID for your addon
  version: '1.0.0',
  name: 'Real-Debrid TV Show Streamer (Env Config)',
  description: 'Streams TV show episodes from Bitmagnet via Real-Debrid with intelligent matching and caching. Configuration is managed via server environment variables only.',
  resources: [
    'stream', // The addon provides streaming links
  ],
  types: ['series'], // The addon provides content for TV series
  idPrefixes: ['tt'], // Integrates with Cinemeta by using IMDb IDs (e.g., 'tt123456')
  behaviorHints: {
    configurable: false, // Set to false as all configuration is now via environment variables
    random: true // Can return random content, though less relevant for specific episode lookups
  },
  catalogs: [],
  // The 'config' array is removed as variables are no longer user-configurable via Stremio UI.
};
