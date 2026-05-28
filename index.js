// File: index.js
// Version: 2.9.10 – Terminal detection for ResourceNotFoundError

import express from 'express';
import cors from 'cors';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

import { manifest } from './manifest.js';
import { PORT, API_PORT, APP_HOST, ADDON_ID, PREFERRED_LANGUAGES, DEBRID_PROVIDER } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality, formatSize, robustParseInfo, sleep } from './src/utils.js';
import { getMetaDetails } from './src/metadata.js';
import { searchTorrents, getTorrentFiles } from './src/bitmagnet.js';
import * as matcher from './src/matcher.js';
import PTT from 'parse-torrent-title';

import debrid from './src/debrid/index.js';
import { pollTorrentUntilReady } from './src/debrid/utils.js';

// In‑memory cache for resolved torrent info (12h TTL)
import { torrentInfoCache } from './src/debrid/cachedInfoCache.js';

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

            // 1. Handle existing lock
            if (lockEntry) {
                switch (lockEntry.state) {
                    case 'COMPLETED':
                        logger.info(`[API] Lock hit for ${infoHash}. Serving completed result from in-memory lock.`);
                        torrentInfo = lockEntry.data;
                        break;
                    case 'PROCESSING':
                        logger.warn(`[API] Request for ${infoHash} is already processing. Awaiting result...`);
                        try {
                            torrentInfo = await lockEntry.promise;
                            const finalLockEntry = processingLock.get(infoHash);
                            if (finalLockEntry && finalLockEntry.state === 'COMPLETED') {
                                torrentInfo = finalLockEntry.data;
                            } else {
                                throw (finalLockEntry?.error || new Error('Processing request failed.'));
                            }
                        } catch (err) {
                            throw (err?.error || err);
                        }
                        break;
                    case 'FAILED':
                        logger.warn(`[API] Lock hit for ${infoHash}. Rejecting due to previous failure.`);
                        throw lockEntry.error;
                    default:
                        throw new Error('Unknown lock state.');
                }
            }

            // 2. Check local caches (in‑memory → DB)
            if (!torrentInfo && DEBRID_PROVIDER) {
                const cachedResolved = torrentInfoCache.get(infoHash);
                if (cachedResolved) {
                    logger.info(`[API] In‑memory cache hit for ${infoHash}. Using pre‑resolved info.`);
                    torrentInfo = cachedResolved;
                } else {
                    const { rows } = await pool.query(
                        "SELECT torrent_info_json FROM torrents WHERE infohash = $1 AND tmdb_id = $2 AND content_type = $3 AND provider = $4",
                        [infoHash, imdbId, type, DEBRID_PROVIDER]
                    );
                    if (rows.length > 0) {
                        logger.info(`[API] DB cache hit for ${infoHash}.`);
                        torrentInfo = rows[0].torrent_info_json;
                    }
                }
            }

            // 3. If still no info, start a new debrid process (atomic lock)
            if (!torrentInfo && DEBRID_PROVIDER) {
                logger.info(`[API] No cache hit for ${infoHash}. Starting new debrid process.`);

                // -- Atomic lock: set PROCESSING before any async work --
                let resolveLock, rejectLock;
                const lockPromise = new Promise((res, rej) => {
                    resolveLock = res;
                    rejectLock = rej;
                });
                lockPromise.catch(() => {});
                processingLock.set(infoHash, { state: 'PROCESSING', promise: lockPromise });

                const processPromise = (async () => {
                    let torrentId = null;
                    try {
                        // 3a. Check for existing active torrents
                        const activeTorrents = await debrid.getTorrents();
                        const existingTorrent = activeTorrents.find(
                            t => t.hash.toLowerCase() === infoHash.toLowerCase()
                        );

                        if (existingTorrent) {
                            if (['magnet_error', 'error', 'dead', 'virus'].includes(existingTorrent.status)) {
                                logger.warn(`[API] Existing torrent ${existingTorrent.id} has status '${existingTorrent.status}'. Deleting and re-adding.`);
                                await debrid.deleteTorrent(existingTorrent.id);
                                torrentId = null;
                            } else {
                                logger.info(`[API] Re-using active torrent ${existingTorrent.id} (status: ${existingTorrent.status}).`);
                                torrentId = existingTorrent.id;
                            }
                        }

                        // 3b. Add magnet if needed
                        if (!torrentId) {
                            logger.info(`[API] Adding magnet to debrid service...`);
                            const magnet = `magnet:?xt=urn:btih:${infoHash}`;
                            const addResult = await debrid.addMagnet(magnet);
                            if (!addResult) throw new Error('Failed to add magnet to debrid.');
                            torrentId = addResult.id;

                            const isCached = addResult.cached === true;
                            if (!isCached) {
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
                                    if (info.status === 'waiting_files_selection' || info.status === 'downloaded') {
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
                            } else {
                                logger.info(`[API] Torrent is already cached. Skipping pre‑selection wait.`);
                            }
                        }

                        // 3c. Poll until ready
                        const readyTorrent = await pollTorrentUntilReady(
                            torrentId,
                            (id) => debrid.getTorrentInfo(id)
                        );

                        // 3d. Store in DB
                        const language = PTT.parse(readyTorrent.filename).languages?.[0] || 'en';
                        await pool.query(
                            `INSERT INTO torrents (infohash, tmdb_id, content_type, provider, torrent_info_json, language, quality, seeders)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                             ON CONFLICT (infohash, tmdb_id, content_type, provider)
                             DO UPDATE SET torrent_info_json = EXCLUDED.torrent_info_json, last_used_at = CURRENT_TIMESTAMP`,
                            [infoHash, imdbId, type, DEBRID_PROVIDER, readyTorrent, language, getQuality(readyTorrent.filename), readyTorrent.seeders]
                        );

                        return readyTorrent;
                    } catch (error) {
                        const errMsg = error.message || '';
                        const statusCode = error.response?.status;
                        const isTerminal = errMsg.includes('magnet_error') ||
                                           errMsg.includes('virus') ||
                                           errMsg.includes('rejected') ||
                                           statusCode === 451 ||
                                           error.name === 'ResourceNotFoundError';   // ✅ terminal

                        const isTimeout = errMsg.includes('timed out');

                        if (torrentId) {
                            if (isTerminal) {
                                logger.warn(`[API] Terminal failure for ${torrentId}: ${errMsg}. Deleting torrent.`);
                                await debrid.deleteTorrent(torrentId);
                            } else if (isTimeout) {
                                logger.info(`[API] Timeout for ${torrentId} – keeping torrent for retry.`);
                            } else {
                                logger.warn(`[API] Unknown error for ${torrentId}: ${errMsg}. Deleting to avoid zombie state.`);
                                try {
                                    await debrid.deleteTorrent(torrentId);
                                } catch (cleanupErr) {
                                    logger.warn(`[API] Cleanup failed for ${torrentId}: ${cleanupErr.message}`);
                                }
                            }
                        }
                        throw error;
                    }
                })();

                try {
                    torrentInfo = await processPromise;
                    processingLock.set(infoHash, { state: 'COMPLETED', data: torrentInfo });
                    resolveLock(torrentInfo);
                    setTimeout(() => processingLock.delete(infoHash), 30000);
                } catch (error) {
                    logger.error(`[API] Processing failed for ${infoHash}: ${error.message}`);
                    processingLock.set(infoHash, { state: 'FAILED', error: error });
                    setTimeout(() => processingLock.delete(infoHash), 300000);
                    throw error;
                }
            }

            if (torrentInfo) {
                if (type === 'series') {
                    await playFromReadyTorrent(res, torrentInfo, season, episode);
                } else {
                    await playFromReadyMovieTorrent(res, torrentInfo);
                }
            } else {
                res.status(404).send('Torrent not available via debrid.');
            }
        } catch (error) {
            logger.error(`[API] Final error processing ${infoHash}: ${error.message}`);
            res.status(500).send(`Error: ${error.message}. Please try another stream.`);
        }
    });

    app.listen(API_PORT, () => logger.info(`[API] Express API server listening on http://127.0.0.1:${API_PORT}`));
}

