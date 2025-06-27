/**
 * manifest.js
 * Stremio Addon Manifest Definition
 * Defines the capabilities and metadata of the Stremio addon.
 */

module.exports = {
  id: 'com.yourcompany.realdebridaddon', // Unique ID for your addon
  version: '1.0.0',
  name: 'Real-Debrid TV Show Streamer',
  description: 'Streams TV show episodes from Bitmagnet via Real-Debrid with intelligent matching and caching.',
  resources: [
    'stream', // The addon provides streaming links
    // 'meta', // Can be enabled if you want to provide custom metadata, but Cinemeta is usually sufficient for 'tt' IDs
  ],
  types: ['series'], // The addon provides content for TV series
  idPrefixes: ['tt'], // Integrates with Cinemeta by using IMDb IDs (e.g., 'tt123456')
  behaviorHints: {
    configurable: true, // Indicates that the addon has configurable settings
    random: true // Can return random content, though less relevant for specific episode lookups
  },
  // Configuration options for the addon, presented to the user during installation
  config: [
    {
      key: 'realDebridApiKey',
      type: 'text',
      title: 'Real-Debrid API Key',
      required: true,
      placeholder: 'Your Real-Debrid API Token (e.g., obtained from https://real-debrid.com/apitoken)',
    },
    {
      key: 'preferredLanguages',
      type: 'text',
      title: 'Preferred Languages (comma-separated)',
      required: false,
      placeholder: 'e.g., en,fr,es (for English, French, Spanish)',
      default: 'en',
    },
    {
      key: 'minSeeders',
      type: 'number',
      title: 'Minimum Seeders',
      required: false,
      placeholder: 'e.g., 5 (Only consider torrents with at least this many seeders)',
      default: 5,
    },
    {
      key: 'tmdbApiKey',
      type: 'text',
      title: 'TMDB API Key',
      required: true,
      placeholder: 'Your TMDB API Key (e.g., from https://www.themoviedb.org/documentation/api)',
    },
    {
      key: 'bitmagnetGraphQLEndpoint',
      type: 'text',
      title: 'Bitmagnet GraphQL Endpoint',
      required: true,
      placeholder: 'Your self-hosted Bitmagnet GraphQL endpoint (e.g., http://localhost:4000/graphql)',
    },
    {
      key: 'levenshteinThreshold',
      type: 'number',
      title: 'Levenshtein Distance Threshold',
      required: false,
      placeholder: 'Max Levenshtein distance for fuzzy matching (e.g., 7)',
      default: 7,
    },
  ],
};
