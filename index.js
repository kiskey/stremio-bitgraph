/**
 * index.js
 * Main Stremio Addon Entry Point
 * Initializes the Stremio addon, defines stream handlers, and orchestrates the content delivery.
 */

const { serveHTTP, addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const config = require('./config');
const { initializePg, query: dbQuery } = require('./db'); // Renamed query to dbQuery to avoid conflict
const tmdb = require('./src/tmdb');
const bitmagnet = require('./src/bitmagnet');
const realDebrid = require('./src/realdebrid');
const matcher = require('./src/matcher');
const { logger } = require('./src/utils');
const axios = require('axios'); // Import axios for direct TMDB find call

// Initialize PostgreSQL connection pool on startup
initializePg();

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
    logger.error('Real-Debrid API Key not provided in addon configuration. Cannot provide Real-Debrid streams.');
    // Optionally, you could return a stream indicating the error to the user in Stremio
    return Promise.resolve({
      streams: [{
        name: 'Error',
        description: 'Real-Debrid API Key missing. Please configure the addon.',
        url: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000' // Placeholder to avoid Stremio showing "No streams" blankly
      }]
    });
  }

  const preferredLanguages = addonConfig.preferredLanguages ?
    addonConfig.preferredLanguages.split(',').map(lang => lang.trim().toLowerCase()) :
    ['en'];
  const minSeeders = addonConfig.minSeeders ? parseInt(addonConfig.minSeeders, 10) : config.minSeeders; // Ensure integer
  const levenshteinThreshold = addonConfig.levenshteinThreshold ? parseInt(addonConfig.levenshteinThreshold, 10) : config.levenshteinThreshold; // Ensure integer


  let tmdbShowDetails;
  let tmdbEpisodeDetails;
  let tmdbShowTitle;

  try {
    // 1. Get TMDB show details to find TMDB ID for the IMDb ID
    // Use TMDB's `find` endpoint to convert IMDb ID to TMDB ID.
    logger.debug(`Fetching TMDB show details for IMDb ID: ${imdbId}`);
    const tmdbFindResponse = await axios.get(`${config.tmdb.baseUrl}/find/${imdbId}`, {
      params: {
        external_source: 'imdb_id',
        api_key: config.tmdb.apiKey,
      }
    });
    logger.debug(`TMDB Find API response data: ${JSON.stringify(tmdbFindResponse.data)}`);


    if (tmdbFindResponse.data && tmdbFindResponse.data.tv_results && tmdbFindResponse.data.tv_results.length > 0) {
      tmdbShowDetails = tmdbFindResponse.data.tv_results[0];
      tmdbShowTitle = tmdbShowDetails.name;
      logger.info(`Found TMDB Show: "${tmdbShowTitle}" (TMDB ID: ${tmdbShowDetails.id})`);
    } else {
      logger.error(`Could not find TMDB show details for IMDb ID: ${imdbId}`);
      return Promise.resolve({ streams: [] });
    }

    logger.debug(`Fetching TMDB episode details for TMDB ID: ${tmdbShowDetails.id}, Season: ${seasonNumber}, Episode: ${episodeNumber}`);
    tmdbEpisodeDetails = await tmdb.getTvEpisodeDetails(tmdbShowDetails.id, seasonNumber, episodeNumber);
    logger.debug(`TMDB Episode details: ${JSON.stringify(tmdbEpisodeDetails)}`);

    if (!tmdbEpisodeDetails) {
      logger.error(`Could not retrieve TMDB details for S${seasonNumber}E${episodeNumber} of ${tmdbShowTitle} (TMDB ID: ${tmdbShowDetails.id})`);
      return Promise.resolve({ streams: [] });
    }
  } catch (tmdbError) {
    logger.error(`Error fetching TMDB data: ${tmdbError.message}`, tmdbError); // Log full error object
    return Promise.resolve({ streams: [] });
  }

  // 2. Check local database (cache) for existing torrent
  let cachedTorrent = null;
  try {
    logger.info(`Checking database cache for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}"`);
    const res = await dbQuery(
      `SELECT * FROM torrents
       WHERE tmdb_id = $1 AND season_number = $2 AND episode_number = $3 AND real_debrid_link IS NOT NULL
       ORDER BY added_at DESC
       LIMIT 1`,
      [tmdbShowDetails.id.toString(), seasonNumber, episodeNumber]
    );
    if (res.rows.length > 0) {
      cachedTorrent = res.rows[0];
      // pg driver automatically parses JSONB if column type is JSONB
      // if (typeof cachedTorrent.parsed_info_json === 'string') {
      //     cachedTorrent.parsed_info_json = JSON.parse(cachedTorrent.parsed_info_json);
      // }
    }

    if (cachedTorrent) {
      logger.info(`Found cached stream for S${seasonNumber}E${episodeNumber}: ${cachedTorrent.real_debrid_link}`);
      return Promise.resolve({
        streams: [{
          name: `RD Cached | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
          description: `Cached link from ${new Date(cachedTorrent.added_at).toISOString().split('T')[0]}`,
          url: cachedTorrent.real_debrid_link,
          infoHash: cachedTorrent.infohash,
        }]
      });
    }
    logger.info(`No cached stream found for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}". Searching Bitmagnet...`);

  } catch (dbError) {
    logger.error('Error querying database for cache:', dbError.message, dbError); // Log full error object
    // Continue to search Bitmagnet even if DB lookup fails
  }

  // 3. Search Bitmagnet for torrents
  const bitmagnetSearchQuery = `${tmdbShowTitle} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
  let bitmagnetResults = [];
  try {
    logger.info(`Searching Bitmagnet for query: "${bitmagnetSearchQuery}" with min seeders: ${minSeeders}`);
    bitmagnetResults = await bitmagnet.searchTorrents(bitmagnetSearchQuery, minSeeders);
    logger.info(`Bitmagnet returned ${bitmagnetResults.length} potential torrents for "${bitmagnetSearchQuery}".`);
    logger.debug(`Bitmagnet search results (first 3): ${JSON.stringify(bitmagnetResults.slice(0, 3))}`); // Log a sample
  } catch (bitmagnetError) {
    logger.error(`Error searching Bitmagnet: ${bitmagnetError.message}`, bitmagnetError); // Log full error object
    return Promise.resolve({ streams: [] });
  }

  // 4. Intelligent Torrent Matching
  logger.info('Starting intelligent torrent matching...');
  const scoredTorrents = await matcher.findBestTorrentMatch(
    bitmagnetResults,
    tmdbEpisodeDetails,
    tmdbShowTitle
  );
  logger.info(`Intelligent matching yielded ${scoredTorrents.length} scored torrents.`);
  logger.debug(`Top 3 scored torrents: ${JSON.stringify(scoredTorrents.slice(0, 3))}`);

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
    logger.info(`Adding magnet to Real-Debrid for infohash: ${selectedTorrent.infoHash}`);
    const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrent.magnetLink);
    logger.debug(`Real-Debrid add magnet response: ${JSON.stringify(rdAddedTorrent)}`);

    if (!rdAddedTorrent) {
      logger.error('Failed to add magnet to Real-Debrid.');
      return Promise.resolve({ streams: [] });
    }

    let fileToSelect = 'all'; // Default to 'all' if no specific file index found (e.g., single episode torrent)
    if (matchedFileIndex !== null && matchedFileIndex !== undefined) {
      fileToSelect = matchedFileIndex.toString();
      logger.info(`Explicitly selecting file index ${fileToSelect} on Real-Debrid.`);
    } else if (rdAddedTorrent.id) {
        logger.info(`No specific file index pre-matched. Fetching torrent info from Real-Debrid to re-evaluate files for ${rdAddedTorrent.id}.`);
        // If it's a pack and matchedFileIndex is null, we need to get torrent info to find files
        // This is a fallback if the initial Bitmagnet search didn't give comprehensive file info
        const torrentInfoAfterAdd = await realDebrid.getTorrentInfo(realDebridApiKey, rdAddedTorrent.id);
        logger.debug(`Real-Debrid torrent info after add: ${JSON.stringify(torrentInfoAfterAdd)}`);

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


    logger.info(`Calling selectFiles on Real-Debrid for torrent ${rdAddedTorrent.id}, files: ${fileToSelect}`);
    const rdSelectFilesResult = await realDebrid.selectFiles(realDebridApiKey, rdAddedTorrent.id, fileToSelect);
    logger.debug(`Real-Debrid select files response: ${JSON.stringify(rdSelectFilesResult)}`);

    if (!rdSelectFilesResult) {
      logger.error('Failed to select files on Real-Debrid.');
      return Promise.resolve({ streams: [] });
    }

    logger.info(`Polling Real-Debrid for torrent completion for ${rdAddedTorrent.id}...`);
    const completedTorrentInfo = await realDebrid.pollForTorrentCompletion(realDebridApiKey, rdAddedTorrent.id);

    if (!completedTorrentInfo || !completedTorrentInfo.links || completedTorrentInfo.links.length === 0) {
      logger.error('Torrent did not complete or no links available on Real-Debrid.');
      return Promise.resolve({ streams: [] });
    }

    // Get the direct streaming link (usually the first link for a selected file/torrent)
    const rawRealDebridLink = completedTorrentInfo.links[0];
    logger.info(`Unrestricting Real-Debrid link: ${rawRealDebridLink.substring(0, 50)}...`);
    realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);
    logger.debug(`Real-Debrid unrestrict link response (direct link): ${realDebridDirectLink}`);

    if (!realDebridDirectLink) {
      logger.error('Failed to unrestrict Real-Debrid link.');
      return Promise.resolve({ streams: [] });
    }

    logger.info(`Successfully obtained direct Real-Debrid link for S${seasonNumber}E${episodeNumber}: ${realDebridDirectLink}`);

    // 6. Persist torrent info to database
    try {
      const parsedInfoJsonString = JSON.stringify(selectedTorrent.parsed || {});
      const tmdbIdStr = tmdbShowDetails.id.toString();

      // Check if infohash already exists to decide between INSERT and UPDATE
      const existingTorrent = await dbQuery(
          `SELECT id FROM torrents WHERE infohash = $1`,
          [selectedTorrent.infoHash]
      );

      if (existingTorrent.rows.length > 0) {
          // Update existing record
          await dbQuery(
              `UPDATE torrents
               SET tmdb_id = $1, season_number = $2, episode_number = $3, torrent_name = $4,
                   parsed_info_json = $5, real_debrid_torrent_id = $6, real_debrid_file_id = $7,
                   real_debrid_link = $8, last_checked_at = NOW(), language_preference = $9, seeders = $10
               WHERE infohash = $11`,
              [
                  tmdbIdStr, seasonNumber, episodeNumber, selectedTorrent.name,
                  parsedInfoJsonString, rdAddedTorrent.id, fileToSelect,
                  realDebridDirectLink, preferredLanguages[0] || 'en', selectedTorrent.seeders || 0,
                  selectedTorrent.infoHash
              ]
          );
          logger.info('Existing torrent record updated successfully.');
      } else {
          // Insert new record
          await dbQuery(
              `INSERT INTO torrents (
                   infohash, tmdb_id, season_number, episode_number, torrent_name,
                   parsed_info_json, real_debrid_torrent_id, real_debrid_file_id,
                   real_debrid_link, language_preference, seeders
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                  selectedTorrent.infoHash, tmdbIdStr, seasonNumber, episodeNumber, selectedTorrent.name,
                  parsedInfoJsonString, rdAddedTorrent.id, fileToSelect,
                  realDebridDirectLink, preferredLanguages[0] || 'en', selectedTorrent.seeders || 0
              ]
          );
          logger.info('Torrent information persisted to database.');
      }
    } catch (dbPersistError) {
      logger.error('Error persisting torrent to database:', dbPersistError.message, dbPersistError); // Log full error
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
    logger.error('An unhandled error occurred in stream handler:', globalError.message, globalError.stack, globalError); // Log full error
    return Promise.resolve({ streams: [] });
  }
});

// Serve the addon
serveHTTP(builder.getInterface(), { port: config.port });
logger.info(`Stremio Real-Debrid Addon listening on port ${config.port}`);
