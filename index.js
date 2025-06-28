import { StremioAddonSDK, addonBuilder, serveHTTP } from 'stremio-addon-sdk';
import express from 'express';
import cors from 'cors';
import { manifest } from './manifest.js';
import { PORT, ADDON_ID } from './config.js';
import { initDb, pool } from './db.js';
import { logger, getQuality } from './src/utils.js';
import { getShowDetails } from './src/tmdb.js';
import { searchTorrents } from './src/bitmagnet.js';
import * as matcher from './src/matcher.js';
import * as rd from './src/realdebrid.js';

// Initialize Database
await initDb();

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async (args) => {
    logger.info(`Stream request: ${args.id}`);

    const { realDebridApiKey, preferredLanguages: prefLangsStr } = args.config;
    if (!realDebridApiKey) {
        return Promise.reject(new Error('Real-Debrid API Key not configured.'));
    }
    const preferredLanguages = (prefLangsStr || 'en').split(',').map(l => l.trim());

    const [imdbId, season, episode] = args.id.split(':');
    const seasonNum = parseInt(season, 10);
    const episodeNum = parseInt(episode, 10);

    // 1. Check for cached streams first
    let cachedStreams = [];
    try {
        const result = await pool.query(
            'SELECT * FROM torrents WHERE tmdb_id = $1 AND season_number = $2 AND episode_number = $3 AND unrestricted_link IS NOT NULL',
            [imdbId, seasonNum, episodeNum]
        );
        cachedStreams = result.rows.map(row => ({
            name: `[CACHED] ${row.quality.toUpperCase()}`,
            title: row.torrent_name,
            url: row.unrestricted_link,
            quality: row.quality,
        }));
    } catch (dbError) {
        logger.error('Error querying cached streams:', dbError);
    }

    // 2. Fetch metadata and search for new torrents
    const showDetails = await getShowDetails(imdbId);
    if (!showDetails) {
        return Promise.resolve({ streams: cachedStreams });
    }

    const searchString = `${showDetails.name} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
    const torrents = await searchTorrents(searchString);

    if (!torrents || torrents.length === 0) {
        logger.info(`No torrents found for query: ${searchString}`);
        return Promise.resolve({ streams: cachedStreams });
    }

    // 3. Match, score, and prepare stream objects
    const matchedStreams = await matcher.findBestStreams(showDetails, seasonNum, episodeNum, torrents);
    const sortedStreams = matcher.sortAndFilterStreams(matchedStreams, cachedStreams, preferredLanguages);

    const streamObjects = sortedStreams.map(stream => {
        if (stream.url) { // This is a cached stream
            return {
                name: stream.name,
                title: stream.title,
                url: stream.url
            };
        }
        // This is a new stream, create a callback URL
        const callbackUrl = `http://127.0.0.1:${PORT}/${ADDON_ID}/realdebrid/${args.id}/${stream.infoHash}/${stream.fileIndex}`;
        return {
            name: `[RD+] ${stream.language.toUpperCase()} | ${stream.quality.toUpperCase()}`,
            title: `${stream.torrentName}\nSeeders: ${stream.seeders}`,
            url: callbackUrl,
        };
    });

    return Promise.resolve({ streams: streamObjects });
});

const app = express();
app.use(cors());

// Endpoint to handle the on-demand Real-Debrid processing
app.get(`/${ADDON_ID}/realdebrid/:imdbId_season_episode/:infoHash/:fileIndex`, async (req, res) => {
    const { imdbId_season_episode, infoHash, fileIndex } = req.params;
    const [imdbId, season, episode] = imdbId_season_episode.split(':');

    // Stremio sends config in the query string for such URLs
    const { realDebridApiKey } = req.query;
    if (!realDebridApiKey) {
        return res.status(400).send('Real-Debrid API Key is missing from request.');
    }

    logger.info(`Processing RD request for ${infoHash}, file ${fileIndex}`);

    try {
        // 1. Add magnet to RD
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}`;
        const addResult = await rd.addMagnet(magnetLink, realDebridApiKey);
        if (!addResult) throw new Error('Failed to add magnet to Real-Debrid.');

        // 2. Select the specific file to download
        const torrentInfo = await rd.getTorrentInfo(addResult.id, realDebridApiKey);
        const fileId = torrentInfo.files.find(f => f.id === parseInt(fileIndex, 10) + 1)?.id; // File IDs are 1-based
        if (!fileId) throw new Error('Could not find the specified file index in the torrent.');
        
        await rd.selectFiles(addResult.id, fileId.toString(), realDebridApiKey);

        // 3. Poll until the torrent is ready
        const readyTorrent = await rd.pollTorrentUntilReady(addResult.id, realDebridApiKey);

        // 4. Unrestrict the link
        const linkToUnrestrict = readyTorrent.links[0];
        const unrestricted = await rd.unrestrictLink(linkToUnrestrict, realDebridApiKey);
        if (!unrestricted) throw new Error('Failed to unrestrict link.');

        // 5. Persist to database for caching
        const torrentName = readyTorrent.filename;
        const quality = getQuality(torrentName);
        const language = PTT.parse(torrentName).languages?.[0] || 'en';
        
        await pool.query(
            `INSERT INTO torrents (infohash, tmdb_id, season_number, episode_number, file_index, torrent_name, unrestricted_link, language, quality, seeders, real_debrid_torrent_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (infohash, tmdb_id, season_number, episode_number, file_index)
             DO UPDATE SET unrestricted_link = EXCLUDED.unrestricted_link, last_checked_at = CURRENT_TIMESTAMP`,
            [infoHash, imdbId, season, episode, fileIndex, torrentName, unrestricted.download, language, quality, readyTorrent.seeders, addResult.id]
        );

        // 6. Redirect Stremio to the final streaming link
        res.redirect(unrestricted.download);

    } catch (error) {
        logger.error(`Error processing Real-Debrid request: ${error.message}`);
        res.status(500).send(`Error: ${error.message}`);
    }
});


const sdk = new StremioAddonSDK(builder);
app.use((req, res, next) => {
    sdk.middleware(req, res, next);
});

app.listen(PORT, () => {
    logger.info(`Stremio addon server running on http://localhost:${PORT}`);
});
