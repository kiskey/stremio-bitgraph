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
                        
                        const activeTorrents = await rd.getTorrents(REALDEBRID_API_KEY);
                        const existingTorrent = activeTorrents.find(t => t.hash.toLowerCase() === infoHash.toLowerCase());
                        
                        let torrentId;

                        if (existingTorrent) {
                            logger.info(`[API] Torrent with hash ${infoHash} already exists on Real-Debrid (ID: ${existingTorrent.id}). Re-using it.`);
                            torrentId = existingTorrent.id;
                        } else {
                            logger.info(`[API] Torrent with hash ${infoHash} not found on Real-Debrid. Adding it now.`);
                            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                            const addResult = await rd.addMagnet(magnet, REALDEBRID_API_KEY);
                            if (!addResult) throw new Error('Failed to add magnet to Real-Debrid.');
                            torrentId = addResult.id;
                            await rd.selectFiles(torrentId, 'all', REALDEBRID_API_KEY);
                        }

                        const readyTorrent = await rd.pollTorrentUntilReady(torrentId, REALDEBRID_API_KEY);

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

// R30: Rewritten to be robust against index mismatches.
async function playFromReadyTorrent(res, readyTorrent, season, episode) {
    const { season: fallbackSeason } = robustParseInfo(readyTorrent.filename);

    // Step 1: Filter the file list to only include files selected for download.
    // This ensures our indices will match the `links` array.
    const selectedFiles = readyTorrent.files.filter(file => file.selected === 1);
    logger.debug(`[API-PLAYER] Original file count: ${readyTorrent.files.length}. Selected file count: ${selectedFiles.length}. Links count: ${readyTorrent.links.length}.`);

    // Step 2: Search for the target episode ONLY within the selected files.
    const targetFileIndexInSelected = selectedFiles.findIndex(file => {
        const fileInfo = robustParseInfo(file.path, fallbackSeason);
        logger.debug(`[API-PLAYER] Checking selected file "${file.path}": Parsed S=${fileInfo.season}, E=${fileInfo.episode}. Target: S${season}E${episode}`);
        return fileInfo.season === parseInt(season, 10) && fileInfo.episode === parseInt(episode, 10);
    });

    // Step 3 (Fallback): If no specific episode is found, check if it's a single-file pack.
    if (targetFileIndexInSelected === -1 && selectedFiles.length === 1) {
        logger.info(`[API-PLAYER] No specific episode found, but it's a single selected file. Assuming it's the correct one.`);
        // The index will be 0 because it's the only item in the `selectedFiles` array.
        const singleFile = selectedFiles[0];
        const fileInfo = robustParseInfo(singleFile.path, fallbackSeason);
        // We accept it as long as the season matches (or if we can't determine the season from the file)
        if (fileInfo.season === parseInt(season, 10) || fileInfo.season === undefined) {
             return 0; // Use the first (and only) index.
        }
    }

    if (targetFileIndexInSelected === -1) {
        throw new Error(`Could not find S${season}E${episode} in the torrent's selected file list.`);
    }

    logger.info(`[API-PLAYER] Found S${season}E${episode} at index ${targetFileIndexInSelected} of the selected files.`);
    
    // The index from our filtered list now correctly corresponds to the links array.
    const linkToUnrestrict = readyTorrent.links[targetFileIndexInSelected];
    if (!linkToUnrestrict) {
        throw new Error(`Could not find a corresponding link at verified index ${targetFileIndexInSelected}. This indicates a mismatch between RD's files and links arrays.`);
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
