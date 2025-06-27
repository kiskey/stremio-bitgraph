/**
 * index.js
 * Main Stremio Addon Entry Point
 * Initializes the Stremio addon, defines stream handlers, and orchestrates the content delivery.
 */

const { serveHTTP, get };
const addonBuilder = require('@stremio/addon-sdk');
const manifest = require('./manifest');
const config = require('./config');
const { initializePrisma, getPrismaClient } = require('./db');
const tmdb = require('./src/tmdb');
const bitmagnet = require('./src/bitmagnet');
const realDebrid = require('./src/realdebrid');
const matcher = require('./src/matcher');
const { logger } = require('./src/utils');

// Initialize Prisma Client on startup
initializePrisma();
const prisma = getPrismaClient();

// Create the addon builder
const builder = new addonBuilder(manifest);

// --- Stream Handler ---
builder.defineStreamHandler(async ({ type, id, config: addonConfig }) => {
  logger.info(`Stream request for type: ${type}, id: ${id}, config: ${JSON.stringify(addonConfig)}`);

  if (type !== 'series') {
    logger.debug('Ignoring non-series request.');
    return Promise.resolve({ streams: [] });
  }

  // Parse Stremio ID (e.g., 'tt123456:1:1' -> IMDb ID, Season, Episode)
  const [imdbId, seasonNumberStr, episodeNumberStr] = id.split(':');
  const seasonNumber = parseInt(seasonNumberStr, 10);
  const episodeNumber = parseInt(episodeNumberStr, 10);

  if (!imdbId || isNaN(seasonNumber) || isNaN(episodeNumber)) {
    logger.error(`Invalid Stremio ID format: ${id}`);
    return Promise.resolve({ streams: [] });
  }

  const realDebridApiKey = addonConfig.realDebridApiKey;
  if (!realDebridApiKey) {
    logger.error('Real-Debrid API Key not provided in addon configuration.');
    return Promise.resolve({ streams: [] });
  }

  const preferredLanguages = addonConfig.preferredLanguages ?
    addonConfig.preferredLanguages.split(',').map(lang => lang.trim().toLowerCase()) :
    ['en'];
  const minSeeders = addonConfig.minSeeders || config.minSeeders || 5; // Default to 5
  const levenshteinThreshold = addonConfig.levenshteinThreshold || config.levenshteinThreshold || 7;


  let tmdbShowDetails;
  let tmdbEpisodeDetails;
  let tmdbShowTitle;

  try {
    // 1. Get TMDB show details to find TMDB ID for the IMDb ID
    // Stremio's IMDb ID needs to be mapped to TMDB ID for TMDB API calls
    // A simple direct lookup for TMDB show details using a search is often needed first
    // Or, if using a pre-indexed mapping (not implemented here), it would be faster.
    // For now, we'll assume a direct lookup if IMDb maps to a TMDB show.
    // In a real scenario, you'd likely fetch this from a mapping service or a cached entry.
    // For simplicity, we'll try to get show details and then iterate seasons/episodes
    // The provided research mentions TMDB /tv/{series_id}, but Stremio provides IMDb ID.
    // We need to convert IMDb to TMDB. This often requires a separate search endpoint or a mapping DB.
    // For now, let's assume `getTvShowDetails` can take IMDb and map internally, or use a cached mapping.
    // If not, a TMDB search by IMDb ID is needed first: `GET /3/find/{external_id}` with `external_source=imdb_id`
    // For this example, let's simplify and use TMDB's `external_ids` or assume direct TMDB ID is implied by how Stremio sends it.
    // The spec says `idPrefixes: ['tt']` means Stremio sends IMDb IDs. So we need to use TMDB's find endpoint.

    const tmdbFindResponse = await tmdb.get(`https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${config.tmdb.apiKey}`);
    if (tmdbFindResponse && tmdbFindResponse.tv_results && tmdbFindResponse.tv_results.length > 0) {
      tmdbShowDetails = tmdbFindResponse.tv_results[0];
      tmdbShowTitle = tmdbShowDetails.name;
    } else {
      logger.error(`Could not find TMDB show details for IMDb ID: ${imdbId}`);
      return Promise.resolve({ streams: [] });
    }

    tmdbEpisodeDetails = await tmdb.getTvEpisodeDetails(tmdbShowDetails.id, seasonNumber, episodeNumber);

    if (!tmdbEpisodeDetails) {
      logger.error(`Could not retrieve TMDB details for S${seasonNumber}E${episodeNumber} of ${tmdbShowTitle} (TMDB ID: ${tmdbShowDetails.id})`);
      return Promise.resolve({ streams: [] });
    }
  } catch (tmdbError) {
    logger.error(`Error fetching TMDB data: ${tmdbError.message}`);
    return Promise.resolve({ streams: [] });
  }

  // 2. Check local database (cache) for existing torrent
  try {
    const cachedTorrent = await prisma.torrent.findFirst({
      where: {
        tmdbId: tmdbShowDetails.id.toString(),
        seasonNumber: seasonNumber,
        episodeNumber: episodeNumber,
        realDebridLink: { not: null }, // Ensure we have a valid link
        // Optional: Filter by languagePreference if stored and preferred
        // languagePreference: { in: preferredLanguages }
      },
      orderBy: {
        addedAt: 'desc', // Get the most recently added valid link
      },
    });

    if (cachedTorrent) {
      logger.info(`Found cached stream for S${seasonNumber}E${episodeNumber}: ${cachedTorrent.realDebridLink}`);
      // Re-check Real-Debrid link status (optional but good for freshness)
      // For simplicity, we directly return. A more robust solution might check link validity.
      return Promise.resolve({
        streams: [{
          name: `RD Cached | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
          description: `Cached link from ${cachedTorrent.addedAt.toISOString().split('T')[0]}`,
          url: cachedTorrent.realDebridLink,
          infoHash: cachedTorrent.infohash, // Stremio can use infoHash for some features
        }]
      });
    }
    logger.info(`No cached stream found for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}". Searching Bitmagnet...`);

  } catch (dbError) {
    logger.error('Error querying database:', dbError.message);
    // Continue to search Bitmagnet even if DB lookup fails
  }

  // 3. Search Bitmagnet for torrents
  const bitmagnetSearchQuery = `${tmdbShowTitle} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
  let bitmagnetResults = [];
  try {
    bitmagnetResults = await bitmagnet.searchTorrents(bitmagnetSearchQuery, minSeeders);
    logger.info(`Bitmagnet returned ${bitmagnetResults.length} potential torrents for "${bitmagnetSearchQuery}".`);
  } catch (bitmagnetError) {
    logger.error(`Error searching Bitmagnet: ${bitmagnetError.message}`);
    return Promise.resolve({ streams: [] });
  }

  // 4. Intelligent Torrent Matching
  const scoredTorrents = await matcher.findBestTorrentMatch(
    bitmagnetResults,
    tmdbEpisodeDetails,
    tmdbShowTitle,
    // No pre-fetched files here, matcher will get them if needed
    // You might want to pass all files from `torrent.files` if Bitmagnet's search query returns them directly
  );

  const bestMatchedTorrent = scoredTorrents[0];

  if (!bestMatchedTorrent || bestMatchedTorrent.score <= -Infinity) {
    logger.warn(`No suitable torrent found after intelligent matching for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}".`);
    return Promise.resolve({ streams: [] });
  }

  const { torrent: selectedTorrent, matchedFileIndex, matchedFilePath } = bestMatchedTorrent;
  logger.info(`Selected best torrent: "${selectedTorrent.name}" (Score: ${bestMatchedTorrent.score})`);
  logger.info(`Matched file index: ${matchedFileIndex}, path: ${matchedFilePath}`);

  // 5. Add torrent to Real-Debrid and get direct link
  let realDebridDirectLink = null;
  try {
    const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrent.magnetLink);

    if (!rdAddedTorrent) {
      logger.error('Failed to add magnet to Real-Debrid.');
      return Promise.resolve({ streams: [] });
    }

    let fileToSelect = 'all'; // Default to 'all' if no specific file index found (e.g., single episode torrent)
    if (matchedFileIndex !== null && matchedFileIndex !== undefined) {
      fileToSelect = matchedFileIndex.toString();
    } else if (rdAddedTorrent.id) {
        // If it's a pack and matchedFileIndex is null, we need to get torrent info to find files
        // This is a fallback if the initial Bitmagnet search didn't give comprehensive file info
        const torrentInfoAfterAdd = await realDebrid.getTorrentInfo(realDebridApiKey, rdAddedTorrent.id);
        if (torrentInfoAfterAdd && torrentInfoAfterAdd.files && torrentInfoAfterAdd.files.length > 0) {
            // Re-match against these files if a specific index wasn't found before
            const filesFromRD = torrentInfoAfterAdd.files.map((file, index) => ({
                path: file.path,
                size: file.bytes,
                index: index, // Real-Debrid file indices are 0-based
            }));
            const reScoredFiles = await matcher.findBestTorrentMatch(
                [{ ...selectedTorrent, files: filesFromRD }], // Re-wrap to fit expected input
                tmdbEpisodeDetails,
                tmdbShowTitle
            );
            if (reScoredFiles[0] && reScoredFiles[0].matchedFileIndex !== null && reScoredFiles[0].matchedFileIndex !== undefined) {
                fileToSelect = reScoredFiles[0].matchedFileIndex.toString();
                logger.info(`Refined file selection for torrent ${rdAddedTorrent.id}: index ${fileToSelect}`);
            } else {
                logger.warn(`Could not find specific file index in Real-Debrid files after re-matching for ${rdAddedTorrent.id}. Defaulting to 'all'.`);
                // If it's a single file torrent by nature, 'all' is fine.
                // If it's a pack and we couldn't find a file, this might lead to issues.
            }
        }
    }


    const rdSelectFilesResult = await realDebrid.selectFiles(realDebridApiKey, rdAddedTorrent.id, fileToSelect);

    if (!rdSelectFilesResult) {
      logger.error('Failed to select files on Real-Debrid.');
      return Promise.resolve({ streams: [] });
    }

    // Poll for torrent completion
    const completedTorrentInfo = await realDebrid.pollForTorrentCompletion(realDebridApiKey, rdAddedTorrent.id);

    if (!completedTorrentInfo || !completedTorrentInfo.links || completedTorrentInfo.links.length === 0) {
      logger.error('Torrent did not complete or no links available on Real-Debrid.');
      return Promise.resolve({ streams: [] });
    }

    // Get the direct streaming link (usually the first link for a selected file/torrent)
    const rawRealDebridLink = completedTorrentInfo.links[0];
    realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);

    if (!realDebridDirectLink) {
      logger.error('Failed to unrestrict Real-Debrid link.');
      return Promise.resolve({ streams: [] });
    }

    logger.info(`Successfully obtained direct Real-Debrid link for S${seasonNumber}E${episodeNumber}: ${realDebridDirectLink}`);

    // 6. Persist torrent info to database
    try {
      await prisma.torrent.create({
        data: {
          infohash: selectedTorrent.infoHash,
          tmdbId: tmdbShowDetails.id.toString(),
          seasonNumber: seasonNumber,
          episodeNumber: episodeNumber,
          torrentName: selectedTorrent.name,
          parsedInfoJson: selectedTorrent.parsed || {}, // Store the parsed info
          realDebridTorrentId: rdAddedTorrent.id,
          realDebridFileId: fileToSelect, // Store the index of the selected file
          realDebridLink: realDebridDirectLink,
          addedAt: new Date(),
          lastCheckedAt: new Date(),
          languagePreference: preferredLanguages[0] || 'en', // Store first preferred language
          seeders: selectedTorrent.seeders || 0,
        },
      });
      logger.info('Torrent information persisted to database.');
    } catch (dbPersistError) {
      // Log error but don't prevent streaming, as it's a caching issue
      logger.error('Error persisting torrent to database:', dbPersistError.message);
      // If it's a unique constraint violation (e.g., infohash already exists), you might want to update instead
      if (dbPersistError.code === 'P2002') { // Unique constraint violation code for Prisma
          logger.warn('Torrent infohash already exists. Attempting to update existing record.');
          try {
              await prisma.torrent.update({
                  where: { infohash: selectedTorrent.infoHash },
                  data: {
                      tmdbId: tmdbShowDetails.id.toString(),
                      seasonNumber: seasonNumber,
                      episodeNumber: episodeNumber,
                      torrentName: selectedTorrent.name,
                      parsedInfoJson: selectedTorrent.parsed || {},
                      realDebridTorrentId: rdAddedTorrent.id,
                      realDebridFileId: fileToSelect,
                      realDebridLink: realDebridDirectLink,
                      lastCheckedAt: new Date(),
                      languagePreference: preferredLanguages[0] || 'en',
                      seeders: selectedTorrent.seeders || 0,
                  }
              });
              logger.info('Existing torrent record updated successfully.');
          } catch (updateError) {
              logger.error('Failed to update existing torrent record:', updateError.message);
          }
      }
    }

    return Promise.resolve({
      streams: [{
        name: `RD | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
        description: `Stream via Real-Debrid`,
        url: realDebridDirectLink,
        infoHash: selectedTorrent.infoHash, // Stremio can use infoHash for some features
        // Optional: add other properties like subtitles, thumbnail, etc.
      }]
    });

  } catch (globalError) {
    logger.error('An unhandled error occurred in stream handler:', globalError.message, globalError.stack);
    return Promise.resolve({ streams: [] });
  }
});

// Serve the addon
serveHTTP(builder.get = () => builder);
logger.info(`Stremio Real-Debrid Addon listening on port ${config.port}`);
