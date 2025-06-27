/**
 * index.js
 * Main Stremio Addon Entry Point
 * Initializes the Stremio addon, defines stream handlers, and orchestrates the content delivery.
 */

const { serveHTTP, addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const config = require('./config');
const { initializePg, query: dbQuery } = require('./db');
const tmdb = require('./src/tmdb');
const bitmagnet = require('./src/bitmagnet');
const matcher = require('./src/matcher');
const { logger } = require('./src/utils');
const realDebrid = require('./src/realdebrid'); // Ensure realDebrid is imported
const axios = require('axios');

// Initialize PostgreSQL connection pool on startup
initializePg();

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id, config: addonConfig }) => {
  logger.info(`Stream request for type: ${type}, id: ${id}, config: ${JSON.stringify(addonConfig)}`);

  if (type !== 'series') {
    logger.debug('Ignoring non-series request.');
    return Promise.resolve({ streams: [] });
  }

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
    return Promise.resolve({
      streams: [{
        name: 'Error',
        description: 'Real-Debrid API Key missing. Please configure the addon.',
        url: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000000'
      }]
    });
  }

  const preferredLanguages = addonConfig.preferredLanguages ?
    addonConfig.preferredLanguages.split(',').map(lang => lang.trim().toLowerCase()) :
    ['en'];
  const minSeeders = addonConfig.minSeeders ? parseInt(addonConfig.minSeeders, 10) : config.minSeeders;
  const levenshteinThreshold = addonConfig.levenshteinThreshold ? parseInt(addonConfig.levenshteinThreshold, 10) : config.levenshteinThreshold;

  let tmdbShowDetails;
  let tmdbEpisodeDetails;
  let tmdbShowTitle;

  try {
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
    logger.error(`Error fetching TMDB data: ${tmdbError.message}`, tmdbError);
    return Promise.resolve({ streams: [] });
  }

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
    logger.error('Error querying database for cache:', dbError.message, dbError);
    // Continue to search Bitmagnet even if DB lookup fails
  }

  const bitmagnetSearchQuery = `${tmdbShowTitle} S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
  let bitmagnetResults = [];
  try {
    bitmagnetResults = await bitmagnet.searchTorrents(bitmagnetSearchQuery, minSeeders);
  } catch (bitmagnetError) {
    logger.error(`Error searching Bitmagnet: ${bitmagnetError.message}`, bitmagnetError);
    return Promise.resolve({ streams: [] });
  }

  // Pass preferredLanguages to findBestTorrentMatch for app-side language scoring
  const scoredTorrents = await matcher.findBestTorrentMatch(
    bitmagnetResults,
    tmdbEpisodeDetails,
    tmdbShowTitle,
    preferredLanguages // Pass preferredLanguages here
  );

  const bestMatchedTorrent = scoredTorrents[0];

  if (!bestMatchedTorrent || bestMatchedTorrent.score <= -Infinity) {
    logger.warn(`No suitable torrent found after intelligent matching for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}".`);
    return Promise.resolve({ streams: [] });
  }

  // CRITICAL FIX: Access the actual torrent name for logging from the nested torrent object
  const selectedTorrentName = bestMatchedTorrent.torrent.torrent ?
                                  bestMatchedTorrent.torrent.torrent.name :
                                  bestMatchedTorrent.torrent.title || 'Unknown Torrent Name'; // Fallback to content title or generic

  const { torrent: selectedTorrentItem, matchedFileIndex, matchedFilePath } = bestMatchedTorrent; // Rename to avoid conflict
  const selectedTorrentInfoHash = selectedTorrentItem.torrent ? selectedTorrentItem.torrent.infoHash : selectedTorrentItem.infoHash; // Get infoHash from the nested torrent if available, else top-level
  const selectedTorrentMagnetUri = selectedTorrentItem.torrent ? selectedTorrentItem.torrent.magnetUri : null; // Get magnetUri from nested torrent

  if (!selectedTorrentMagnetUri) {
    logger.error(`Selected best torrent "${selectedTorrentName}" has no magnet URI. Cannot proceed with Real-Debrid.`);
    return Promise.resolve({ streams: [] });
  }

  logger.info(`Selected best torrent: "${selectedTorrentName}" (Score: ${bestMatchedTorrent.score})`);
  logger.info(`Matched file index: ${matchedFileIndex}, path: ${matchedFilePath}`);

  let realDebridDirectLink = null;
  try {
    logger.info(`Adding magnet to Real-Debrid for infohash: ${selectedTorrentInfoHash}`);
    const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrentMagnetUri);
    logger.debug(`Real-Debrid add magnet response: ${JSON.stringify(rdAddedTorrent)}`);

    if (!rdAddedTorrent || !rdAddedTorrent.id) { // Ensure rdAddedTorrent.id exists
      logger.error('Failed to add magnet to Real-Debrid or missing torrent ID from response.');
      return Promise.resolve({ streams: [] });
    }

    let fileToSelect = 'all';
    if (matchedFileIndex !== null && matchedFileIndex !== undefined) {
      fileToSelect = matchedFileIndex.toString();
      logger.info(`Explicitly selecting file index ${fileToSelect} on Real-Debrid.`);
    } else if (rdAddedTorrent.id) {
        logger.info(`No specific file index pre-matched. Fetching torrent info from Real-Debrid to re-evaluate files for ${rdAddedTorrent.id}.`);
        const torrentInfoAfterAdd = await realDebrid.getTorrentInfo(realDebridApiKey, rdAddedTorrent.id);
        logger.debug(`Real-Debrid torrent info after add: ${JSON.stringify(torrentInfoAfterAdd)}`);

        if (torrentInfoAfterAdd && torrentInfoAfterAdd.files && torrentInfoAfterAdd.files.length > 0) {
            const filesFromRD = torrentInfoAfterAdd.files.map((file, index) => ({
                path: file.path,
                size: file.bytes,
                index: index,
            }));
            // Mock a bitmagnetItem structure for matcher to process Real-Debrid files
            const mockBitmagnetItem = {
              torrent: { files: filesFromRD, name: selectedTorrentName, infoHash: selectedTorrentInfoHash },
              content: { title: tmdbShowTitle }
            };
            const tempScoredFiles = await matcher.findBestTorrentMatch(
                [mockBitmagnetItem], // Pass as an array containing the mock item
                tmdbEpisodeDetails,
                tmdbShowTitle,
                preferredLanguages // Pass preferredLanguages here
            );
            if (tempScoredFiles[0] && tempScoredFiles[0].matchedFileIndex !== null && tempScoredFiles[0].matchedFileIndex !== undefined) {
                fileToSelect = tempScoredFiles[0].matchedFileIndex.toString();
                logger.info(`Refined file selection for torrent ${rdAddedTorrent.id}: index ${fileToSelect}`);
            } else {
                logger.warn(`Could not find specific file index in Real-Debrid files after re-matching for ${rdAddedTorrent.id}. Defaulting to 'all'.`);
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

    const rawRealDebridLink = completedTorrentInfo.links[0];
    logger.info(`Unrestricting Real-Debrid link: ${rawRealDebridLink.substring(0, 50)}...`);
    realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);
    logger.debug(`Real-Debrid unrestrict link response (direct link): ${realDebridDirectLink}`);

    if (!realDebridDirectLink) {
      logger.error('Failed to unrestrict Real-Debrid link.');
      return Promise.resolve({ streams: [] });
    }

    logger.info(`Successfully obtained direct Real-Debrid link for S${seasonNumber}E${episodeNumber}: ${realDebridDirectLink}`);

    try {
      const parsedInfoJsonString = JSON.stringify(bestMatchedTorrent.parsedInfo || {});
      const tmdbIdStr = tmdbShowDetails.id.toString();

      const existingTorrent = await dbQuery(
          `SELECT id FROM torrents WHERE infohash = $1`,
          [selectedTorrentInfoHash]
      );

      if (existingTorrent.rows.length > 0) {
          await dbQuery(
              `UPDATE torrents
               SET tmdb_id = $1, season_number = $2, episode_number = $3, torrent_name = $4,
                   parsed_info_json = $5, real_debrid_torrent_id = $6, real_debrid_file_id = $7,
                   real_debrid_link = $8, last_checked_at = NOW(), language_preference = $9, seeders = $10
               WHERE infohash = $11`,
              [
                  tmdbIdStr, seasonNumber, episodeNumber, selectedTorrentName,
                  parsedInfoJsonString, rdAddedTorrent.id, fileToSelect,
                  realDebridDirectLink, preferredLanguages[0] || 'en', selectedTorrentItem.torrent.seeders || 0, // Use selectedTorrentItem.torrent.seeders
                  selectedTorrentInfoHash
              ]
          );
          logger.info('Existing torrent record updated successfully.');
      } else {
          await dbQuery(
              `INSERT INTO torrents (
                   infohash, tmdb_id, season_number, episode_number, torrent_name,
                   parsed_info_json, real_debrid_torrent_id, real_debrid_file_id,
                   real_debrid_link, language_preference, seeders
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                  selectedTorrentInfoHash, tmdbIdStr, seasonNumber, episodeNumber, selectedTorrentName,
                  parsedInfoJsonString, rdAddedTorrent.id, fileToSelect,
                  realDebridDirectLink, preferredLanguages[0] || 'en', selectedTorrentItem.torrent.seeders || 0 // Use selectedTorrentItem.torrent.seeders
              ]
          );
          logger.info('Torrent information persisted to database.');
      }
    } catch (dbPersistError) {
      logger.error('Error persisting torrent to database:', dbPersistError.message, dbPersistError);
    }

    return Promise.resolve({
      streams: [{
        name: `RD | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
        description: `Stream via Real-Debrid`,
        url: realDebridDirectLink,
        infoHash: selectedTorrentInfoHash,
      }]
    });

  } catch (globalError) {
    logger.error('An unhandled error occurred in stream handler:', globalError.message, globalError.stack, globalError);
    return Promise.resolve({ streams: [] });
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
logger.info(`Stremio Real-Debrid Addon listening on port ${config.port}`);
