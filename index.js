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
const realDebrid = require('./src/realdebrid');
const axios = require('axios');

// Initialize PostgreSQL connection pool on startup
initializePg();

const builder = new addonBuilder(manifest);

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
  const minSeeders = addonConfig.minSeeders ? parseInt(addonConfig.minSeeders, 10) : config.minSeeders;

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
    const resEpisodeCache = await dbQuery(
      `SELECT * FROM torrents
       WHERE tmdb_id = $1 AND season_number = $2 AND episode_number = $3 AND real_debrid_link IS NOT NULL
       ORDER BY added_at DESC
       LIMIT 1`,
      [tmdbShowDetails.id.toString(), seasonNumber, episodeNumber]
    );
    if (resEpisodeCache.rows.length > 0) {
      const cachedTorrent = resEpisodeCache.rows[0];
      logger.info(`Found cached direct stream for S${seasonNumber}E${episodeNumber}: ${cachedTorrent.real_debrid_link}`);
      potentialStreams.push({ // Add to the beginning to prioritize
        name: `RD Cached | ${tmdbShowTitle} S${seasonNumber}E${episodeNumber}`,
        description: `Instant (Cached)`,
        url: cachedTorrent.real_debrid_link,
        infoHash: cachedTorrent.infohash,
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
    const { torrent: selectedTorrentItem, matchedFileIndex } = bestMatchedTorrent;
    const selectedTorrentInfoHash = selectedTorrentItem.torrent ? selectedTorrentItem.torrent.infoHash : selectedTorrentItem.infoHash;

    // Skip if this torrent (infoHash) already has a direct cached link
    // This avoids offering a "deferred" option if an "instant" option is already present
    if (potentialStreams.some(s => s.infoHash === selectedTorrentInfoHash && s.isCached)) {
        logger.debug(`Skipping deferred stream for ${selectedTorrentInfoHash} as a direct cached stream is already offered.`);
        continue;
    }

    // Construct the URL to our custom stream proxy endpoint
    // The client (Stremio) will hit this URL, and our addon will then handle Real-Debrid interaction
    // Pass realDebridApiKey as a query parameter for the proxy to use
    const streamUrl = `/realdebrid_proxy/rd/${selectedTorrentInfoHash}/${matchedFileIndex || '0'}/${tmdbShowDetails.id}/${seasonNumber}/${episodeNumber}?realDebridApiKey=${encodeURIComponent(realDebridApiKey)}`;

    potentialStreams.push({
      name: `RD | ${selectedTorrentName}`,
      description: `Click to prepare stream (Deferred)`,
      url: streamUrl,
      infoHash: selectedTorrentInfoHash,
      // Add more metadata if desired for sorting/display in Stremio UI
      // e.g., quality, size, language. This relies on what `matcher.js` returns.
    });
  }

  logger.info(`Returning ${potentialStreams.length} stream(s) to Stremio.`);
  return Promise.resolve({ streams: potentialStreams });
});

