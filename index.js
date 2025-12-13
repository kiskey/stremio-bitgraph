import express from 'express';
import cors from 'cors';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, serveHTTP } = sdk;

import { manifest } from './manifest.js';
import { PORT, API_PORT, APP_HOST, ADDON_ID, REALDEBRID_API_KEY, PREFERRED_LANGUAGES } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality, formatSize, robustParseInfo } from './src/utils.js';
import { getMetaDetails } from './src/metadata.js';
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
    const selectedFiles = readyTorrent.files.filter(file => file.selected === 1);
    logger.debug(`[API-PLAYER] Original file count: ${readyTorrent.files.length}. Selected file count: ${selectedFiles.length}. Links count: ${readyTorrent.links.length}.`);

    const targetFileIndexInSelected = selectedFiles.findIndex(file => {
        const fileInfo = robustParseInfo(file.path, fallbackSeason);
        return fileInfo.season === parseInt(season, 10) && fileInfo.episode === parseInt(episode, 10);
    });

    let finalIndex = targetFileIndexInSelected;
    // Fallback for single-file packs
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
    
    // The index from our filtered list now correctly corresponds to the links array.
    const linkToUnrestrict = readyTorrent.links[finalIndex];
    if (!linkToUnrestrict) {
        throw new Error(`Could not find a corresponding link at verified index ${finalIndex}.`);
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

        const { rows } = await pool.query("SELECT * FROM torrents WHERE tmdb_id = $1 AND content_type = $2 AND rd_torrent_info_json IS NOT NULL", [imdbId, type]);

        // --- MATCHING LOGIC ---
        
        if (type === 'series') {
            const sVal = parseInt(season, 10);
            const sPadded = sVal < 10 ? `S0${sVal}` : `S${sVal}`;
            
            // --- STEP 1: TARGETED SEARCH (Refined First) ---
            const refinedQuery = `${meta.name} ${sPadded}`;
            logger.info(`[ADDON] Attempting TARGETED search for: "${refinedQuery}"`);
            
            const refinedTorrents = await searchTorrents(refinedQuery, 'tv_show', 50);
            
            // Match the results locally
            let { streams: resultStreams, cachedStreams } = await matcher.findBestSeriesStreams(meta, parseInt(season), parseInt(episode), refinedTorrents, rows, PREFERRED_LANGUAGES);
            
            logger.info(`[ADDON] Targeted search yielded ${resultStreams.length} valid streams.`);

            // --- STEP 2: FALLBACK BROAD SEARCH (If targeted failed) ---
            // UPDATED in v3.1: Increased threshold to 5.
            if (resultStreams.length < 5) {
                logger.info(`[ADDON] Low results (< 5) from targeted search. Falling back to BROAD search for "${meta.name}"...`);
                
                const broadTorrents = await searchTorrents(meta.name, 'tv_show', 100);
                const broadResult = await matcher.findBestSeriesStreams(meta, parseInt(season), parseInt(episode), broadTorrents, rows, PREFERRED_LANGUAGES);
                
                // Merge Broad results into Targeted results (deduplicating by infoHash)
                const existingHashes = new Set(resultStreams.map(s => s.infoHash));
                
                // Add broad streams if they aren't already in the list
                for (const stream of broadResult.streams) {
                    if (!existingHashes.has(stream.infoHash)) {
                        resultStreams.push(stream);
                        existingHashes.add(stream.infoHash);
                    }
                }
                
                // Merge cached streams
                const existingCachedHashes = new Set(cachedStreams.map(s => s.infoHash));
                for (const stream of broadResult.cachedStreams) {
                    if (!existingCachedHashes.has(stream.infoHash)) {
                        cachedStreams.push(stream);
                        existingCachedHashes.add(stream.infoHash);
                    }
                }
                
                logger.info(`[ADDON] Broad search merged. Total streams now: ${resultStreams.length}`);
            }

            const sortedStreams = matcher.sortAndFilterStreams(resultStreams, cachedStreams, PREFERRED_LANGUAGES);
            logger.info(`[ADDON] Returning ${sortedStreams.length} total streams for series ${id}`);
            return { streams: mapToStreamObjects(sortedStreams) };
        } 

        if (type === 'movie') {
            // --- MOVIES (Broad Search Only) ---
            logger.info(`[ADDON] Attempting BROAD search for Movie: "${meta.name}"`);
            const broadTorrents = await searchTorrents(meta.name, 'movie', 100);
            
            const movieMetaForMatcher = { title: meta.name, release_date: meta.year ? `${meta.year}-01-01` : null };
            const { streams, cachedStreams } = await matcher.findBestMovieStreams(movieMetaForMatcher, broadTorrents, rows, PREFERRED_LANGUAGES);
            
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
