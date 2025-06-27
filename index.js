/**
 * index.js
 * Main Stremio Addon Entry Point
 * Initializes the Stremio addon, defines stream handlers, and orchestrates the content delivery.
 */

// Corrected: addonBuilder is likely a named export along with serveHTTP and get
const { serveHTTP, get, addonBuilder } = require('stremio-addon-sdk');
const manifest = require('./manifest');
const config = require('./config');
const { initializePg, query: dbQuery } = require('./db');
const tmdb = require('./src/tmdb');
const bitmagnet = require('./src/bitmagnet');
const realDebrid = require('./src/realdebrid');
const matcher = require('./src/matcher');
const { logger } = require('./src/utils');
const axios = require('axios'); // Import axios for direct TMDB find call

// Initialize PostgreSQL connection pool on startup
initializePg();

const builder = new addonBuilder(manifest);

/**
 * Helper function to format stream names and descriptions.
 * @param {object} parsedInfo - Parsed torrent/file info from parse-torrent-title.
 * @param {object} torrentItem - The original Bitmagnet torrent item.
 * @param {Array<string>} preferredLanguages - User's preferred languages.
 * @returns {object} { streamTitle, streamDescription }
 */
function formatStreamMetadata(parsedInfo, torrentItem, preferredLanguages) {
    let quality = parsedInfo.resolution || parsedInfo.quality || 'Unknown Quality';
    if (parsedInfo.hdr) quality += ' HDR';
    if (parsedInfo.dolbyvision) quality += ' DV';
    if (parsedInfo.codec) quality += ` (${parsedInfo.codec.toUpperCase()})`; // Make codec uppercase

    const seeders = torrentItem.seeders || 0;

    let language = 'Unknown Language';
    // Prioritize language from Bitmagnet's content metadata (more reliable)
    if (torrentItem.languages && torrentItem.languages.length > 0) {
        language = torrentItem.languages[0].name || torrentItem.languages[0].id;
        // Map common language codes to more readable names
        if (language === 'en') language = 'English';
        if (language === 'tam') language = 'Tamil';
    } else if (parsedInfo.languages && parsedInfo.languages.length > 0) {
        // Fallback to ptt parsed language
        language = parsedInfo.languages[0];
        if (language === 'eng') language = 'English'; // ptt might return 'eng'
        if (language === 'hin') language = 'Hindi'; // example
    } else {
        // As a last resort, if preferred languages include English, assume English
        if (preferredLanguages.includes('en') || preferredLanguages.includes('eng')) {
            language = 'English';
        }
    }

    // Determine episode/season info for the description
    let episodeInfo = '';
    if (parsedInfo.season && parsedInfo.episode) {
        if (Array.isArray(parsedInfo.episode)) {
            episodeInfo = `S${String(parsedInfo.season).padStart(2, '0')}E${parsedInfo.episode.map(e => String(e).padStart(2, '0')).join('-')}`;
        } else if (parsedInfo.range) {
             episodeInfo = `S${String(parsedInfo.season).padStart(2, '0')}E${String(parsedInfo.range.start).padStart(2, '0')}-E${String(parsedInfo.range.end).padStart(2, '0')}`;
        }
        else {
            episodeInfo = `S${String(parsedInfo.season).padStart(2, '0')}E${String(parsedInfo.episode).padStart(2, '0')}`;
        }
    } else if (parsedInfo.season && (parsedInfo.isCompleteSeason || parsedInfo.seasonpack)) {
        episodeInfo = `S${String(parsedInfo.season).padStart(2, '0')} (Pack)`;
    } else if (parsedInfo.season) { // Just a season without specific episode/pack flag, assume pack
        episodeInfo = `S${String(parsedInfo.season).padStart(2, '0')} (Potential Pack)`;
    } else { // No season/episode info in parsed torrent/file name
        episodeInfo = 'Episode Match'; // It's a file match, but we don't have SxE info from its name
    }


    const streamTitle = `${quality}`; // Quality only for the 'BMG - RD - Quality' name
    const streamDescription = `${episodeInfo} | Seeders: ${seeders} | Lang: ${language}`;

    return { streamTitle, streamDescription };
}