// ================== PLAYER HELPERS (Provider‑agnostic) ==================
async function playFromReadyTorrent(res, readyTorrent, season, episode) {
    const { season: fallbackSeason } = robustParseInfo(readyTorrent.filename);
    const selectedFiles = readyTorrent.files.filter(file => file.selected === 1);

    const targetFile = selectedFiles.find(file => {
        const fileInfo = robustParseInfo(file.path, fallbackSeason);
        return fileInfo.season === parseInt(season, 10) && fileInfo.episode === parseInt(episode, 10);
    });

    let fileToPlay = targetFile;
    if (!fileToPlay && selectedFiles.length === 1) {
        logger.info(`[API-PLAYER] No exact episode match, but single selected file. Using it.`);
        fileToPlay = selectedFiles[0];
    }

    if (!fileToPlay) {
        throw new Error(`Could not find S${season}E${episode} in the torrent's selected file list.`);
    }

    if (typeof debrid.getDownloadLinkForFile === 'function') {
        const downloadUrl = await debrid.getDownloadLinkForFile(readyTorrent.id, fileToPlay.id);
        if (!downloadUrl) throw new Error('Failed to obtain download link from TorBox.');
        res.redirect(downloadUrl);
    } else {
        const fileIndexInSelected = selectedFiles.indexOf(fileToPlay);
        const linkToUnrestrict = readyTorrent.links[fileIndexInSelected];
        if (!linkToUnrestrict) throw new Error('No link available for the selected file.');
        const unrestricted = await debrid.unrestrictLink(linkToUnrestrict);
        if (!unrestricted) throw new Error('Failed to unrestrict link.');
        res.redirect(unrestricted.download);
    }
}

