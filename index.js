/**
 * index.js
 * Main Stremio Addon Entry Point
 * Initializes the Express.js server for the Stremio addon, defines routes,
 * and orchestrates the content delivery using the Stremio Addon SDK's logic.
 */

const express = require('express');
const cors = require('cors'); // For handling CORS requests from Stremio
const { addonBuilder } = require('stremio-addon-sdk'); // We still use addonBuilder for defining handlers
const manifest = require('./manifest');
const config = require('./config');
const { initializePg, query: dbQuery } = require('./db'); // Correctly import pg client functions
const tmdb = require('./src/tmdb');
const bitmagnet = require('./src/bitmagnet');
const realDebrid = require('./src/realdebrid');
const matcher = require('./src/matcher');
const { logger } = require('./src/utils');
const axios = require('axios'); // Import axios for direct TMDB find call

// Initialize PostgreSQL connection pool on startup
initializePg();

// Create the addon builder - we use this to define our handlers,
// but we will expose them via Express.
const builder = new addonBuilder(manifest);

// Initialize Express app
const app = express();

// Use CORS middleware to allow cross-origin requests from Stremio
// Stremio will typically run on a different origin than your addon.
app.use(cors());

// --- Define Express Routes for Stremio Addon ---

// 1. Manifest Route: /manifest.json
// Stremio client fetches this to learn about the addon's capabilities.
app.get('/manifest.json', (req, res) => {
  logger.info('Manifest requested.');
  res.setHeader('Content-Type', 'application/json');
  res.json(manifest);
});