// --- Define the custom HTTP handler for on-demand Real-Debrid processing ---
// This acts as a proxy that Stremio will hit when a user selects a deferred stream.
// Changed resource name from 'stream' to 'realdebrid_proxy' to avoid conflict
builder.defineResourceHandler('realdebrid_proxy', async ({ request, response }) => {
  // Parse the custom URL path: /realdebrid_proxy/rd/:infoHash/:fileIndex/:tmdbId/:seasonNumber/:episodeNumber
  const pathParts = request.path.split('/');
  // Expected path: ['', 'realdebrid_proxy', 'rd', 'INFO_HASH', 'FILE_INDEX', 'TMDB_ID', 'SEASON', 'EPISODE']
  if (pathParts.length !== 8 || pathParts[2] !== 'rd') {
      logger.error(`Invalid deferred stream request path: ${request.path}`);
      response.writeHead(400, { 'Content-Type': 'text/plain' });
      response.end('Bad Request: Invalid stream path.');
      return;
  }

  const infoHash = pathParts[3];
  const fileIndexStr = pathParts[4];
  const tmdbId = pathParts[5];
  const seasonNumber = parseInt(pathParts[6], 10);
  const episodeNumber = parseInt(pathParts[7], 10);

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

  try {
      // 1. Check if this infohash is already known and downloaded on Real-Debrid
      let cachedTorrent = null;
      try {
          const res = await dbQuery(
              `SELECT real_debrid_torrent_id, real_debrid_info_json, real_debrid_link, real_debrid_file_id FROM torrents
               WHERE infohash = $1 AND real_debrid_torrent_id IS NOT NULL
               LIMIT 1`,
              [infoHash]
          );
          if (res.rows.length > 0) {
              cachedTorrent = res.rows[0];
              rdAddedTorrentId = cachedTorrent.real_debrid_torrent_id;
              try {
                  torrentInfoAfterAdd = JSON.parse(cachedTorrent.real_debrid_info_json);
              } catch (e) {
                  logger.warn(`Failed to parse cached real_debrid_info_json for ${infoHash} during deferred request. Will re-fetch.`);
                  torrentInfoAfterAdd = null;
              }

              // If a direct *link for this specific fileIndex* is cached and the torrent is downloaded, use it directly.
              // Also ensure the file_id matches because a torrent can have many files, and this specific episode link is cached.
              if (cachedTorrent.real_debrid_link && cachedTorrent.real_debrid_file_id == fileIndexStr &&
                  torrentInfoAfterAdd && torrentInfoAfterAdd.status === 'downloaded') {
                  realDebridDirectLink = cachedTorrent.real_debrid_link;
                  logger.info(`Serving direct cached link for ${infoHash} (file ${fileIndexStr}).`);
              } else {
                  logger.info(`Torrent ${infoHash} found in cache, but direct link for file ${fileIndexStr} or full info missing/stale. Re-polling RD.`);
              }
          }
      } catch (dbError) {
          logger.error(`Error during deferred stream DB lookup for ${infoHash}: ${dbError.message}`);
      }

      // If no direct link obtained from cache, proceed with RD calls
      if (!realDebridDirectLink) {
          // If RD torrent ID is not known from cache, add the magnet
          if (!rdAddedTorrentId) {
              // Search Bitmagnet for the magnet URI of the specific infoHash
              // Note: tmdbId is passed to searchTorrents as a placeholder, it expects a string like "Show Title"
              // For a specific infoHash, we need to get the magnet URI.
              // Assuming bitmagnet.searchTorrents can return by infoHash or we need to refine it.
              // For now, doing a broad search and finding the matching torrent's magnetUri.
              const bitmagnetResults = await bitmagnet.searchTorrents(`"${tmdbId}"`); // This is a general search
              const matchingTorrent = bitmagnetResults.find(t => (t.torrent ? t.torrent.infoHash : t.infoHash) === infoHash);

              if (!matchingTorrent || !(matchingTorrent.torrent ? matchingTorrent.torrent.magnetUri : null)) {
                  logger.error(`Magnet URI not found for infoHash ${infoHash}. Cannot add to Real-Debrid.`);
                  response.writeHead(404, { 'Content-Type': 'text/plain' });
                  response.end('Stream Not Found: Magnet URI could not be retrieved.');
                  return;
              }
              const selectedTorrentMagnetUri = matchingTorrent.torrent.magnetUri;
              logger.info(`Adding magnet to Real-Debrid for infohash: ${infoHash}`);
              const rdAddedTorrent = await realDebrid.addMagnet(realDebridApiKey, selectedTorrentMagnetUri);

              if (!rdAddedTorrent || !rdAddedTorrent.id) {
                  logger.error('Failed to add magnet to Real-Debrid or missing torrent ID from response.');
                  response.writeHead(500, { 'Content-Type': 'text/plain' });
                  response.end('Error: Failed to add torrent to Real-Debrid.');
                  return;
              }
              rdAddedTorrentId = rdAddedTorrent.id;
          }

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
              // Fetch tmdbShowDetails for DB persistence if not available from cached torrent
              let currentTmdbShowTitle = '';
              const tmdbDetailsForDb = await tmdb.getTvShowDetails(tmdbId);
              if (tmdbDetailsForDb) {
                  currentTmdbShowTitle = tmdbDetailsForDb.name;
              }

              const selectedTorrentNameForDb = torrentInfoAfterAdd.original_filename || torrentInfoAfterAdd.filename || 'Unknown Torrent Name';
              const parsedInfoForDb = matcher.parseTorrentInfo(selectedTorrentNameForDb);
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
                      infoHash, tmdbId, seasonNumber, episodeNumber, selectedTorrentNameForDb,
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