async function playFromReadyMovieTorrent(res, readyTorrent) {
    const selectedFiles = readyTorrent.files.filter(file => file.selected === 1);
    if (!selectedFiles.length) throw new Error('No selected files in movie torrent.');

    let fileToPlay = null;
    const videoFiles = selectedFiles.filter(f => /\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i.test(f.path));
    if (videoFiles.length) {
        fileToPlay = videoFiles.reduce((a, b) => (a.bytes > b.bytes ? a : b));
    } else {
        fileToPlay = selectedFiles.reduce((a, b) => (a.bytes > b.bytes ? a : b));
    }

    if (typeof debrid.getDownloadLinkForFile === 'function') {
        const downloadUrl = await debrid.getDownloadLinkForFile(readyTorrent.id, fileToPlay.id);
        if (!downloadUrl) throw new Error('Failed to obtain movie download link from TorBox.');
        res.redirect(downloadUrl);
    } else {
        const fileIndexInSelected = selectedFiles.indexOf(fileToPlay);
        const linkToUnrestrict = readyTorrent.links[fileIndexInSelected];
        if (!linkToUnrestrict) throw new Error('No link available for the movie file.');
        const unrestricted = await debrid.unrestrictLink(linkToUnrestrict);
        if (!unrestricted) throw new Error('Failed to unrestrict movie link.');
        res.redirect(unrestricted.download);
    }
}