// --- Define the main Stream Handler ---
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
  const minSeeders = addonConfig.minSeeders ? parseInt(addonConfig.minSeeders, 10) : config.minSeeders; // Ensure integer
  const levenshteinThreshold = addonConfig.levenshteinThreshold ? parseInt(addonConfig.levenshteinThreshold, 10) : config.levenshteinThreshold; // Ensure integer


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

  const potentialStreams = []; // Array to hold all potential streams

  // --- 1. Check for directly cached episode stream ---
  try {
    logger.info(`Checking database cache for direct episode link for S${seasonNumber}E${episodeNumber} of "${tmdbShowTitle}"`);
    const resEpisodeCache = await dbQuery( // Using dbQuery (pg)
      `SELECT * FROM torrents
       WHERE tmdb_id = $1 AND season_number = $2 AND episode_number = $3 AND real_debrid_link IS NOT NULL
       ORDER BY added_at DESC
       LIMIT 1`,
      [tmdbShowDetails.id.toString(), seasonNumber, episodeNumber]
    );
    if (resEpisodeCache.rows.length > 0) {
      const cachedTorrent = resEpisodeCache.rows[0];
      logger.info(`Found cached direct stream for S${seasonNumber}E${episodeNumber}: ${cachedTorrent.real_debrid_link}`);

      const streamMetadata = formatStreamMetadata(
        cachedTorrent.parsed_info_json, // Pass parsed_info_json from DB
        { seeders: cachedTorrent.seeders, languages: [{ id: cachedTorrent.language_preference }] }, // Mock torrentItem for formatting
        preferredLanguages
      );

      potentialStreams.push({
        name: `BMD - RD ⚡️`,
        description: streamMetadata.streamDescription,
        url: cachedTorrent.real_debrid_link,
        // Removed infoHash here as it's a direct HTTP link, not a magnet.
        isCached: true
      });
    } else {
        logger.info(`No cached direct stream found for S${seasonNumber}E${episodeNumber}.`);
    }
  } catch (dbError) {
    logger.error('Error during direct episode database cache check:', dbError.message, dbError);
  }

  // --- 2. Search Bitmagnet for new torrents ---
  logger.info(`Proceeding to search Bitmagnet for new torrents.`);
  const bitmagnetSearchQuery = `"${tmdbShowTitle}"`; // Search only by title
  let bitmagnetResults = [];
  try {
    bitmagnetResults = await bitmagnet.searchTorrents(bitmagnetSearchQuery, minSeeders);
  } catch (bitmagnetError) {
    logger.error(`Error searching Bitmagnet: ${bitmagnetError.message}`, bitmagnetError);
  }

  const scoredTorrents = await matcher.findBestTorrentMatch(
    bitmagnetResults,
    tmdbEpisodeDetails,
    tmdbShowTitle,
    preferredLanguages
  );

  // --- 3. Process top scored torrents for deferred streams ---
  // Limit to a few top results to avoid overwhelming Stremio or Real-Debrid.
  const topTorrentsToOffer = scoredTorrents.slice(0, 5); // Offer top 5 results

  for (const bestMatchedTorrent of topTorrentsToOffer) {
    const selectedTorrentName = bestMatchedTorrent.torrent.torrent ?
                                    bestMatchedTorrent.torrent.torrent.name :
                                    bestMatchedTorrent.torrent.title || 'Unknown Torrent Name';
    const { torrent: selectedTorrentItem, matchedFileIndex, parsedInfo: parsedTorrentInfo } = bestMatchedTorrent;
    const selectedTorrentInfoHash = selectedTorrentItem.torrent ? selectedTorrentItem.torrent.infoHash : selectedTorrentItem.infoHash;

    // Skip if this torrent (infoHash) already has a direct cached link
    // This avoids offering a "deferred" option if an "instant" option is already present
    if (potentialStreams.some(s => s.infoHash === selectedTorrentInfoHash && s.isCached)) {
        logger.debug(`Skipping deferred stream for ${selectedTorrentInfoHash} as a direct cached stream is already offered.`);
        continue;
    }

    // Consolidate parameters into a single ID string for the realdebrid_proxy resource.
    const customResourceId = `${selectedTorrentInfoHash}_${matchedFileIndex || '0'}_${tmdbShowDetails.id}_${seasonNumber}_${episodeNumber}`;
    // Construct the URL to our custom stream proxy endpoint
    // The client (Stremio) will hit this URL, and our addon will then handle Real-Debrid interaction
    // Pass realDebridApiKey as a query parameter for the proxy to use
    const streamUrl = `/realdebrid_proxy/${encodeURIComponent(customResourceId)}.json?realDebridApiKey=${encodeURIComponent(realDebridApiKey)}`;

    const streamMetadata = formatStreamMetadata(
      parsedTorrentInfo, // Use parsed info from matcher
      selectedTorrentItem, // Pass original torrent item for seeders/languages
      preferredLanguages
    );

    potentialStreams.push({
      name: `BMG - RD - ${streamMetadata.streamTitle}`, // BMG - RD - Quality
      description: streamMetadata.streamDescription, // Season/Episode | seeders | language
      url: streamUrl,
      // Removed infoHash here to ensure Stremio routes to our proxy, not tries direct torrent stream.
    });
  }

  // Sort final streams: cached first, then by score for deferred streams
  potentialStreams.sort((a, b) => {
    if (a.isCached && !b.isCached) return -1;
    if (!a.isCached && b.isCached) return 1;
    // For non-cached, sort by the original score (if available, otherwise default)
    // You might need to add `score` to the stream object in `potentialStreams` for this.
    // For now, simple alphabetical or original order if scores aren't transferred.
    return 0;
  });


  logger.info(`Returning ${potentialStreams.length} stream(s) to Stremio.`);
  return Promise.resolve({ streams: potentialStreams });
});

