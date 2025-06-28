import express from 'express';
import cors from 'cors';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

import { manifest } from './manifest.js';
import { PORT, API_PORT, APP_HOST, ADDON_ID, REALDEBRID_API_KEY, PREFERRED_LANGUAGES } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality } from './src/utils.js';
import { getShowDetails, getMovieDetails } from './src/tmdb.js';
import { searchTorrents } from './src/bitmagnet.js';
import * as matcher from './src/matcher.js';
import * as rd from './src/realdebrid.js';
import PTT from 'parse-torrent-title';

const processingRequests = new Map();

async function startApiServer() {
    const app = express();
    app.use(cors());

    // --- SERIES ENDPOINTS ---
    app.get(`/${ADDON_ID}/process-new-series/:imdbId_season_episode/:infoHash/:fileIndex`, async (req, res) => {
        const { imdbId_season_episode, infoHash } = req.params;
        const [imdbId, season, episode] = imdbId_season_episode.split(':');
        
        const processKey = `${infoHash}|series`; // Type-aware lock key
        if (processingRequests.has(processKey)) {
            logger.warn(`[API] Request for series torrent ${infoHash} is already being processed. Awaiting result...`);
            try {
                const readyTorrent = await processingRequests.get(processKey);
                return playFromReadyTorrent(res, readyTorrent, season, episode);
            } catch (error) {
                return res.status(500).send(`Original processing request failed: ${error.message}`);
            }
        }

        const processPromise = new Promise(async (resolve, reject) => {
            try {
                const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
                if (!addResult) throw new Error('Failed to add magnet.');

                await rd.selectFiles(addResult.id, 'all', REALDEBRID_API_KEY);
                const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, REALDEBRID_API_KEY);

                const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                
                // Save with 'series' content_type
                await pool.query(
                    `INSERT INTO torrents (infohash, tmdb_id, content_type, rd_torrent_info_json, language, quality, seeders)
                     VALUES ($1, $2, 'series', $3, $4, $5, $6)
                     ON CONFLICT (infohash, tmdb_id, content_type)
                     DO UPDATE SET rd_torrent_info_json = EXCLUDED.rd_torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                    [infoHash, imdbId, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                );
                
                resolve(readyTorrent);
            } catch (error) {
                reject(error);
            }
        });

        processingRequests.set(processKey, processPromise);

        try {
            const readyTorrent = await processPromise;
            await playFromReadyTorrent(res, readyTorrent, season, episode);
        } catch (error) {
            res.status(500).send(`Error: ${error.message}`);
        } finally {
            processingRequests.delete(processKey);
        }
    });

    app.get(`/${ADDON_ID}/play-cached-series/:imdbId_season_episode/:infoHash`, async (req, res) => {
        const { imdbId_season_episode, infoHash } = req.params;
        const [imdbId, season, episode] = imdbId_season_episode.split(':');
        try {
            // Query with 'series' content_type
            const { rows } = await pool.query("SELECT rd_torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2 AND content_type = 'series'", [infoHash, imdbId]);
            if (rows.length === 0) throw new Error('Cached series torrent not found.');
            await playFromReadyTorrent(res, rows[0].rd_torrent_info_json, season, episode);
        } catch (error) {
            res.status(500).send(`Error: ${error.message}`);
        }
    });

    // --- MOVIE ENDPOINTS ---
    app.get(`/${ADDON_ID}/process-new-movie/:imdbId/:infoHash`, async (req, res) => {
        const { imdbId, infoHash } = req.params;

        const processKey = `${infoHash}|movie`; // Type-aware lock key
        if (processingRequests.has(processKey)) {
            try {
                const readyTorrent = await processingRequests.get(processKey);
                return playFromReadyMovieTorrent(res, readyTorrent);
            } catch (error) {
                return res.status(500).send(`Original processing request failed: ${error.message}`);
            }
        }

        const processPromise = new Promise(async (resolve, reject) => {
            try {
                const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
                if (!addResult) throw new Error('Failed to add magnet.');

                await rd.selectFiles(addResult.id, 'all', REALDEBRID_API_KEY);
                const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, REALDEBRID_API_KEY);

                const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                
                // Save with 'movie' content_type
                await pool.query(
                    `INSERT INTO torrents (infohash, tmdb_id, content_type, rd_torrent_info_json, language, quality, seeders)
                     VALUES ($1, $2, 'movie', $3, $4, $5, $6)
                     ON CONFLICT (infohash, tmdb_id, content_type)
                     DO UPDATE SET rd_torrent_info_json = EXCLUDED.rd_torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                    [infoHash, imdbId, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                );
                
                resolve(readyTorrent);
            } catch (error) {
                reject(error);
            }
        });

        processingRequests.set(processKey, processPromise);

        try {
            const readyTorrent = await processPromise;
            await playFromReadyMovieTorrent(res, readyTorrent);
        } catch (error) {
            res.status(500).send(`Error: ${error.message}`);
        } finally {
            processingRequests.delete(processKey);
        }
    });

    app.get(`/${ADDON_ID}/play-cached-movie/:imdbId/:infoHash`, async (req, res) => {
        const { imdbId, infoHash } = req.params;
        try {
            // Query with 'movie' content_type
            const { rows } = await pool.query("SELECT rd_torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2 AND content_type = 'movie'", [infoHash, imdbId]);
            if (rows.length === 0) throw new Error('Cached movie torrent not found.');
            await playFromReadyMovieTorrent(res, rows[0].rd_torrent_info_json);
        } catch (error) {
            res.status(500).send(`Error: ${error.message}`);
        }
    });

    app.listen(API_PORT, () => logger.info(`[API] Express API server listening on http://127.0.0.1:${API_PORT}`));
}