// ================== ADDON SERVER ==================
async function startAddonServer() {
    await initDb();
    const builder = new addonBuilder(manifest);

    builder.defineStreamHandler(async (args) => {
        const { type, id } = args;
        logger.info(`[ADDON] Stream request received for type: ${type}, id: ${id}`);

        let imdbId, season, episode;
        if (type === 'series') {
            [imdbId, season, episode] = id.split(':');
        } else {
            imdbId = id;
        }

        const meta = await getMetaDetails(imdbId, type);
        if (!meta) return { streams: [] };

        const torrents = await searchTorrents(meta.name, type === 'series' ? 'tv_show' : 'movie', 100);
        if (!torrents.length) return { streams: [] };

        // P2P stream mapper (used only in pure P2P mode)
        const mapToP2PStreams = (sortedStreams) =>
            sortedStreams.map(s => ({
                name: `[Bitgraph P2P] ${s.language.toUpperCase()} | ${s.quality.toUpperCase()}`,
                title: `${s.torrentName}\n💾 ${formatSize(s.size)} | 👤 ${s.seeders} seeders`,
                infoHash: s.infoHash,
                fileIdx: s.fileIndex ?? 0,
                behaviorHints: { notWebReady: true, bingeGroup: type === 'series' ? imdbId : undefined },
            }));

        const mapToDebridStreams = (sortedStreams) =>
            sortedStreams.map(s => {
                const prefix = s.isCached ? '⚡' : '⌛';
                const url = `${APP_HOST}/${ADDON_ID}/stream/${type}/${id}/${s.infoHash}`;
                return {
                    name: `[${prefix} RD] ${s.language.toUpperCase()} | ${s.quality.toUpperCase()}`,
                    title: `${s.torrentName}\n💾 ${formatSize(s.size)} | 👤 ${s.seeders} seeders`,
                    url,
                };
            });

        const cachedRows = debrid.isEnabled && DEBRID_PROVIDER
            ? (await pool.query(
                "SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = $2 AND torrent_info_json IS NOT NULL AND provider = $3",
                [imdbId, type, DEBRID_PROVIDER]
            )).rows
            : [];

        let resultStreams = [], cachedStreams = [];

        if (type === 'series') {
            const sVal = parseInt(season, 10);
            const sPadded = sVal < 10 ? `S0${sVal}` : `S${sVal}`;
            const refinedQuery = `${meta.name} ${sPadded}`;
            const refinedTorrents = await searchTorrents(refinedQuery, 'tv_show', 50);
            const refinedResult = await matcher.findBestSeriesStreams(
                meta, parseInt(season), parseInt(episode), refinedTorrents, cachedRows, PREFERRED_LANGUAGES
            );
            resultStreams = refinedResult.streams;
            cachedStreams = refinedResult.cachedStreams;

            if (refinedTorrents.length < 10 || resultStreams.length === 0) {
                const broadTorrents = await searchTorrents(meta.name, 'tv_show', 100);
                const broadResult = await matcher.findBestSeriesStreams(
                    meta, parseInt(season), parseInt(episode), broadTorrents, cachedRows, PREFERRED_LANGUAGES
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
        } else {
            const movieMetaForMatcher = { title: meta.name, release_date: meta.year ? `${meta.year}-01-01` : null };
            const movieResult = await matcher.findBestMovieStreams(
                movieMetaForMatcher, torrents, cachedRows, PREFERRED_LANGUAGES
            );
            resultStreams = movieResult.streams;
            cachedStreams = movieResult.cachedStreams;
        }

        const sortedStreams = matcher.sortAndFilterStreams(resultStreams, cachedStreams, PREFERRED_LANGUAGES);
        logger.info(`[ADDON] Total sorted streams: ${sortedStreams.length}`);

        // ── TorBox: checkCached + instant‑playback cache ──────────
        if (debrid.isEnabled && typeof debrid.checkCached === 'function') {
            const hashesToCheck = sortedStreams.map(s => s.infoHash);
            if (hashesToCheck.length > 0) {
                logger.debug(`[ADDON] Calling debrid.checkCached for ${hashesToCheck.length} hashes.`);
                try {
                    const cacheStatus = await debrid.checkCached(hashesToCheck);

                    for (const s of sortedStreams) {
                        const cs = cacheStatus[s.infoHash];
                        if (cs && cs.cached) {
                            s.isCached = true;

                            if (cs.torrent_id) {
                                const files = (cs.files || []).map(f => ({
                                    id: f.id,
                                    path: f.name,
                                    bytes: f.size,
                                    selected: 1,
                                }));
                                const resolved = {
                                    id: cs.torrent_id,
                                    filename: cs.name,
                                    files,
                                    status: 'downloaded',
                                };
                                torrentInfoCache.set(s.infoHash, resolved);
                                logger.debug(`[ADDON] Stored pre-resolved info for ${s.infoHash} (torrentId=${cs.torrent_id})`);
                            }
                        } else {
                            s.isCached = false;
                        }
                    }
                    const cachedCount = sortedStreams.filter(s => s.isCached).length;
                    logger.info(`[ADDON] checkCached result: ${cachedCount} / ${sortedStreams.length} cached.`);
                } catch (err) {
                    logger.warn(`[ADDON] checkCached failed, treating all as uncached: ${err.message}`);
                    sortedStreams.forEach(s => s.isCached = false);
                }
            }
        }

        // ========== Fix missing fileIndex for P2P movies (only when P2P mode) ==========
        if (!debrid.isEnabled) {
            const torrentMap = new Map(torrents.map(t => [t.infoHash, t.torrent]));
            for (const stream of sortedStreams) {
                if (stream.fileIndex === undefined) {
                    const torrentData = torrentMap.get(stream.infoHash);
                    if (torrentData && torrentData.filesStatus === 'multi') {
                        try {
                            const files = await getTorrentFiles(stream.infoHash);
                            if (files && files.length > 0) {
                                const videoFiles = files.filter(f => f.fileType === 'video');
                                if (videoFiles.length > 0) {
                                    const largest = videoFiles.reduce((a, b) => (a.size > b.size ? a : b));
                                    stream.fileIndex = largest.index;
                                } else {
                                    stream.fileIndex = 0;
                                }
                            } else {
                                stream.fileIndex = 0;
                            }
                        } catch (err) {
                            stream.fileIndex = 0;
                        }
                    } else {
                        stream.fileIndex = 0;
                    }
                }
            }
        }

        // ========== Build final stream list ==========
        const streams = [];
        if (debrid.isEnabled) {
            streams.push(...mapToDebridStreams(sortedStreams));
        } else {
            streams.push(...mapToP2PStreams(sortedStreams));
        }

        return { streams };
    });

    serveHTTP(builder.getInterface(), { port: PORT });
    logger.info(`[ADDON] Stremio addon server listening on http://127.0.0.1:${PORT}`);
    logger.info(`[ADDON] To install, use: ${APP_HOST}/manifest.json`);
}

startApiServer();
startAddonServer();