// --- Define the custom HTTP handler for on-demand Real-Debrid processing ---
// This acts as a proxy that Stremio will hit when a user selects a deferred stream.
// Changed resource name from 'stream' to 'realdebrid_proxy' to avoid conflict
builder.defineResourceHandler('realdebrid_proxy', async ({ request, response }) => {
  // Parse the custom URL path. request.id contains the encodedCustomId.
  const customResourceId = decodeURIComponent(request.id);
  const [infoHash, fileIndexStr, tmdbId, seasonNumberStr, episodeNumberStr] = customResourceId.split('_');

  if (!infoHash || !fileIndexStr || !tmdbId || !seasonNumberStr || !episodeNumberStr) {
      logger.error(`Invalid custom resource ID received: ${customResourceId}`);
      response.writeHead(400, { 'Content-Type': 'text/plain' });
      response.end('Bad Request: Invalid stream parameters.');
      return;
  }

  const seasonNumber = parseInt(seasonNumberStr, 10);
  const episodeNumber = parseInt(episodeNumberStr, 10);

  // fileIndex can be '0' if no specific index was matched, meaning main/largest file
  const fileIndex = fileIndexStr === '0' ? 0 : parseInt(fileIndexStr, 10);

  // Real-Debrid API Key passed as query parameter
  const realDebridApiKey = request.query.realDebridApiKey;
  if (!realDebridApiKey) {
      logger.error('Real-Debrid API Key missing in deferred stream request.');
      response.writeHead(401, { 'Content-Type': 'text/plain' });
      response.end('Unauthorized: Real-Debrid API Key required.');
      return;
  }

  logger.info(`Processing deferred stream request for infoHash: ${infoHash}, fileIndex: ${fileIndex}, Episode: S${seasonNumber}E${episodeNumber}`);

  let realDebridDirectLink = null;
  let rdAddedTorrentId = null;
  let torrentInfoAfterAdd = null;
  let torrentNameForDb = null;
  let parsedInfoForDb = null;

  try {
      // 1. Check local DB cache for any existing Real-Debrid entry for this infoHash
      let cachedTorrentEntry = null;
      try {
          const res = await dbQuery(
              `SELECT real_debrid_torrent_id, real_debrid_info_json, real_debrid_link, real_debrid_file_id, torrent_name, parsed_info_json FROM torrents
               WHERE infohash = $1
               LIMIT 1`,
              [infoHash]
          );
          if (res.rows.length > 0) {
              cachedTorrentEntry = res.rows[0];
              rdAddedTorrentId = cachedTorrentEntry.real_debrid_torrent_id;
              torrentNameForDb = cachedTorrentEntry.torrent_name;
              parsedInfoForDb = cachedTorrentEntry.parsed_info_json;
              try {
                  if (cachedTorrentEntry.real_debrid_info_json) {
                    torrentInfoAfterAdd = JSON.parse(cachedTorrentEntry.real_debrid_info_json);
                  }
              } catch (e) {
                  logger.warn(`Failed to parse cached real_debrid_info_json for ${infoHash}. Will re-fetch.`);
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
          logger.error(`Error during deferred stream DB lookup for ${infoHash}: ${dbError.message}`);
          // If DB lookup fails, we proceed as if nothing is cached, but won't re-add if rdAddedTorrentId is already set
      }

      // If no direct link obtained from cache, proceed with RD calls
      if (!realDebridDirectLink) {
          // If RD torrent ID is not known from cache, add the magnet
          if (!rdAddedTorrentId) {
              // --- Idempotency point for addMagnet ---
              // Attempt to add magnet. If Real-Debrid already has it, it should return the existing ID.
              const tmdbShowDetailsForMagnet = await tmdb.getTvShowDetails(tmdbId);
              const bitmagnetResultsForMagnet = await bitmagnet.searchTorrents(`"${tmdbShowDetailsForMagnet ? tmdbShowDetailsForMagnet.name : ''}"`);
              const matchingTorrent = bitmagnetResultsForMagnet.find(t => (t.torrent ? t.torrent.infoHash : t.infoHash) === infoHash);

              if (!matchingTorrent || !(matchingTorrent.torrent ? matchingTorrent.torrent.magnetUri : null)) {
                  logger.error(`Magnet URI not found for infoHash ${infoHash}. Cannot add to Real-Debrid.`);
                  response.writeHead(404, { 'Content-Type': 'text/plain' });
                  response.end('Stream Not Found: Magnet URI could not be retrieved.');
                  return;
              }
              const selectedTorrentMagnetUri = matchingTorrent.torrent.magnetUri;
              torrentNameForDb = matchingTorrent.torrent ? matchingTorrent.torrent.name : matchingTorrent.title || 'Unknown Torrent Name';
              parsedInfoForDb = matcher.parseTorrentInfo(torrentNameForDb);

              logger.info(`Adding magnet to Real-Debrid for infohash: ${infoHash}`);
              const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrentMagnetUri);

              if (!rdAddedTorrent || !rdAddedTorrent.id) {
                  logger.error('Failed to add magnet to Real-Debrid or missing torrent ID from response.');
                  response.writeHead(500, { 'Content-Type': 'text/plain' });
                  response.end('Error: Failed to add torrent to Real-Debrid.');
                  return;
              }
              rdAddedTorrentId = rdAddedTorrent.id;

              // Immediately try to persist the torrent ID to DB to handle concurrent requests
              try {
                await dbQuery(
                    `INSERT INTO torrents (
                         infohash, tmdb_id, season_number, episode_number, torrent_name,
                         parsed_info_json, real_debrid_torrent_id, last_checked_at
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                     ON CONFLICT (infohash) DO UPDATE SET
                         real_debrid_torrent_id = EXCLUDED.real_debrid_torrent_id,
                         last_checked_at = NOW();`,
                    [
                        infoHash, tmdbId, seasonNumber, episodeNumber, torrentNameForDb,
                        JSON.stringify(parsedInfoForDb || {}), rdAddedTorrentId
                    ]
                );
                logger.info(`Torrent ID ${rdAddedTorrentId} for ${infoHash} persisted/updated in DB.`);
              } catch (dbInsertError) {
                  logger.warn(`Failed to immediately persist torrent ID for ${infoHash} (likely a concurrent request). Re-fetching from DB.`);
                  // If insert failed due to conflict, another process wrote it. Re-fetch.
                  const resConflict = await dbQuery(
                      `SELECT real_debrid_torrent_id, torrent_name, parsed_info_json FROM torrents WHERE infohash = $1 LIMIT 1`,
                      [infoHash]
                  );
                  if (resConflict.rows.length > 0) {
                      rdAddedTorrentId = resConflict.rows[0].real_debrid_torrent_id;
                      torrentNameForDb = resConflict.rows[0].torrent_name;
                      parsedInfoForDb = resConflict.rows[0].parsed_info_json;
                      logger.info(`Retrieved RD Torrent ID ${rdAddedTorrentId} from DB after concurrent add conflict.`);
                  } else {
                      logger.error(`Concurrent add conflict, but could not retrieve torrent ID for ${infoHash} from DB.`);
                      response.writeHead(500, { 'Content-Type': 'text/plain' });
                      response.end('Error: Failed to establish Real-Debrid torrent ID.');
                      return;
                  }
              }
          }

          // At this point, rdAddedTorrentId is guaranteed to be set (either from cache or after adding)

          // Poll for torrent completion (this is where the waiting happens)
          logger.info(`Polling Real-Debrid for torrent completion for ${rdAddedTorrentId}...`);
          torrentInfoAfterAdd = await realDebrid.pollForTorrentCompletion(realDebridApiKey, rdAddedTorrentId);

          if (!torrentInfoAfterAdd || !torrentInfoAfterAdd.links || torrentInfoAfterAdd.links.length === 0) {
              logger.error('Torrent did not complete or no links available on Real-Debrid after polling.');
              response.writeHead(500, { 'Content-Type': 'text/plain' });
              response.end('Error: Real-Debrid torrent not ready or failed to retrieve links.');
              return;
          }

          // Select files (even if already selected, harmless to call again)
          // `fileIndexStr` can be '0' which is fine for selectFiles
          logger.info(`Selecting files ${fileIndexStr} for torrent ${rdAddedTorrentId}.`);
          await realDebrid.selectFiles(realDebridApiKey, rdAddedTorrentId, fileIndexStr);

          // Get the specific link for the desired fileIndex
          const rawRealDebridLink = torrentInfoAfterAdd.links[parseInt(fileIndexStr, 10)];
          if (!rawRealDebridLink) {
              logger.error(`Raw Real-Debrid link not found for file index ${fileIndexStr}.`);
              response.writeHead(404, { 'Content-Type': 'text/plain' });
              response.end('Error: Specific file link not found on Real-Debrid.');
              return;
          }

          // Unrestrict the link
          logger.info(`Unrestricting Real-Debrid link for file ${fileIndexStr}...`);
          realDebridDirectLink = await realDebrid.unrestrictLink(realDebridApiKey, rawRealDebridLink);

          if (!realDebridDirectLink) {
              logger.error('Failed to unrestrict Real-Debrid link.');
              response.writeHead(500, { 'Content-Type': 'text/plain' });
              response.end('Error: Failed to unrestrict Real-Debrid link.');
              return;
          }

          // Update DB with the newly obtained direct link and full info
          try {
              // Ensure we have current parsedInfoForDb and torrentNameForDb from initial retrieval or after addMagnet
              if (!parsedInfoForDb || !torrentNameForDb) {
                 const currentTorrentFromBitmagnet = await bitmagnet.searchTorrents(`"${infoHash}"`, 1); // Search by infohash
                 if (currentTorrentFromBitmagnet && currentTorrentFromBitmagnet.length > 0) {
                     torrentNameForDb = currentTorrentFromBitmagnet[0].torrent ? currentTorrentFromBitmagnet[0].torrent.name : currentTorrentFromBitmagnet[0].title;
                     parsedInfoForDb = matcher.parseTorrentInfo(torrentNameForDb);
                 } else {
                     torrentNameForDb = 'Unknown Torrent Name';
                     parsedInfoForDb = {};
                 }
              }

              const rdInfoJsonString = JSON.stringify(torrentInfoAfterAdd);

              // Update or insert the torrent info, including the specific episode link
              await dbQuery(
                  `INSERT INTO torrents (
                       infohash, tmdb_id, season_number, episode_number, torrent_name,
                       parsed_info_json, real_debrid_torrent_id, real_debrid_file_id,
                       real_debrid_link, real_debrid_info_json, last_checked_at
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                   ON CONFLICT (infohash) DO UPDATE SET
                       tmdb_id = EXCLUDED.tmdb_id,
                       season_number = EXCLUDED.season_number,
                       episode_number = EXCLUDED.episode_number,
                       torrent_name = EXCLUDED.torrent_name,
                       parsed_info_json = EXCLUDED.parsed_info_json,
                       real_debrid_torrent_id = EXCLUDED.real_debrid_torrent_id,
                       real_debrid_file_id = EXCLUDED.real_debrid_file_id,
                       real_debrid_link = EXCLUDED.real_debrid_link,
                       real_debrid_info_json = EXCLUDED.real_debrid_info_json,
                       last_checked_at = NOW();`,
                  [
                      infoHash, tmdbId, seasonNumber, episodeNumber, torrentNameForDb,
                      JSON.stringify(parsedInfoForDb || {}), rdAddedTorrentId, fileIndexStr,
                      realDebridDirectLink, rdInfoJsonString
                  ]
              );
              logger.info(`Database updated for infoHash ${infoHash} with direct link.`);
          } catch (dbPersistError) {
              logger.error('Error persisting torrent to database during deferred stream processing:', dbPersistError.message, dbPersistError);
          }
      }

      // Finally, redirect to the direct Real-Debrid link
      logger.info(`Redirecting to direct Real-Debrid link: ${realDebridDirectLink.substring(0, 50)}...`);
      response.writeHead(302, { Location: realDebridDirectLink }); // HTTP 302 Found or 307 Temporary Redirect
      response.end();

  } catch (err) {
      logger.error(`Unhandled error in deferred stream handler for ${infoHash}: ${err.message}`, err.stack, err);
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(`Internal Server Error: ${err.message}`);
  }
});

serveHTTP(builder.getInterface(), { port: config.port });
logger.info(`Stremio Real-Debrid Addon listening on port ${config.port}`);