async function playFromReadyTorrent(res, readyTorrent, season, episode) {
    // ... (This helper function remains the same)
}

async function playFromReadyMovieTorrent(res, readyTorrent) {
    // ... (This helper function remains the same)
}


async function startAddonServer() {
    await initDb();
    const builder = new addonBuilder(manifest);

    builder.defineStreamHandler(async (args) => {
        const { type, id } = args;
        logger.info(`[ADDON] Stream request received for type: ${type}, id: ${id}`);

        if (type === 'series') {
            const [imdbId, season, episode] = id.split(':');
            // Query with 'series' content_type
            const { rows } = await pool.query("SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = 'series' AND rd_torrent_info_json IS NOT NULL", [imdbId]);
            const showDetails = await getShowDetails(imdbId);
            if (!showDetails) return { streams: [] };

            const searchString = `${showDetails.name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            const newTorrents = await searchTorrents(searchString);
            
            const { streams, cachedStreams } = await matcher.findBestSeriesStreams(showDetails, parseInt(season), parseInt(episode), newTorrents, rows, PREFERRED_LANGUAGES);
            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);
            
            return { streams: sortedStreams.map(s => ({ name: `[${s.isCached ? '⚡' : '⌛'} RD] ${s.language.toUpperCase()}|${s.quality.toUpperCase()}`, title: `${s.torrentName}\n${s.seeders} seeders`, url: s.isCached ? `${APP_HOST}/${ADDON_ID}/play-cached-series/${id}/${s.infoHash}` : `${APP_HOST}/${ADDON_ID}/process-new-series/${id}/${s.infoHash}/${s.fileIndex}` })) };
        }

        if (type === 'movie') {
            const imdbId = id;
            // Query with 'movie' content_type
            const { rows } = await pool.query("SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = 'movie' AND rd_torrent_info_json IS NOT NULL", [imdbId]);
            const movieDetails = await getMovieDetails(imdbId);
            if (!movieDetails) return { streams: [] };

            const searchString = movieDetails.title;
            const newTorrents = await searchTorrents(searchString);

            const { streams, cachedStreams } = await matcher.findBestMovieStreams(movieDetails, newTorrents, rows, PREFERRED_LANGUAGES);
            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);

            return { streams: sortedStreams.map(s => ({ name: `[${s.isCached ? '⚡' : '⌛'} RD] ${s.language.toUpperCase()}|${s.quality.toUpperCase()}`, title: `${s.torrentName}\n${s.seeders} seeders`, url: s.isCached ? `${APP_HOST}/${ADDON_ID}/play-cached-movie/${id}/${s.infoHash}` : `${APP_HOST}/${ADDON_ID}/process-new-movie/${id}/${s.infoHash}` })) };
        }

        return { streams: [] };
    });

    serveHTTP(builder.getInterface(), { port: PORT });
    logger.info(`[ADDON] Stremio addon server listening on http://127.0.0.1:${PORT}`);
}

startApiServer();
startAddonServer();
