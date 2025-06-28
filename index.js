import express from 'express';
import cors from 'cors';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

import { manifest } from './manifest.js';
import { PORT, API_PORT, APP_HOST, ADDON_ID, REALDEBRID_API_KEY, PREFERRED_LANGUAGES } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality } from './src/utils.js';
import { getShowDetails } from './src/tmdb.js';
import { searchTorrents } from './src/bitmagnet.js';
import * as matcher from './src/matcher.js';
import * as rd from './src/realdebrid.js';
import PTT from 'parse-torrent-title';

// --- API SERVER (Express) ---
async function startApiServer() {
    const app = express();
    app.use(cors());

    // All API endpoints remain the same...
    app.get(`/${ADDON_ID}/process-new/:imdbId_season_episode/:infoHash/:fileIndex`, async (req, res) => {
        const { imdbId_season_episode, infoHash, fileIndex } = req.params;
        const [imdbId, season, episode] = imdbId_season_episode.split(':');
        logger.info(`[API] Processing NEW request for ${infoHash}, file ${fileIndex}`);

        try {
            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
            const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
            if (!addResult) throw new Error('Failed to add magnet to Real-Debrid.');

            const torrentInfo = await rd.getTorrentInfo(addResult.id, REALDEBRID_API_KEY);
            const fileId = torrentInfo.files.find(f => f.id === parseInt(fileIndex, 10) + 1)?.id;
            if (!fileId) throw new Error('Could not find the specified file index in the torrent.');
            
            await rd.selectFiles(addResult.id, fileId.toString(), REALDEBRID_API_KEY);
            const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, REALDEBRID_API_KEY);

            const torrentName = readyTorrent.filename;
            const quality = getQuality(torrentName);
            const language = PTT.parse(torrentName).languages?.[0] || 'en';
            
            await pool.query(
                `INSERT INTO torrents (infohash, tmdb_id, rd_torrent_info_json, language, quality, seeders)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (infohash, tmdb_id)
                 DO UPDATE SET rd_torrent_info_json = EXCLUDED.rd_torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                [infoHash, imdbId, readyTorrent, language, quality, readyTorrent.seeders]
            );

            const linkToUnrestrict = readyTorrent.links[0];
            const unrestricted = await rd.unrestrictLink(linkToUnrestrict, REALDEBRID_API_KEY);
            if (!unrestricted) throw new Error('Failed to unrestrict link.');

            res.redirect(unrestricted.download);
        } catch (error) {
            logger.error(`[API] Error processing new torrent: ${error.message}`);
            res.status(500).send(`Error: ${error.message}`);
        }
    });

    app.get(`/${ADDON_ID}/play-cached/:imdbId_season_episode/:infoHash`, async (req, res) => {
        const { imdbId_season_episode, infoHash } = req.params;
        const [imdbId, season, episode] = imdbId_season_episode.split(':');
        logger.info(`[API] Processing CACHED request for ${infoHash}, S${season}E${episode}`);

        try {
            const { rows } = await pool.query('SELECT rd_torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2', [infoHash, imdbId]);
            if (rows.length === 0) throw new Error('Cached torrent not found in database.');

            const torrentInfo = rows[0].rd_torrent_info_json;
            const file = matcher.findFileInTorrentInfo(torrentInfo, parseInt(season, 10), parseInt(episode, 10));
            if (!file) throw new Error(`Episode S${season}E${episode} not found in cached torrent files.`);

            const unrestricted = await rd.unrestrictLink(file.link, REALDEBRID_API_KEY);
            if (!unrestricted) throw new Error('Failed to unrestrict cached link.');

            pool.query('UPDATE torrents SET last_used_at = CURRENT_TIMESTAMP WHERE infohash = $1 AND tmdb_id = $2', [infoHash, imdbId]);

            res.redirect(unrestricted.download);
        } catch (error) {
            logger.error(`[API] Error playing from cached torrent: ${error.message}`);
            res.status(500).send(`Error: ${error.message}`);
        }
    });

    app.listen(API_PORT, () => {
        logger.info(`[API] Express API server for callbacks listening on http://127.0.0.1:${API_PORT}`);
    });
}


// --- STREMIO ADDON SERVER ---
async function startAddonServer() {
    await initDb();
    
    const builder = new addonBuilder(manifest);

    builder.defineStreamHandler(async (args) => {
        logger.info(`[ADDON] Stream request received: ${args.id}`);
        const [imdbId, season, episode] = args.id.split(':');
        const seasonNum = parseInt(season, 10);
        const episodeNum = parseInt(episode, 10);
        logger.debug(`[ADDON] Parsed request for IMDb ID: ${imdbId}, Season: ${seasonNum}, Episode: ${episodeNum}`);

        let cachedTorrents = [];
        try {
            const result = await pool.query(
                'SELECT * FROM torrents WHERE tmdb_id = $1 AND rd_torrent_info_json IS NOT NULL',
                [imdbId]
            );
            cachedTorrents = result.rows;
            logger.debug(`[ADDON] Found ${cachedTorrents.length} cached torrents for ${imdbId}`);
        } catch (dbError) {
            logger.error('[ADDON] Error querying cached torrents:', dbError);
        }

        // *** CORE BUG FIX IS HERE ***
        const showDetails = await getShowDetails(imdbId);
        if (!showDetails || !showDetails.name) {
            logger.warn(`[ADDON] Could not find valid TMDB details for ${imdbId}. Aborting search for new torrents.`);
            // We can still return streams from the cache if any were found
            const { cachedStreams } = await matcher.findBestStreams(null, seasonNum, episodeNum, [], cachedTorrents);
            const sortedStreams = matcher.sortAndFilterStreams([], cachedStreams, PREFERRED_LANGUAGES);
            const streamObjects = sortedStreams.map(stream => ({
                name: `[RD] ${stream.language.toUpperCase()} | ${stream.quality.toUpperCase()}`,
                title: `${stream.torrentName}\nSeeders: ${stream.seeders}`,
                url: `${APP_HOST}/${ADDON_ID}/play-cached/${args.id}/${stream.infoHash}`
            }));
            return { streams: streamObjects };
        }

        const searchString = `${showDetails.name} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
        logger.debug(`[ADDON] Constructed Bitmagnet search string: "${searchString}"`);
        const newTorrents = await searchTorrents(searchString);
        logger.debug(`[ADDON] Found ${newTorrents.length} new torrents from Bitmagnet.`);

        const { streams, cachedStreams } = await matcher.findBestStreams(showDetails, seasonNum, episodeNum, newTorrents, cachedTorrents);
        const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);
        logger.info(`[ADDON] Returning ${sortedStreams.length} total streams for ${args.id}`);

        const streamObjects = sortedStreams.map(stream => {
            const callbackUrl = stream.isCached
                ? `${APP_HOST}/${ADDON_ID}/play-cached/${args.id}/${stream.infoHash}`
                : `${APP_HOST}/${ADDON_ID}/process-new/${args.id}/${stream.infoHash}/${stream.fileIndex}`;
            
            return {
                name: `[${stream.isCached ? 'RD' : 'RD+'}] ${stream.language.toUpperCase()} | ${stream.quality.toUpperCase()}`,
                title: `${stream.torrentName}\nSeeders: ${stream.seeders}`,
                url: callbackUrl,
            };
        });

        return { streams: streamObjects };
    });

    serveHTTP(builder.getInterface(), { port: PORT });
    logger.info(`[ADDON] Stremio addon server listening on http://127.0.0.1:${PORT}`);
    logger.info(`[ADDON] To install, use: http://<your_server_ip>:${PORT}/manifest.json`);
}

// --- START BOTH SERVERS ---
startApiServer();
startAddonServer();