// 2. Stream Handler Route: /stream/:type/:id
// Stremio client requests streams based on type (series) and ID (ttXXXXXX:S:E).
app.get('/stream/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const addonConfig = req.query; // Stremio often passes config parameters as query strings for stream requests

  logger.info(`Stream request for type: ${type}, id: ${id}, config: ${JSON.stringify(addonConfig)}`);

  if (type !== 'series') {
    logger.debug('Ignoring non-series request. Only "series" type is supported.');
    return res.json({ streams: [] });
  }

  // Parse Stremio ID (e.g., 'tt123456:1:1' -> IMDb ID, Season, Episode)
  const [imdbId, seasonNumberStr, episodeNumberStr] = id.split(':');
  const seasonNumber = parseInt(seasonNumberStr, 10);
  const episodeNumber = parseInt(episodeNumberStr, 10);

  if (!imdbId || isNaN(seasonNumber) || isNaN(episodeNumber)) {
    logger.error(`Invalid Stremio ID format: ${id}`);
    return res.json({ streams: [] });
  }

  const realDebridApiKey = addonConfig.realDebridApiKey;
  if (!realDebridApiKey) {
    logger.error('Real-Debrid API Key not provided in addon configuration.');
    // Return an error stream or message to the user in Stremio
    return res.json({
        streams: [],
        error: "Real-Debrid API Key is missing in addon configuration."
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
    const tmdbFindResponse = await axios.get(`${config.tmdb.baseUrl}/find/${imdbId}`, {
      params: {
        external_source: 'imdb_id',
        api_key: config.tmdb.apiKey,
      }
    });

    if (tmdbFindResponse.data && tmdbFindResponse.data.tv_results && tmdbFindResponse.data.tv_results.length > 0) {
      tmdbShowDetails = tmdbFindResponse.data.tv_results[0];
      tmdbShowTitle = tmdbShowDetails.name;
    } else {
      logger.error(`Could not find TMDB show details for IMDb ID: ${imdbId}`);
      return res.json({ streams: [] });
    }

    tmdbEpisodeDetails = await tmdb.getTvEpisodeDetails(tmdbShowDetails.id, seasonNumber, episodeNumber);

    if (!tmdbEpisodeDetails) {
      logger.error(`Could not retrieve TMDB details for S${seasonNumber}E${episodeNumber} of ${tmdbShowTitle} (TMDB ID: ${tmdbShowDetails.id})`);
      return res.json({ streams: [] });
    }
  } catch (tmdbError) {
    logger.error(`Error fetching TMDB data: ${tmdbError.message}`);
    return res.json({ streams: [] });
  }

  // 2. Check local database (cache) for existing torrent
  let cachedTorrent = null;
  try {
    logger.info(`Checking database cache for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}"`);
    const resDb = await dbQuery(
      `SELECT * FROM torrents
       WHERE "tmdb_id" = $1 AND "season_number" = $2 AND "episode_number" = $3 AND "real_debrid_link" IS NOT NULL
       ORDER BY "added_at" DESC
       LIMIT 1`,
      [tmdbShowDetails.id.toString(), seasonNumber, episodeNumber]
    );

    if (resDb.rows.length > 0) {
      cachedTorrent = resDb.rows[0];
      // Ensure parsed_info_json is parsed if it's stored as text
      if (typeof cachedTorrent.parsed_info_json === 'string') {
          cachedTorrent.parsed_info_json = JSON.parse(cachedTorrent.parsed_info_json);
      }
    }

    if (cachedTorrent) {
      logger.info(`Found cached stream for S${seasonNumber}E${episodeNumber}: ${cachedTorrent.real_debrid_link}`);
      
      const streamMetadata = formatStreamMetadata(
        cachedTorrent.parsed_info_json,
        { seeders: cachedTorrent.seeders, languages: [{ id: cachedTorrent.language_preference }] },
        preferredLanguages
      );

      return res.json({
        streams: [{
          name: `BMD - RD ⚡️`,
          description: streamMetadata.streamDescription,
          url: cachedTorrent.real_debrid_link,
          // infoHash is intentionally removed here as it's a direct HTTP link, not a magnet.
          isCached: true
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
    bitmagnetResults = await bitmagnet.searchTorrents(bitmagnetSearchQuery, minSeeders, preferredLanguages);
    logger.info(`Bitmagnet returned ${bitmagnetResults.length} potential torrents for "${bitmagnetSearchQuery}".`);
  } catch (bitmagnetError) {
    logger.error(`Error searching Bitmagnet: ${bitmagnetError.message}`);
    return res.json({ streams: [] });
  }

  // 4. Intelligent Torrent Matching
  const scoredTorrents = await matcher.findBestTorrentMatch(
    bitmagnetResults,
    tmdbEpisodeDetails,
    tmdbShowTitle,
    preferredLanguages // Pass preferred languages to matcher for scoring
  );

  const bestMatchedTorrent = scoredTorrents[0];

  if (!bestMatchedTorrent || bestMatchedTorrent.score <= -Infinity) {
    logger.warn(`No suitable torrent found after intelligent matching for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}".`);
    return res.json({ streams: [] });
  }

  const { torrent: selectedTorrent, matchedFileIndex, parsedInfo: parsedTorrentInfo } = bestMatchedTorrent;
  logger.info(`Selected best torrent: "${selectedTorrent.name}" (Score: ${bestMatchedTorrent.score})`);
  logger.info(`Matched file index: ${matchedFileIndex}`);

  const potentialStreams = [];
  // For non-cached streams, prepare the Real-Debrid proxy URL
  // Consolidate parameters into a single ID string for the realdebrid_proxy resource.
  const customResourceId = `${selectedTorrent.infoHash}_${matchedFileIndex || '0'}_${tmdbShowDetails.id}_${seasonNumber}_${episodeNumber}`;
  // Construct the FULLY QUALIFIED URL to our custom stream proxy endpoint
  const streamUrl = `${config.appHost}/realdebrid_proxy/${encodeURIComponent(customResourceId)}.json?realDebridApiKey=${encodeURIComponent(realDebridApiKey)}`;

  const streamMetadata = formatStreamMetadata(
    parsedTorrentInfo, // Use parsed info from matcher
    selectedTorrent, // Pass original torrent item for seeders/languages
    preferredLanguages
  );

  potentialStreams.push({
    name: `BMG - RD - ${streamMetadata.streamTitle}`, // BMG - RD - Quality
    description: streamMetadata.streamDescription, // Season/Episode | seeders | language
    url: streamUrl,
    // Removed infoHash here to ensure Stremio routes to our proxy, not tries direct torrent stream.
  });

  // Sort final streams (if there were cached ones, they'd be added first)
  potentialStreams.sort((a, b) => {
    // If a.isCached (which would be true only if a direct cached stream was found and returned earlier), prioritize.
    // Otherwise, maintain order or apply secondary sorting if multiple deferred streams are generated.
    if (a.isCached && !b.isCached) return -1;
    if (!a.isCached && b.isCached) return 1;
    return 0;
  });

  logger.info(`Returning ${potentialStreams.length} stream(s) to Stremio.`);
  res.json({ streams: potentialStreams });
});


// 3. Custom Real-Debrid Proxy Handler: /realdebrid_proxy/:id.json
// This route will be hit when a user selects a deferred stream.
app.get('/realdebrid_proxy/:id', async (req, res) => {
  // CRITICAL DIAGNOSTIC LOG: This should appear immediately if the request hits the handler.
  logger.info(`--- REALDEBRID PROXY HIT ---`);
  logger.debug(`Request details: Path: ${req.path}, Params: ${JSON.stringify(req.params)}, Query: ${JSON.stringify(req.query)}`);

  // Parse the custom URL parameters from req.params.id
  const customResourceId = decodeURIComponent(req.params.id.replace('.json', '')); // Strip .json suffix
  const [infoHash, fileIndexStr, tmdbId, seasonNumberStr, episodeNumberStr] = customResourceId.split('_');

  if (!infoHash || !fileIndexStr || !tmdbId || !seasonNumberStr || !episodeNumberStr) {
      logger.error(`Invalid custom resource ID received: ${customResourceId}`);
      return res.status(400).send('Bad Request: Invalid stream parameters.');
  }

  const seasonNumber = parseInt(seasonNumberStr, 10);
  const episodeNumber = parseInt(episodeNumberStr, 10);
  const fileIndex = fileIndexStr === '0' ? 0 : parseInt(fileIndexStr, 10);

  const realDebridApiKey = req.query.realDebridApiKey;
  if (!realDebridApiKey) {
      logger.error('Real-Debrid API Key missing in deferred stream request query.');
      return res.status(401).send('Unauthorized: Real-Debrid API Key required.');
  }

  logger.info(`Processing deferred stream request for infoHash: ${infoHash}, fileIndex: ${fileIndex}, Episode: S${seasonNumber}E${episodeNumber}`);

  let realDebridDirectLink = null;
  let rdAddedTorrentId = null;
  let torrentInfoAfterAdd = null;
  let torrentNameForDb = null;
  let parsedInfoForDb = null;
  let languagePreferenceForDb = null;
  let seedersForDb = null;

  try {
      // 1. Check local DB cache for any existing Real-Debrid entry for this infoHash
      let cachedTorrentEntry = null;
      try {
          const resDb = await dbQuery(
              `SELECT "real_debrid_torrent_id", "real_debrid_info_json", "real_debrid_link", "real_debrid_file_id", "torrent_name", "parsed_info_json", "language_preference", "seeders" FROM torrents
               WHERE "infohash" = $1
               LIMIT 1`,
              [infoHash]
          );
          if (resDb.rows.length > 0) {
              cachedTorrentEntry = resDb.rows[0];
              rdAddedTorrentId = cachedTorrentEntry.real_debrid_torrent_id;
              torrentNameForDb = cachedTorrentEntry.torrent_name;
              parsedInfoForDb = cachedTorrentEntry.parsed_info_json;
              languagePreferenceForDb = cachedTorrentEntry.language_preference;
              seedersForDb = cachedTorrentEntry.seeders;
              try {
                  // pg driver might return JSONB as object directly, or string if column is text.
                  if (typeof cachedTorrentEntry.real_debrid_info_json === 'string') {
                    torrentInfoAfterAdd = JSON.parse(cachedTorrentEntry.real_debrid_info_json);
                  } else {
                    torrentInfoAfterAdd = cachedTorrentEntry.real_debrid_info_json;
                  }
              } catch (e) {
                  logger.warn(`Failed to parse cached real_debrid_info_json for ${infoHash}. Will re-fetch. Error: ${e.message}`);
                  torrentInfoAfterAdd = null;
              }

              // If a direct *link for this specific fileIndex* is cached and the torrent is downloaded, use it directly.
              if (cachedTorrentEntry.real_debrid_link && cachedTorrentEntry.real_debrid_file_id == fileIndexStr &&
                  torrentInfoAfterAdd && torrentInfoAfterAdd.status === 'downloaded') {
                  realDebridDirectLink = cachedTorrentEntry.real_debrid_link;
                  logger.info(`Serving direct cached link for ${infoHash} (file ${fileIndexStr}).`);
              } else {
                  logger.info(`Torrent ${infoHash} found in cache (RD ID: ${rdAddedTorrentId}), but direct link for file ${fileIndexStr} or full info missing/stale. Will proceed to poll/re-process.`);
              }
          }
      } catch (dbError) {
          logger.error(`Error during deferred stream DB lookup for ${infoHash}: ${dbError.message}`, dbError);
      }

      // If no direct link obtained from cache, proceed with RD calls
      if (!realDebridDirectLink) {
          // If RD torrent ID is not known from cache, add the magnet
          if (!rdAddedTorrentId) {
              const tmdbShowDetailsForMagnet = await tmdb.getTvShowDetails(tmdbId);
              const bitmagnetResultsForMagnet = await bitmagnet.searchTorrents(`"${tmdbShowDetailsForMagnet ? tmdbShowDetailsForMagnet.name : ''}"`);
              const matchingTorrent = bitmagnetResultsForMagnet.find(t => t.infoHash === infoHash);

              if (!matchingTorrent || !matchingTorrent.magnetLink) {
                  logger.error(`Magnet URI not found for infoHash ${infoHash}. Cannot add to Real-Debrid.`);
                  return res.status(404).send('Stream Not Found: Magnet URI could not be retrieved.');
              }
              const selectedTorrentMagnetUri = matchingTorrent.magnetLink;
              torrentNameForDb = matchingTorrent.name || matchingTorrent.title || 'Unknown Torrent Name';
              parsedInfoForDb = matcher.parseTorrentInfo(torrentNameForDb) || {};
              languagePreferenceForDb = (matchingTorrent.languages && matchingTorrent.languages.length > 0 ? matchingTorrent.languages[0].id : null) || preferredLanguages[0] || 'en';
              seedersForDb = matchingTorrent.seeders || 0;

              logger.info(`Adding magnet to Real-Debrid for infohash: ${infoHash}`);
              const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrentMagnetUri);

              if (!rdAddedTorrent || !rdAddedTorrent.id) {
                  logger.error('Failed to add magnet to Real-Debrid or missing torrent ID from response.');
                  return res.status(500).send('Error: Failed to add torrent to Real-Debrid.');
              }
              rdAddedTorrentId = rdAddedTorrent.id;

              // Use INSERT ... ON CONFLICT DO UPDATE to handle concurrency
              try {
                await dbQuery(
                    `INSERT INTO torrents (
                         "infohash", "tmdb_id", "season_number", "episode_number", "torrent_name",
                         "parsed_info_json", "real_debrid_torrent_id", "real_debrid_file_id", "language_preference", "seeders", "added_at", "last_checked_at"
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
                     ON CONFLICT ("infohash") DO UPDATE SET
                         "real_debrid_torrent_id" = EXCLUDED."real_debrid_torrent_id",
                         "last_checked_at" = NOW(),
                         "torrent_name" = EXCLUDED."torrent_name",
                         "parsed_info_json" = EXCLUDED."parsed_info_json",
                         "language_preference" = EXCLUDED."language_preference",
                         "seeders" = EXCLUDED."seeders";`,
                    [
                        infoHash, tmdbId, seasonNumber, episodeNumber, torrentNameForDb,
                        JSON.stringify(parsedInfoForDb || {}), rdAddedTorrentId, fileIndexStr,
                        languagePreferenceForDb, seedersForDb
                    ]
                );
                logger.info(`Torrent ID ${rdAddedTorrentId} for ${infoHash} persisted/updated in DB via ON CONFLICT.`);
              } catch (dbInsertConflictError) {
                  logger.warn(`Failed to immediately persist torrent ID for ${infoHash} (likely a concurrent request). Re-fetching from DB. Error: ${dbInsertConflictError.message}`);
                  // If insert failed due to conflict, another process wrote it. Re-fetch.
                  const resConflict = await dbQuery(
                      `SELECT "real_debrid_torrent_id", "torrent_name", "parsed_info_json", "language_preference", "seeders" FROM torrents WHERE "infohash" = $1 LIMIT 1`,
                      [infoHash]
                  );
                  if (resConflict.rows.length > 0) {
                      rdAddedTorrentId = resConflict.rows[0].real_debrid_torrent_id;
                      torrentNameForDb = resConflict.rows[0].torrent_name;
                      parsedInfoForDb = resConflict.rows[0].parsed_info_json;
                      languagePreferenceForDb = resConflict.rows[0].language_preference;
                      seedersForDb = resConflict.rows[0].seeders;
                      logger.info(`Retrieved RD Torrent ID ${rdAddedTorrentId} from DB after concurrent add conflict.`);
                  } else {
                      logger.error(`Concurrent add conflict, but could not retrieve torrent ID for ${infoHash} from DB.`);
                      return res.status(500).send('Error: Failed to establish Real-Debrid torrent ID.');
                  }
              }
          }

          // At this point, rdAddedTorrentId is guaranteed to be set

          logger.info(`Polling Real-Debrid for torrent completion for ${rdAddedTorrentId}...`);
          torrentInfoAfterAdd = await realDebrid.pollForTorrentCompletion(realDebridApiKey, rdAddedTorrentId);

          if (!torrentInfoAfterAdd || !torrentInfoAfterAdd.links || torrentInfoAfterAdd.links.length === 0) {
              logger.error('Torrent did not complete or no links available on Real-Debrid after polling.');
              return res.status(500).send('Error: Real-Debrid torrent not ready or failed to retrieve links.');
          }

          logger.info(`Selecting files ${fileIndexStr} for torrent ${rdAddedTorrentId}.`);
          await realDebrid.selectFiles(realDebridApiKey, rdAddedTorrentId, fileIndexStr);

          const rawRealDebridLink = torrentInfoAfterAdd.links[parseInt(fileIndexStr, 10)];
          if (!rawRealDebridLink) {
              logger.error(`Raw Real-Debrid link not found for file index ${fileIndexStr}.`);
              return res.status(404).send('Error: Specific file link not found on Real-Debrid.');
          }

          logger.info(`Unrestricting Real-Debrid link for file ${fileIndexStr}...`);
          realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);

          if (!realDebridDirectLink) {
              logger.error('Failed to unrestrict Real-Debrid link.');
              return res.status(500).send('Error: Failed to unrestrict Real-Debrid link.');
          }

          // Update DB with the newly obtained direct link and full info
          try {
              // Ensure we have current parsedInfoForDb and torrentNameForDb from initial retrieval or after addMagnet
              if (!parsedInfoForDb || !torrentNameForDb) {
                 const currentTorrentFromBitmagnet = await bitmagnet.searchTorrents(`"${infoHash}"`);
                 const preciseTorrentDetails = currentTorrentFromBitmagnet.find(t => t.infoHash === infoHash);

                 if (preciseTorrentDetails) {
                     torrentNameForDb = preciseTorrentDetails.name || preciseTorrentDetails.title;
                     parsedInfoForDb = matcher.parseTorrentInfo(torrentNameForDb) || {};
                     languagePreferenceForDb = (preciseTorrentDetails.languages && preciseTorrentDetails.languages.length > 0 ? preciseTorrentDetails.languages[0].id : null) || preferredLanguages[0] || 'en';
                     seedersForDb = preciseTorrentDetails.seeders || 0;
                 } else {
                     logger.warn(`Could not find precise Bitmagnet details for infoHash ${infoHash} for DB persistence. Using fallback names.`);
                     torrentNameForDb = torrentInfoAfterAdd.original_filename || torrentInfoAfterAdd.filename || 'Unknown Torrent Name (Fallback)';
                     parsedInfoForDb = matcher.parseTorrentInfo(torrentNameForDb) || {};
                     // Keep existing language/seeders or default if not found
                     languagePreferenceForDb = languagePreferenceForDb || preferredLanguages[0] || 'en';
                     seedersForDb = seedersForDb || 0;
                 }
              }

              const rdInfoJsonString = JSON.stringify(torrentInfoAfterAdd);

              // Update the record with the full Real-Debrid link and info
              await dbQuery(
                  `UPDATE torrents
                   SET "tmdb_id" = $1, "season_number" = $2, "episode_number" = $3, "torrent_name" = $4,
                       "parsed_info_json" = $5, "real_debrid_torrent_id" = $6, "real_debrid_file_id" = $7,
                       "real_debrid_link" = $8, "real_debrid_info_json" = $9, "last_checked_at" = NOW(),
                       "language_preference" = $10, "seeders" = $11
                   WHERE "infohash" = $12;`,
                  [
                      tmdbId, seasonNumber, episodeNumber, torrentNameForDb,
                      JSON.stringify(parsedInfoForDb), rdAddedTorrentId, fileIndexStr,
                      realDebridDirectLink, rdInfoJsonString,
                      languagePreferenceForDb, seedersForDb,
                      infoHash
                  ]
              );
              logger.info(`Database updated for infoHash ${infoHash} with direct link and full RD info.`);
          } catch (dbPersistError) {
              logger.error('Error persisting torrent to database during deferred stream processing:', dbPersistError.message, dbPersistError);
          }
      }

      logger.info(`Redirecting to direct Real-Debrid link: ${realDebridDirectLink.substring(0, 50)}...`);
      res.redirect(302, realDebridDirectLink); // Use res.redirect for 302
  } catch (err) {
      logger.error(`Unhandled error in deferred stream handler for ${infoHash}: ${err.message}`, err.stack, err);
      res.status(500).send(`Internal Server Error: ${err.message}`);
  }
});


// Start the Express server
app.listen(config.port, () => {
  logger.info(`Stremio Real-Debrid Addon listening on port ${config.port}`);
  logger.info(`HTTP addon accessible at: ${config.appHost}/manifest.json`);
});
