// File: index.js
// Version: 2.2 – Provider-aware torrents table + modular debrid

import express from 'express';
import cors from 'cors';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

import { manifest } from './manifest.js';
import { PORT, API_PORT, APP_HOST, ADDON_ID, PREFERRED_LANGUAGES, DEBRID_PROVIDER } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality, formatSize, robustParseInfo, sleep } from './src/utils.js';
import { getMetaDetails } from './src/metadata.js';
import { searchTorrents } from './src/bitmagnet.js';
import * as matcher from './src/matcher.js';
import PTT from 'parse-torrent-title';

import debrid from './src/debrid/index.js';
import { pollTorrentUntilReady } from './src/debrid/utils.js';

const processingLock = new Map();

// ================== API SERVER ==================
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
                // ✅ Provider-aware lookup
                const { rows } = await pool.query(
                    "SELECT torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2 AND content_type = $3 AND provider = $4",
                    [infoHash, imdbId, type, DEBRID_PROVIDER]
                );
                if (rows.length > 0) {
                    logger.info(`[API] DB cache hit for ${infoHash}.`);
                    torrentInfo = rows[0].torrent_info_json;
                }
            }

            if (!torrentInfo) {
                const processPromise = new Promise(async (resolve, reject) => {
                    let torrentId = null;
                    try {
                        logger.info(`[API] No cache hit for ${infoHash}. Starting new debrid process.`);

                        const activeTorrents = await debrid.getTorrents();
                        const existingTorrent = activeTorrents.find(t => t.hash.toLowerCase() === infoHash.toLowerCase());

                        if (existingTorrent) {
                            if (['magnet_error', 'error', 'dead', 'virus'].includes(existingTorrent.status)) {
                                logger.warn(`[API] Found existing torrent ${existingTorrent.id} but status is '${existingTorrent.status}'. Deleting and re-adding.`);
                                await debrid.deleteTorrent(existingTorrent.id);
                                torrentId = null;
                            } else {
                                logger.info(`[API] Re-using active torrent ${existingTorrent.id} (Status: ${existingTorrent.status}).`);
                                torrentId = existingTorrent.id;
                            }
                        }

                        if (!torrentId) {
                            logger.info(`[API] Torrent not found or invalid on debrid. Adding it now.`);
                            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                            const addResult = await debrid.addMagnet(magnet);
                            if (!addResult) throw new Error('Failed to add magnet to debrid.');
                            torrentId = addResult.id;

                            logger.info(`[API] Torrent added (ID: ${torrentId}). Waiting for metadata...`);
                            let readyForSelection = false;
                            const maxPreChecks = 10;
                            for (let i = 0; i < maxPreChecks; i++) {
                                await sleep(2000);
                                const info = await debrid.getTorrentInfo(torrentId);

                                if (!info) continue;
                                if (['magnet_error', 'error', 'virus'].includes(info.status)) {
                                    throw new Error(`Debrid rejected the magnet (${info.status}).`);
                                }
                                if (info.status === 'waiting_files_selection') {
                                    readyForSelection = true;
                                    break;
                                }
                                if (info.status === 'downloading' || info.status === 'downloaded') {
                                    readyForSelection = true;
                                    break;
                                }
                            }

                            if (!readyForSelection) {
                                throw new Error('Timed out waiting for debrid to convert magnet metadata.');
                            }

                            const freshInfo = await debrid.getTorrentInfo(torrentId);
                            if (freshInfo && freshInfo.status === 'waiting_files_selection') {
                                const fileIds = freshInfo.files.map((_, idx) => idx);
                                await debrid.selectFiles(torrentId, fileIds);
                            }
                        }

                        const readyTorrent = await pollTorrentUntilReady(
                            torrentId,
                            (id) => debrid.getTorrentInfo(id)
                        );

                        const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                        // ✅ Provider-aware insert
                        await pool.query(
                            `INSERT INTO torrents (infohash, tmdb_id, content_type, provider, torrent_info_json, language, quality, seeders)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                             ON CONFLICT (infohash, tmdb_id, content_type, provider)
                             DO UPDATE SET torrent_info_json = EXCLUDED.torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                            [infoHash, imdbId, type, DEBRID_PROVIDER, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                        );

                        resolve(readyTorrent);
                    } catch (error) {
                        const errMsg = error.message || '';
                        const isTerminal = errMsg.includes('magnet_error') ||
                                           errMsg.includes('virus') ||
                                           errMsg.includes('error') ||
                                           errMsg.includes('rejected');
                        const isTimeout = errMsg.includes('timed out');

                        if (torrentId) {
                            if (isTerminal) {
                                logger.warn(`[API] Terminal failure for ${torrentId} (${errMsg}). Deleting trash from debrid...`);
                                await debrid.deleteTorrent(torrentId);
                            } else if (isTimeout) {
                                logger.info(`[API] Timeout for ${torrentId} (likely downloading slow). Keeping torrent in debrid for retry.`);
                            } else {
                                logger.warn(`[API] Unknown error for ${torrentId} (${errMsg}). Cleaning up...`);
                                await debrid.deleteTorrent(torrentId);
                            }
                        }
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
            res.status(500).send(`Error: ${error.message}. Please try another stream.`);
        }
    });

    app.listen(API_PORT, () => logger.info(`[API] Express API server listening on http://127.0.0.1:${API_PORT}`));
}

// ================== PLAYER HELPERS ==================
async function playFromReadyTorrent(res, readyTorrent, season, episode) {
    const { season: fallbackSeason } = robustParseInfo(readyTorrent.filename);
    const selectedFiles = readyTorrent.files.filter(file => file.selected === 1);
    logger.debug(`[API-PLAYER] Original file count: ${readyTorrent.files.length}. Selected file count: ${selectedFiles.length}. Links count: ${readyTorrent.links.length}.`);

    const targetFileIndexInSelected = selectedFiles.findIndex(file => {
        const fileInfo = robustParseInfo(file.path, fallbackSeason);
        return fileInfo.season === parseInt(season, 10) && fileInfo.episode === parseInt(episode, 10);
    });

    let finalIndex = targetFileIndexInSelected;
    if (finalIndex === -1 && selectedFiles.length === 1) {
        logger.info(`[API-PLAYER] No specific episode found, but it's a single selected file. Assuming it's the correct one.`);
        const singleFile = selectedFiles[0];
        const fileInfo = robustParseInfo(singleFile.path, fallbackSeason);
        if (fileInfo.season === parseInt(season, 10) || fileInfo.season === undefined) {
            finalIndex = 0;
        }
    }

    if (finalIndex === -1) {
        throw new Error(`Could not find S${season}E${episode} in the torrent's selected file list.`);
    }

    logger.info(`[API-PLAYER] Found S${season}E${episode} at index ${finalIndex} of the selected files.`);
    const linkToUnrestrict = readyTorrent.links[finalIndex];
    if (!linkToUnrestrict) {
        throw new Error(`Could not find a corresponding link at verified index ${finalIndex}.`);
    }

    const unrestricted = await debrid.unrestrictLink(linkToUnrestrict);
    if (!unrestricted) {
        throw new Error('Failed to unrestrict link.');
    }
    res.redirect(unrestricted.download);
}

async function playFromReadyMovieTorrent(res, readyTorrent) {
    const linkToUnrestrict = readyTorrent.links[0];
    if (!linkToUnrestrict) throw new Error(`Could not find any links in the movie torrent.`);
    const unrestricted = await debrid.unrestrictLink(linkToUnrestrict);
    if (!unrestricted) throw new Error('Failed to unrestrict movie link.');
    res.redirect(unrestricted.download);
}

// ================== ADDON SERVER ==================
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

        let imdbId, season, episode;
        if (type === 'series') {
            [imdbId, season, episode] = id.split(':');
        } else {
            imdbId = id;
        }

        const meta = await getMetaDetails(imdbId, type);
        if (!meta) {
            return { streams: [] };
        }

        // ✅ Provider-aware retrieval of cached torrents
        const { rows } = await pool.query(
            "SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = $2 AND torrent_info_json IS NOT NULL AND provider = $3",
            [imdbId, type, DEBRID_PROVIDER]
        );

        // --- MATCHING LOGIC (V3.2 Intelligence) ---
        if (type === 'series') {
            const sVal = parseInt(season, 10);
            const sPadded = sVal < 10 ? `S0${sVal}` : `S${sVal}`;

            const refinedQuery = `${meta.name} ${sPadded}`;
            logger.info(`[ADDON] Attempting TARGETED search for: "${refinedQuery}"`);

            const refinedTorrents = await searchTorrents(refinedQuery, 'tv_show', 50);
            let { streams: resultStreams, cachedStreams } = await matcher.findBestSeriesStreams(
                meta,
                parseInt(season),
                parseInt(episode),
                refinedTorrents,
                rows,
                PREFERRED_LANGUAGES
            );

            if (refinedTorrents.length < 10 || resultStreams.length === 0) {
                logger.info(`[ADDON] Search potentially weak. Falling back to BROAD search for "${meta.name}"...`);
                const broadTorrents = await searchTorrents(meta.name, 'tv_show', 100);
                const broadResult = await matcher.findBestSeriesStreams(
                    meta,
                    parseInt(season),
                    parseInt(episode),
                    broadTorrents,
                    rows,
                    PREFERRED_LANGUAGES
                );

                const existingHashes = new Set(resultStreams.map(s => s.infoHash));
                for (const stream of broadResult.streams) {
                    if (!existingHashes.has(stream.infoHash)) {
                        resultStreams.push(stream);
                        existingHashes.add(stream.infoHash);
                    }
                }

                const existingCachedHashes = new Set(cachedStreams.map(s => s.infoHash));
                for (const stream of broadResult.cachedStreams) {
                    if (!existingCachedHashes.has(stream.infoHash)) {
                        cachedStreams.push(stream);
                        existingCachedHashes.add(stream.infoHash);
                    }
                }
            }

            const sortedStreams = matcher.sortAndFilterStreams(resultStreams, cachedStreams, PREFERRED_LANGUAGES);
            return { streams: mapToStreamObjects(sortedStreams) };
        }

        if (type === 'movie') {
            logger.info(`[ADDON] Attempting BROAD search for Movie: "${meta.name}"`);
            const broadTorrents = await searchTorrents(meta.name, 'movie', 100);
            const movieMetaForMatcher = { title: meta.name, release_date: meta.year ? `${meta.year}-01-01` : null };
            const { streams, cachedStreams } = await matcher.findBestMovieStreams(
                movieMetaForMatcher,
                broadTorrents,
                rows,
                PREFERRED_LANGUAGES
            );

            const sortedStreams = matcher.sortAndFilterStreams(streams, cachedStreams, PREFERRED_LANGUAGES);
            return { streams: mapToStreamObjects(sortedStreams) };
        }

        return { streams: [] };
    });

    serveHTTP(builder.getInterface(), { port: PORT });
}

startApiServer();
startAddonServer();
