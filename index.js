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

  const potentialStreams = []; // Array to hold all potential streams, including cached and newly found

  // --- New Robust Caching Strategy ---
  let cachedTorrentByEpisode = null;
  let cachedTorrentByInfohash = null;

  try {
    logger.info(`Checking database cache for direct episode link for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}"`);
    const resEpisodeCache = await dbQuery(
      `SELECT * FROM torrents
       WHERE tmdb_id = $1 AND season_number = $2 AND episode_number = $3 AND real_debrid_link IS NOT NULL
       ORDER BY added_at DESC
       LIMIT 1`,
      [tmdbShowDetails.id.toString(), seasonNumber, episodeNumber]
    );
    if (resEpisodeCache.rows.length > 0) {
      cachedTorrentByEpisode = resEpisodeCache.rows[0];
    }

    if (cachedTorrentByEpisode) {
      // For now, still return directly if a specific episode link is cached and working (fastest path)
      // In a more advanced scenario, we'd try to re-unrestrict this link to validate it.
      logger.info(`Found cached direct stream for S${seasonNumber}E${episodeNumber}: ${cachedTorrentByEpisode.real_debrid_link}`);
      potentialStreams.unshift({ // Add to the beginning to prioritize
        name: `RD Cached | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
        description: `Cached direct link from ${new Date(cachedTorrentByEpisode.added_at).toISOString().split('T')[0]}`,
        url: cachedTorrentByEpisode.real_debrid_link,
        infoHash: cachedTorrentByEpisode.infohash,
        isCached: true // Custom flag for sorting later
      });
    } else {
        logger.info(`No cached direct stream found for S${seasonNumber}E${episodeNumber}.`);
    }


    // --- Check for cached torrent by infohash (for season packs or other episodes from same torrent) ---
    logger.info(`Checking database for existing torrent infohash in Real-Debrid for "${tmdbShowTitle}"`);
    // Query for any torrent for this show that has full Real-Debrid info cached.
    const resInfohashCache = await dbQuery(
        `SELECT * FROM torrents
         WHERE tmdb_id = $1 AND real_debrid_torrent_id IS NOT NULL AND real_debrid_info_json IS NOT NULL
         ORDER BY last_checked_at DESC, added_at DESC
         LIMIT 1`, // Get the most recently used / freshest full RD info JSON for the show
        [tmdbShowDetails.id.toString()]
    );

    if (resInfohashCache.rows.length > 0) {
        cachedTorrentByInfohash = resInfohashCache.rows[0];
        const cachedRdTorrentId = cachedTorrentByInfohash.real_debrid_torrent_id;
        const cachedInfoHash = cachedTorrentByInfohash.infohash;

        // Parse JSONB from DB
        let cachedRealDebridInfoJson = null;
        try {
            // PG driver might already parse JSONB to object, but defensive check
            cachedRealDebridInfoJson = typeof cachedTorrentByInfohash.real_debrid_info_json === 'string' ?
                                         JSON.parse(cachedTorrentByInfohash.real_debrid_info_json) :
                                         cachedTorrentByInfohash.real_debrid_info_json;
        } catch (jsonParseError) {
            logger.error(`Error parsing cached real_debrid_info_json for ${cachedInfoHash}: ${jsonParseError.message}`);
            // If JSON is corrupted, invalidate this entry
            await dbQuery(`UPDATE torrents SET real_debrid_info_json = NULL, real_debrid_link = NULL WHERE id = $1`, [cachedTorrentByInfohash.id]);
            cachedRealDebridInfoJson = null; // Clear to force new fetch
        }


        if (cachedRealDebridInfoJson) {
            logger.info(`Found cached Real-Debrid torrent ID (${cachedRdTorrentId}) for infohash: ${cachedInfoHash}. Revalidating.`);

            try {
                // Re-fetch latest torrent info from Real-Debrid
                logger.info(`Fetching latest torrent info from Real-Debrid for cached ID: ${cachedRdTorrentId}`);
                const torrentInfoAfterAdd = await realDebrid.getTorrentInfo(realDebridApiKey, cachedRdTorrentId);
                logger.debug(`Real-Debrid revalidation info: ${JSON.stringify(torrentInfoAfterAdd)}`);

                if (torrentInfoAfterAdd && torrentInfoAfterAdd.links && torrentInfoAfterAdd.links.length > 0) {
                    // Use matcher to find the specific episode file within these refreshed files
                    const filesFromRD = torrentInfoAfterAdd.files.map((file, index) => ({
                        path: file.path,
                        size: file.bytes,
                        index: index,
                    }));

                    // Mock a bitmagnetItem structure for matcher to process Real-Debrid files
                    // Use original_name from torrentInfoAfterAdd for accurate PTT parsing
                    const mockBitmagnetItem = {
                      torrent: { files: filesFromRD, name: torrentInfoAfterAdd.original_name || tmdbShowTitle, infoHash: cachedInfoHash },
                      content: { title: tmdbShowTitle } // Use TMDB show title for content title
                    };

                    const tempScoredFiles = await matcher.findBestTorrentMatch(
                        [mockBitmagnetItem], // Pass as an array containing the mock item
                        tmdbEpisodeDetails,
                        tmdbShowTitle,
                        preferredLanguages
                    );

                    if (tempScoredFiles[0] && tempScoredFiles[0].score > -Infinity && tempScoredFiles[0].matchedFileIndex !== null && tempScoredFiles[0].matchedFileIndex !== undefined) {
                        const bestFileMatch = tempScoredFiles[0];
                        const rawRealDebridLink = torrentInfoAfterAdd.links[bestFileMatch.matchedFileIndex]; // Get the specific link
                        logger.info(`Found matched file in revalidated RD torrent: "${bestFileMatch.matchedFilePath}"`);
                        logger.info(`Unrestricting revalidated Real-Debrid link: ${rawRealDebridLink.substring(0, 50)}...`);
                        const realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);

                        if (realDebridDirectLink) {
                            logger.info(`Successfully obtained revalidated direct Real-Debrid link for S${seasonNumber}E${episodeNumber}: ${realDebridDirectLink}`);
                            potentialStreams.unshift({ // Add to the beginning for prioritization
                              name: `RD Revalidated | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
                              description: `Revalidated link from ${new Date().toISOString().split('T')[0]}`,
                              url: realDebridDirectLink,
                              infoHash: cachedInfoHash,
                              isCached: true // Custom flag for sorting later
                            });

                            // Update cache with the latest info and link for this specific episode
                            await dbQuery(
                                `UPDATE torrents
                                 SET real_debrid_info_json = $1, real_debrid_link = $2, real_debrid_file_id = $3, last_checked_at = NOW()
                                 WHERE id = $4`,
                                [
                                    JSON.stringify(torrentInfoAfterAdd),
                                    realDebridDirectLink,
                                    bestFileMatch.matchedFileIndex.toString(),
                                    cachedTorrentByInfohash.id
                                ]
                            );
                            logger.info(`Cached Real-Debrid info and direct link for S${seasonNumber}E${episodeNumber} updated.`);
                            // Do NOT return here. Collect all streams and sort at the end.
                        } else {
                            logger.warn(`Failed to unrestrict revalidated Real-Debrid link for ${cachedInfoHash}.`);
                        }
                    } else {
                        logger.warn(`Could not find specific episode file within revalidated Real-Debrid torrent files for ${cachedInfoHash}.`);
                    }
                } else {
                    logger.warn(`Revalidated Real-Debrid torrent info for ${cachedRdTorrentId} has no links or is not completed. Status: ${torrentInfoAfterAdd.status || 'unknown'}. Invalidate cache.`);
                    // Invalidate this cache entry if it's no longer viable
                    await dbQuery(`UPDATE torrents SET real_debrid_info_json = NULL, real_debrid_link = NULL, real_debrid_torrent_id = NULL WHERE id = $1`, [cachedTorrentByInfohash.id]);
                    logger.info(`Invalidated Real-Debrid cache for ${cachedInfoHash} due to unviable status.`);
                }
            } catch (rdRevalidationError) {
                logger.error(`Error during Real-Debrid revalidation for cached ID ${cachedRdTorrentId}: ${rdRevalidationError.message}`, rdRevalidationError);
                // Invalidate this cache entry on error during revalidation
                await dbQuery(`UPDATE torrents SET real_debrid_info_json = NULL, real_debrid_link = NULL, real_debrid_torrent_id = NULL WHERE id = $1`, [cachedTorrentByInfohash.id]);
                logger.info(`Invalidated Real-Debrid cache for ${cachedInfoHash} due to revalidation error.`);
            }
        }
    } else {
        logger.info(`No existing Real-Debrid torrent infohash cache found for show "${tmdbShowTitle}".`);
    }

  } catch (dbError) {
    logger.error('Error during database cache checks:', dbError.message, dbError);
    // Continue to search Bitmagnet even if DB lookup fails
  }

  // --- Proceed with Bitmagnet Search for new torrents if necessary ---
  logger.info(`Proceeding to search Bitmagnet for new torrents.`);

  // Construct query string based on documentation for better targeting
  // Quoted title, unquoted season/episode part
  const bitmagnetSearchQuery = `"${tmdbShowTitle}" S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;

  let bitmagnetResults = [];
  try {
    // minSeeders is used for client-side filtering only now, not passed to Bitmagnet query
    bitmagnetResults = await bitmagnet.searchTorrents(bitmagnetSearchQuery, minSeeders);
  } catch (bitmagnetError) {
    logger.error(`Error searching Bitmagnet: ${bitmagnetError.message}`, bitmagnetError);
    // If Bitmagnet search fails, we still return any existing potential streams
    return Promise.resolve({ streams: potentialStreams });
  }

  const scoredTorrents = await matcher.findBestTorrentMatch(
    bitmagnetResults,
    tmdbEpisodeDetails,
    tmdbShowTitle,
    preferredLanguages // Pass preferredLanguages here for language scoring
  );

  const bestMatchedTorrent = scoredTorrents[0];

  if (bestMatchedTorrent && bestMatchedTorrent.score > -Infinity) {
    const selectedTorrentName = bestMatchedTorrent.torrent.torrent ?
                                    bestMatchedTorrent.torrent.torrent.name :
                                    bestMatchedTorrent.torrent.title || 'Unknown Torrent Name';

    const { torrent: selectedTorrentItem, matchedFileIndex, matchedFilePath } = bestMatchedTorrent;
    const selectedTorrentInfoHash = selectedTorrentItem.torrent ? selectedTorrentItem.torrent.infoHash : selectedTorrentItem.infoHash;
    const selectedTorrentMagnetUri = selectedTorrentItem.torrent ? selectedTorrentItem.torrent.magnetUri : null;

    if (!selectedTorrentMagnetUri) {
      logger.error(`Selected best torrent "${selectedTorrentName}" has no magnet URI. Cannot proceed with Real-Debrid.`);
    } else {
        logger.info(`Selected best torrent: "${selectedTorrentName}" (Score: ${bestMatchedTorrent.score})`);
        logger.info(`Matched file index: ${matchedFileIndex}, path: ${matchedFilePath}`);

        let realDebridDirectLink = null;
        let rdAddedTorrentId = null;
        let torrentInfoAfterAdd = null; // Will store the full RD torrent info

        try {
            // Check if this specific infohash is already known to Real-Debrid via our cache (from another episode, or a previous attempt)
            // This is separate from the `cachedTorrentByInfohash` check which fetched a general torrent for the show.
            // This is for the *currently selected best torrent from Bitmagnet*.
            let existingRdTorrentForInfohash = null;
            try {
                const existingRdCheck = await dbQuery(
                    `SELECT real_debrid_torrent_id, real_debrid_info_json FROM torrents WHERE infohash = $1 AND real_debrid_torrent_id IS NOT NULL LIMIT 1`,
                    [selectedTorrentInfoHash]
                );
                if (existingRdCheck.rows.length > 0) {
                    existingRdTorrentForInfohash = existingRdCheck.rows[0].real_debrid_torrent_id;
                    try {
                        torrentInfoAfterAdd = JSON.parse(existingRdCheck.rows[0].real_debrid_info_json);
                    } catch (e) {
                        logger.warn(`Failed to parse cached real_debrid_info_json for ${selectedTorrentInfoHash}. Will re-fetch.`);
                        torrentInfoAfterAdd = null;
                    }
                    logger.info(`Torrent ${selectedTorrentInfoHash} already known to Real-Debrid via cache (ID: ${existingRdTorrentForInfohash}). Attempting to reuse.`);
                }
            } catch (dbCheckError) {
                logger.error(`Error checking DB for existing RD torrent for infohash ${selectedTorrentInfoHash}: ${dbCheckError.message}`);
            }

            if (existingRdTorrentForInfohash) {
                rdAddedTorrentId = existingRdTorrentForInfohash;
                if (!torrentInfoAfterAdd || torrentInfoAfterAdd.status !== 'downloaded' && torrentInfoAfterAdd.status !== 'finished') {
                    // Re-poll if existing info is missing or not yet downloaded
                    logger.info(`Re-fetching latest info for existing Real-Debrid torrent ID: ${rdAddedTorrentId}`);
                    torrentInfoAfterAdd = await realDebrid.pollForTorrentCompletion(realDebridApiKey, rdAddedTorrentId);
                }
            } else {
                logger.info(`Adding magnet to Real-Debrid for infohash: ${selectedTorrentInfoHash}`);
                const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrentMagnetUri);
                logger.debug(`Real-Debrid add magnet response: ${JSON.stringify(rdAddedTorrent)}`);

                if (!rdAddedTorrent || !rdAddedTorrent.id) {
                  logger.error('Failed to add magnet to Real-Debrid or missing torrent ID from response.');
                  return Promise.resolve({ streams: potentialStreams }); // Exit if add magnet fails
                }
                rdAddedTorrentId = rdAddedTorrent.id;
                // Torrent has just been added, poll for completion
                logger.info(`Polling Real-Debrid for torrent completion for newly added ${rdAddedTorrentId}...`);
                torrentInfoAfterAdd = await realDebrid.pollForTorrentCompletion(realDebridApiKey, rdAddedTorrentId);
            }

            if (!torrentInfoAfterAdd || !torrentInfoAfterAdd.links || torrentInfoAfterAdd.links.length === 0) {
              logger.error('Torrent did not complete or no links available on Real-Debrid after initial add/poll.');
              return Promise.resolve({ streams: potentialStreams }); // Exit if polling fails
            }

            let fileToSelect = 'all';
            if (matchedFileIndex !== null && matchedFileIndex !== undefined) {
              fileToSelect = matchedFileIndex.toString();
              logger.info(`Explicitly selecting file index ${fileToSelect} on Real-Debrid.`);
            } else {
                logger.info(`No specific file index pre-matched for newly added/reused torrent. Re-evaluating files for ${rdAddedTorrentId}.`);
                const filesFromRD = torrentInfoAfterAdd.files.map((file, index) => ({
                    path: file.path,
                    size: file.bytes,
                    index: index,
                }));
                const mockBitmagnetItem = {
                  torrent: { files: filesFromRD, name: selectedTorrentName, infoHash: selectedTorrentInfoHash },
                  content: { title: tmdbShowTitle }
                };
                const tempScoredFiles = await matcher.findBestTorrentMatch(
                    [mockBitmagnetItem],
                    tmdbEpisodeDetails,
                    tmdbShowTitle,
                    preferredLanguages
                );
                if (tempScoredFiles[0] && tempScoredFiles[0].matchedFileIndex !== null && tempScoredFiles[0].matchedFileIndex !== undefined) {
                    fileToSelect = tempScoredFiles[0].matchedFileIndex.toString();
                    logger.info(`Refined file selection for torrent ${rdAddedTorrentId}: index ${fileToSelect}`);
                } else {
                    logger.warn(`Could not find specific file index in Real-Debrid files after re-matching for ${rdAddedTorrentId}. Defaulting to 'all'.`);
                }
            }

            logger.info(`Calling selectFiles on Real-Debrid for torrent ${rdAddedTorrentId}, files: ${fileToSelect}`);
            const rdSelectFilesResult = await realDebrid.selectFiles(realDebridApiKey, rdAddedTorrentId, fileToSelect);
            logger.debug(`Real-Debrid select files response: ${JSON.stringify(rdSelectFilesResult)}`);

            if (!rdSelectFilesResult) {
              logger.error('Failed to select files on Real-Debrid.');
              return Promise.resolve({ streams: potentialStreams }); // Exit if select files fails
            }

            // Now get the specific link after selection
            // Ensure the link index is valid before accessing
            const linkIndex = (fileToSelect === 'all' || isNaN(parseInt(fileToSelect, 10))) ? 0 : parseInt(fileToSelect, 10);
            const rawRealDebridLink = torrentInfoAfterAdd.links[linkIndex];
            
            if (!rawRealDebridLink) {
                logger.error(`No raw Real-Debrid link found for selected file index ${fileToSelect} from torrent info or index ${linkIndex} is out of bounds.`);
                return Promise.resolve({ streams: potentialStreams });
            }

            logger.info(`Unrestricting Real-Debrid link: ${rawRealDebridLink.substring(0, 50)}...`);
            realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);
            logger.debug(`Real-Debrid unrestrict link response (direct link): ${realDebridDirectLink}`);

            if (!realDebridDirectLink) {
              logger.error('Failed to unrestrict Real-Debrid link.');
              return Promise.resolve({ streams: potentialStreams }); // Exit if unrestrict fails
            }

            logger.info(`Successfully obtained direct Real-Debrid link for S${seasonNumber}E${episodeNumber}: ${realDebridDirectLink}`);

            // --- Persist the full Real-Debrid Torrent Info JSON and episode-specific link ---
            try {
              const parsedInfoJsonString = JSON.stringify(bestMatchedTorrent.parsedInfo || {});
              const rdInfoJsonString = JSON.stringify(torrentInfoAfterAdd || {}); // Store full RD info
              const tmdbIdStr = tmdbShowDetails.id.toString();

              // Check if infohash already exists to decide between INSERT and UPDATE
              const existingTorrentInDb = await dbQuery(
                  `SELECT id FROM torrents WHERE infohash = $1`,
                  [selectedTorrentInfoHash]
              );

              if (existingTorrentInDb.rows.length > 0) {
                  await dbQuery(
                      `UPDATE torrents
                       SET tmdb_id = $1, season_number = $2, episode_number = $3, torrent_name = $4,
                           parsed_info_json = $5, real_debrid_torrent_id = $6, real_debrid_file_id = $7,
                           real_debrid_link = $8, real_debrid_info_json = $9, last_checked_at = NOW(),
                           language_preference = $10, seeders = $11
                       WHERE infohash = $12`,
                      [
                          tmdbIdStr, seasonNumber, episodeNumber, selectedTorrentName,
                          parsedInfoJsonString, rdAddedTorrentId, fileToSelect,
                          realDebridDirectLink, rdInfoJsonString,
                          preferredLanguages[0] || 'en', selectedTorrentItem.torrent.seeders || 0,
                          selectedTorrentInfoHash
                      ]
                  );
                  logger.info('Existing torrent record updated successfully with new RD info and link.');
              } else {
                  await dbQuery(
                      `INSERT INTO torrents (
                           infohash, tmdb_id, season_number, episode_number, torrent_name,
                           parsed_info_json, real_debrid_torrent_id, real_debrid_file_id,
                           real_debrid_link, real_debrid_info_json,
                           language_preference, seeders
                       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                      [
                          selectedTorrentInfoHash, tmdbIdStr, seasonNumber, episodeNumber, selectedTorrentName,
                          parsedInfoJsonString, rdAddedTorrentId, fileToSelect,
                          realDebridDirectLink, rdInfoJsonString,
                          preferredLanguages[0] || 'en', selectedTorrentItem.torrent.seeders || 0
                      ]
                  );
                  logger.info('New torrent information (including full RD info) persisted to database.');
              }
            } catch (dbPersistError) {
              logger.error('Error persisting torrent to database (full RD info):', dbPersistError.message, dbPersistError);
            }

            potentialStreams.push({
              name: `RD | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
              description: `Stream via Real-Debrid`,
              url: realDebridDirectLink,
              infoHash: selectedTorrentInfoHash,
              isCached: false // New streams are not initially from cache
            });
        } catch (realDebridFlowError) {
          logger.error('Error during Real-Debrid torrent processing flow (add/select/unrestrict):', realDebridFlowError.message, realDebridFlowError.stack, realDebridFlowError);
        }
    }
  }

  logger.info(`Returning ${potentialStreams.length} stream(s) to Stremio.`);
  return Promise.resolve({ streams: potentialStreams });
});

serveHTTP(builder.getInterface(), { port: config.port });
logger.info(`Stremio Real-Debrid Addon listening on port ${config.port}`);
