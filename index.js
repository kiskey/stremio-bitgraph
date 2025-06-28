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
        
        if (processingRequests.has(infoHash)) {
            logger.warn(`[API] Request for series torrent ${infoHash} is already being processed. Awaiting result...`);
            try {
                const readyTorrent = await processingRequests.get(infoHash);
                return playFromReadyTorrent(res, readyTorrent, season, episode);
            } catch (error) {
                logger.error(`[API] The original processing request for series torrent ${infoHash} failed: ${error.message}`);
                return res.status(500).send(`Original processing request failed: ${error.message}`);
            }
        }

        const processPromise = new Promise(async (resolve, reject) => {
            try {
                logger.info(`[API] Acquired lock for series torrent ${infoHash}.`);
                const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
                if (!addResult) throw new Error('Failed to add magnet to Real-Debrid.');

                await rd.selectFiles(addResult.id, 'all', REALDEBRID_API_KEY);
                const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, REALDEBRID_API_KEY);

                const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                
                await pool.query(
                    `INSERT INTO torrents (infohash, tmdb_id, rd_torrent_info_json, language, quality, seeders)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (infohash, tmdb_id)
                     DO UPDATE SET rd_torrent_info_json = EXCLUDED.rd_torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                    [infoHash, imdbId, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                );
                
                resolve(readyTorrent);
            } catch (error) {
                reject(error);
            }
        });

        processingRequests.set(infoHash, processPromise);

        try {
            const readyTorrent = await processPromise;
            await playFromReadyTorrent(res, readyTorrent, season, episode);
        } catch (error) {
            logger.error(`[API] Error processing new series torrent ${infoHash}: ${error.message}`);
            res.status(500).send(`Error: ${error.message}`);
        } finally {
            processingRequests.delete(infoHash);
            logger.info(`[API] Released lock for series torrent ${infoHash}.`);
        }
    });

    app.get(`/${ADDON_ID}/play-cached-series/:imdbId_season_episode/:infoHash`, async (req, res) => {
        const { imdbId_season_episode, infoHash } = req.params;
        const [imdbId, season, episode] = imdbId_season_episode.split(':');
        logger.info(`[API] Processing CACHED series request for ${infoHash}, S${season}E${episode}`);

        try {
            const { rows } = await pool.query('SELECT rd_torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2', [infoHash, imdbId]);
            if (rows.length === 0) throw new Error('Cached series torrent not found in database.');
            const torrentInfo = rows[0].rd_torrent_info_json;
            await playFromReadyTorrent(res, torrentInfo, season, episode);
        } catch (error) {
            logger.error(`[API] Error playing from cached series torrent: ${error.message}`);
            res.status(500).send(`Error: ${error.message}`);
        }
    });

    // --- MOVIE ENDPOINTS ---
    app.get(`/${ADDON_ID}/process-new-movie/:imdbId/:infoHash`, async (req, res) => {
        const { imdbId, infoHash } = req.params;

        if (processingRequests.has(infoHash)) {
            logger.warn(`[API] Request for movie torrent ${infoHash} is already being processed. Awaiting result...`);
            try {
                const readyTorrent = await processingRequests.get(infoHash);
                return playFromReadyMovieTorrent(res, readyTorrent);
            } catch (error) {
                logger.error(`[API] The original processing request for movie torrent ${infoHash} failed: ${error.message}`);
                return res.status(500).send(`Original processing request failed: ${error.message}`);
            }
        }

        const processPromise = new Promise(async (resolve, reject) => {
            try {
                logger.info(`[API] Acquired lock for movie torrent ${infoHash}.`);
                const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
                if (!addResult) throw new Error('Failed to add magnet to Real-Debrid.');

                await rd.selectFiles(addResult.id, 'all', REALDEBRID_API_KEY);
                const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, REALDEBRID_API_KEY);

                const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                
                await pool.query(
                    `INSERT INTO torrents (infohash, tmdb_id, rd_torrent_info_json, language, quality, seeders)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (infohash, tmdb_id)
                     DO UPDATE SET rd_torrent_info_json = EXCLUDED.rd_torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                    [infoHash, imdbId, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                );
                
                resolve(readyTorrent);
            } catch (error) {
                reject(error);
            }
        });

        processingRequests.set(infoHash, processPromise);

        try {
            const readyTorrent = await processPromise;
            await playFromReadyMovieTorrent(res, readyTorrent);
        } catch (error) {
            logger.error(`[API] Error processing new movie torrent ${infoHash}: ${error.message}`);
            res.status(500).send(`Error: ${error.message}`);
        } finally {
            processingRequests.delete(infoHash);
            logger.info(`[API] Released lock for movie torrent ${infoHash}.`);
        }
    });

    app.get(`/${ADDON_ID}/play-cached-movie/:imdbId/:infoHash`, async (req, res) => {
        const { imdbId, infoHash } = req.params;
        logger.info(`[API] Processing CACHED movie request for ${infoHash}`);

        try {
            const { rows } = await pool.query('SELECT rd_torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2', [infoHash, imdbId]);
            if (rows.length === 0) throw new Error('Cached movie torrent not found in database.');
            const torrentInfo = rows[0].rd_torrent_info_json;
            await playFromReadyMovieTorrent(res, torrentInfo);
        } catch (error) {
            logger.error(`[API] Error playing from cached movie torrent: ${error.message}`);
            res.status(500).send(`Error: ${error.message}`);
        }
    });

    app.listen(API_PORT, () => {
        logger.info(`[API] Express API server listening on http://127.0.0.1:${API_PORT}`);
    });
}

