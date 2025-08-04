import express from 'express';
import cors from 'cors';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

import { manifest } from './manifest.js';
import { PORT, API_PORT, APP_HOST, ADDON_ID, REALDEBRID_API_KEY, PREFERRED_LANGUAGES } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality, formatSize, robustParseInfo } from './src/utils.js';
import { getShowDetails, getMovieDetails } from './src/tmdb.js';
import { searchTorrents } from './src/bitmagnet.js';
import * as matcher from './src/matcher.js';
import * as rd from './src/realdebrid.js';
import PTT from 'parse-torrent-title';

const processingLock = new Map();

async function startApiServer() {
    const app = express();
    app.use(cors());

    app.get(`/${ADDON_ID}/stream/:type/:id/:infoHash`, async (req, res) => {
        const { type, id, infoHash } = req.params;
        const [imdbId, season, episode] = id.split(':');

        try {
            let torrentInfo;
            const lockEntry = processingLock.get(infoHash);

            if (lockEntry) {
                switch (lockEntry.state) {
                    case 'COMPLETED':
                        logger.info(`[API] Lock hit for ${infoHash}. Serving completed result from in-memory lock.`);
                        torrentInfo = lockEntry.data;
                        break;
                    case 'PROCESSING':
                        logger.warn(`[API] Request for ${infoHash} is already processing. Awaiting result...`);
                        await lockEntry.promise;
                        const finalLockEntry = processingLock.get(infoHash);
                        if (finalLockEntry && finalLockEntry.state === 'COMPLETED') {
                            torrentInfo = finalLockEntry.data;
                        } else {
                            throw (finalLockEntry?.error || new Error('The original processing request failed.'));
                        }
                        break;
                    case 'FAILED':
                        logger.warn(`[API] Lock hit for ${infoHash}. Rejecting request due to previous failure.`);
                        throw lockEntry.error;
                }
            } else {
                const { rows } = await pool.query("SELECT rd_torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2 AND content_type = $3", [infoHash, imdbId, type]);
                if (rows.length > 0) {
                    logger.info(`[API] DB cache hit for ${infoHash}.`);
                    torrentInfo = rows[0].rd_torrent_info_json;
                }
            }

            if (!torrentInfo) {
                const processPromise = new Promise(async (resolve, reject) => {
                    try {
                        logger.info(`[API] No cache hit for ${infoHash}. Starting new RD process.`);
                        const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                        const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
                        if (!addResult) throw new Error('Failed to add magnet to Real-Debrid.');

                        await rd.selectFiles(addResult.id, 'all', REALDEBRID_API_KEY);
                        const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, REALDEBRID_API_KEY);

                        const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                        await pool.query(
                            `INSERT INTO torrents (infohash, tmdb_id, content_type, rd_torrent_info_json, language, quality, seeders)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)
                             ON CONFLICT (infohash, tmdb_id, content_type)
                             DO UPDATE SET rd_torrent_info_json = EXCLUDED.rd_torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                            [infoHash, imdbId, type, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                        );
                        
                        resolve(readyTorrent);
                    } catch (error) {
                        reject(error);
                    }
                });

                processingLock.set(infoHash, { state: 'PROCESSING', promise: processPromise });
                
                try {
                    torrentInfo = await processPromise;
                    processingLock.set(infoHash, { state: 'COMPLETED', data: torrentInfo });
                    setTimeout(() => processingLock.delete(infoHash), 30000);
                } catch (error) {
                    logger.error(`[API] Caching failure for ${infoHash}: ${error.message}`);
                    processingLock.set(infoHash, { state: 'FAILED', error: error });
                    setTimeout(() => processingLock.delete(infoHash), 300000);
                    throw error;
                }
            }

            if (type === 'series') {
                await playFromReadyTorrent(res, torrentInfo, season, episode);
            } else {
                await playFromReadyMovieTorrent(res, torrentInfo);
            }

        } catch (error) {
            logger.error(`[API] Final error processing ${infoHash}: ${error.message}`);
            processingLock.delete(infoHash);
            res.status(500).send(`Error: ${error.message}. Please try another stream.`);
        }
    });

    app.listen(API_PORT, () => logger.info(`[API] Express API server listening on http://127.0.0.1:${API_PORT}`));
}

async function playFromReadyTorrent(res, readyTorrent, season, episode) {
    const { season: fallbackSeason } = robustParseInfo(readyTorrent.filename);

    let targetFileIndexInResponse = readyTorrent.files.findIndex(file => {
        const fileInfo = robustParseInfo(file.path, fallbackSeason);
        logger.debug(`[API-PLAYER] Checking file "${file.path}": Parsed Season=${fileInfo.season}, Parsed Episode=${fileInfo.episode}. Target: S${season}E${episode}`);
        return fileInfo.season === parseInt(season, 10) && fileInfo.episode === parseInt(episode, 10);
    });

    // R15: Handle single-file season pack edge case for playback
    if (targetFileIndexInResponse === -1) {
        logger.debug(`[API-PLAYER] No specific episode file found. Checking for single-file pack.`);
        const videoFiles = readyTorrent.files.filter(f => {
            // A simple check for common video extensions.
            return /\.(mkv|mp4|avi|mov|wmv|flv)$/i.test(f.path);
        });

        if (videoFiles.length === 1) {
            logger.info(`[API-PLAYER] Found a single video file pack. Selecting it as the playback source.`);
            // Find the original index of this single video file in the main `files` array
            targetFileIndexInResponse = readyTorrent.files.findIndex(f => f.path === videoFiles[0].path);
        }
    }

    if (targetFileIndexInResponse === -1) {
        throw new Error(`Could not find S${season}E${episode} in the torrent pack's file list after a thorough check.`);
    }

    logger.info(`[API-PLAYER] Found S${season}E${episode} at file index ${targetFileIndexInResponse}.`);
    const linkToUnrestrict = readyTorrent.links[targetFileIndexInResponse];
    if (!linkToUnrestrict) {
        throw new Error(`Could not find a corresponding link at verified index ${targetFileIndexInResponse}.`);
    }

    const unrestricted = await rd.unrestrictLink(linkToUnrestrict, REALDEBRID_API_KEY);
    if (!unrestricted) {
        throw new Error('Failed to unrestrict link.');
    }
    res.redirect(unrestricted.download);
}

async function playFromReadyMovieTorrent(res, readyTorrent) {
    const linkToUnrestrict = readyTorrent.links[0];
    if (!linkToUnrestrict) throw new Error(`Could not find any links in the movie torrent.`);
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

        const mapToStreamObjects = (streams) => {
            return streams.map(s => {
                const prefix = s.isCached ? '⚡' : '⌛';
                const sizeInfo = formatSize(s.size);
                const title = `${s.torrentName}\n💾 ${sizeInfo} | 👤 ${s.seeders} seeders`;
                const url = `${APP_HOST}/${ADDON_ID}/stream/${type}/${id}/${s.infoHash}`;
                
                return {
                    name: `[${prefix} RD] ${s.language.toUpperCase()} | ${s.quality.toUpperCase()}`,
                    title: title,
                    url: url
                };
            });
        };

        if (type === 'series') {
            const [imdbId, season, episode] = id.split(':');
            const { rows } = await pool.query("SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = 'series' AND rd_torrent_info_json IS NOT NULL", [imdbId]);
            const showDetails = await getShowDetails(imdbId);
            if (!showDetails) return { streams: [] };

            const searchString = showDetails.name;
            const newTorrents = await searchTorrents(searchString, 'tv_show');
            
            const { streams, cachedStreams } = await matcher.findBestSeriesStreams(showDetails, parseInt(season), parseInt(episode), newTorrents, rows, PREFERRED_LANGUAGES);
            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);
            
            logger.info(`[ADDON] Returning ${sortedStreams.length} total streams for series ${id}`);
            return { streams: mapToStreamObjects(sortedStreams) };
        }

        if (type === 'movie') {
            const imdbId = id;
            const { rows } = await pool.query("SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = 'movie' AND rd_torrent_info_json IS NOT NULL", [imdbId]);
            const movieDetails = await getMovieDetails(imdbId);
            if (!movieDetails) return { streams: [] };

            const searchString = movieDetails.title;
            const newTorrents = await searchTorrents(searchString, 'movie');

            const { streams, cachedStreams } = await matcher.findBestMovieStreams(movieDetails, newTorrents, rows, PREFERRED_LANGUAGES);
            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);

            logger.info(`[ADDON] Returning ${sortedStreams.length} total streams for movie ${id}`);
            return { streams: mapToStreamObjects(sortedStreams) };
        }

        return { streams: [] };
    });

    serveHTTP(builder.getInterface(), { port: PORT });
    logger.info(`[ADDON] Stremio addon server listening on http://127.0.0.1:${PORT}`);
    logger.info(`[ADDON] To install, use: ${APP_HOST}/manifest.json`);
}

startApiServer();
startAddonServer();