// Helper for playing series episodes
async function playFromReadyTorrent(res, readyTorrent, season, episode) {
    const targetFileIndexInResponse = readyTorrent.files.findIndex(file => {
        const fileInfo = PTT.parse(file.path);
        return fileInfo.season === parseInt(season, 10) && fileInfo.episode === parseInt(episode, 10);
    });

    if (targetFileIndexInResponse === -1) {
        throw new Error(`Could not find S${season}E${episode} in the torrent pack's file list.`);
    }
    const linkToUnrestrict = readyTorrent.links[targetFileIndexInResponse];
    if (!linkToUnrestrict) {
        throw new Error(`Could not find a corresponding link at verified index ${targetFileIndexInResponse}.`);
    }

    const unrestricted = await rd.unrestrictLink(linkToUnrestrict, REALDEBRID_API_KEY);
    if (!unrestricted) throw new Error('Failed to unrestrict link.');

    res.redirect(unrestricted.download);
}

// Helper for playing movies
async function playFromReadyMovieTorrent(res, readyTorrent) {
    // For movies, we assume the first link is the correct one.
    const linkToUnrestrict = readyTorrent.links[0];
    if (!linkToUnrestrict) {
        throw new Error(`Could not find any links in the movie torrent.`);
    }

    const unrestricted = await rd.unrestrictLink(linkToUnrestrict, REALDEBRID_API_KEY);
    if (!unrestricted) throw new Error('Failed to unrestrict movie link.');

    res.redirect(unrestricted.download);
}


async function startAddonServer() {
    await initDb();
    const builder = new addonBuilder(manifest);

    builder.defineStreamHandler(async (args) => {
        const { type, id } = args;
        logger.info(`[ADDON] Stream request received for type: ${type}, id: ${id}`);

        if (type === 'series') {
            const [imdbId, season, episode] = id.split(':');
            const seasonNum = parseInt(season);
            const episodeNum = parseInt(episode);

            const { rows } = await pool.query('SELECT * FROM torrents WHERE tmdb_id = $1 AND rd_torrent_info_json IS NOT NULL', [imdbId]);
            const showDetails = await getShowDetails(imdbId);
            if (!showDetails) return { streams: [] };

            const searchString = `${showDetails.name} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
            const newTorrents = await searchTorrents(searchString);
            
            const { streams, cachedStreams } = await matcher.findBestSeriesStreams(showDetails, seasonNum, episodeNum, newTorrents, rows, PREFERRED_LANGUAGES);
            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);
            
            logger.info(`[ADDON] Returning ${sortedStreams.length} total streams for series ${id}`);
            return {
                streams: sortedStreams.map(s => ({
                    name: `[${s.isCached ? '⚡' : '⌛'} RD] ${s.language.toUpperCase()} | ${s.quality.toUpperCase()}`,
                    title: `${s.torrentName}\n${s.seeders} seeders`,
                    url: s.isCached
                        ? `${APP_HOST}/${ADDON_ID}/play-cached-series/${id}/${s.infoHash}`
                        : `${APP_HOST}/${ADDON_ID}/process-new-series/${id}/${s.infoHash}/${s.fileIndex}`
                }))
            };
        }

        if (type === 'movie') {
            const imdbId = id;
            const { rows } = await pool.query('SELECT * FROM torrents WHERE tmdb_id = $1 AND rd_torrent_info_json IS NOT NULL', [imdbId]);
            const movieDetails = await getMovieDetails(imdbId);
            if (!movieDetails) return { streams: [] };

            const searchString = movieDetails.title;
            const newTorrents = await searchTorrents(searchString);

            const { streams, cachedStreams } = await matcher.findBestMovieStreams(movieDetails, newTorrents, rows, PREFERRED_LANGUAGES);
            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);

            logger.info(`[ADDON] Returning ${sortedStreams.length} total streams for movie ${id}`);
            return {
                streams: sortedStreams.map(s => ({
                    name: `[${s.isCached ? '⚡' : '⌛'} RD] ${s.language.toUpperCase()} | ${s.quality.toUpperCase()}`,
                    title: `${s.torrentName}\n${s.seeders} seeders`,
                    url: s.isCached
                        ? `${APP_HOST}/${ADDON_ID}/play-cached-movie/${id}/${s.infoHash}`
                        : `${APP_HOST}/${ADDON_ID}/process-new-movie/${id}/${s.infoHash}`
                }))
            };
        }

        return { streams: [] };
    });

    serveHTTP(builder.getInterface(), { port: PORT });
    logger.info(`[ADDON] Stremio addon server listening on http://127.0.0.1:${PORT}`);
    logger.info(`[ADDON] To install, use: ${APP_HOST}/manifest.json`);
}

startApiServer();
startAddonServer();
