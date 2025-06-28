import PTT from 'parse-torrent-title';
import stringSimilarity from 'string-similarity';
import { SIMILARITY_THRESHOLD } from '../config.js';
import { getTorrentFiles } from './bitmagnet.js';
import { logger, QUALITY_ORDER, getQuality } from './utils.js';

function getTitleSimilarity(tmdbTitle, torrentName) {
    const parsed = PTT.parse(torrentName);
    if (!parsed.title) return 0;
    return stringSimilarity.compareTwoStrings(tmdbTitle.toLowerCase(), parsed.title.toLowerCase());
}

export function findFileInTorrentInfo(torrentInfo, season, episode) {
    for (const file of torrentInfo.files) {
        const fileInfo = PTT.parse(file.path);
        if (fileInfo.season === season && fileInfo.episode === episode) {
            return file;
        }
    }
    return null;
}

export async function findBestStreams(tmdbShow, season, episode, newTorrents, cachedTorrents) {
    const streams = [];
    const cachedStreams = [];

    // Process cached torrents first
    for (const torrent of cachedTorrents) {
        const file = findFileInTorrentInfo(torrent.rd_torrent_info_json, season, episode);
        if (file) {
            cachedStreams.push({
                infoHash: torrent.infohash,
                torrentName: torrent.rd_torrent_info_json.filename,
                seeders: torrent.seeders,
                language: torrent.language,
                quality: torrent.quality,
                isCached: true,
            });
        }
    }

    // Process new torrents from Bitmagnet search using the detailed algorithm
    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;

        logger.debug(`[MATCHER] Evaluating torrent: "${torrentData.name}"`);

        // Step 1: Check title similarity
        const titleSimilarity = getTitleSimilarity(tmdbShow.name, torrentData.name);
        logger.debug(`[MATCHER] -> Similarity score: ${titleSimilarity.toFixed(2)} (Threshold: ${SIMILARITY_THRESHOLD})`);

        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER] -> REJECTED: Low title similarity.`);
            continue;
        }

        // Step 2: Attempt to match at the torrent name level
        const torrentInfo = PTT.parse(torrentData.name);
        if (torrentInfo.season === season && torrentInfo.episode === episode) {
            logger.debug(`[MATCHER] -> ACCEPTED: Direct match on torrent name.`);
            streams.push({
                infoHash: torrent.infoHash,
                fileIndex: 0, // For single-file torrents or packs where the name is specific
                torrentName: torrentData.name,
                seeders: torrent.seeders,
                language: torrent.languages?.[0]?.id || 'en',
                quality: getQuality(torrent.videoResolution),
                isCached: false,
            });
            continue; // Move to the next torrent
        }

        // Step 3: If title similarity is high but no S/E match, dive into files
        logger.debug(`[MATCHER] -> Title similar, but S/E mismatch. Diving into files...`);
        const files = await getTorrentFiles(torrent.infoHash);
        if (!files || files.length === 0) {
            logger.debug(`[MATCHER] -> REJECTED: No files found for this torrent.`);
            continue;
        }

        for (const file of files) {
            if (file.fileType !== 'video') continue;

            logger.debug(`[MATCHER] -> Checking file: "${file.path}"`);
            const fileInfo = PTT.parse(file.path);

            if (fileInfo.season === season && fileInfo.episode === episode) {
                logger.debug(`[MATCHER] -> ACCEPTED: Found matching file inside torrent.`);
                streams.push({
                    infoHash: torrent.infoHash,
                    fileIndex: file.index,
                    torrentName: torrentData.name, // Still use the main name for context
                    seeders: torrent.seeders,
                    language: torrent.languages?.[0]?.id || 'en',
                    quality: getQuality(torrent.videoResolution),
                    isCached: false,
                });
                break; // Found our match, no need to check other files in this torrent
            }
        }
    }
    return { streams, cachedStreams };
}

export function sortAndFilterStreams(streams, cachedStreams, preferredLanguages) {
    const langIndexMap = new Map(preferredLanguages.map((lang, i) => [lang, i]));
    const getLangPriority = (lang) => langIndexMap.has(lang) ? langIndexMap.get(lang) : Infinity;

    const sortFn = (a, b) => {
        const langPriorityA = getLangPriority(a.language);
        const langPriorityB = getLangPriority(b.language);
        if (langPriorityA !== langPriorityB) return langPriorityA - langPriorityB;

        const qualityA = QUALITY_ORDER[a.quality] || 99;
        const qualityB = QUALITY_ORDER[b.quality] || 99;
        if (qualityA !== qualityB) return qualityA - qualityB;

        return b.seeders - a.seeders;
    };

    streams.sort(sortFn);
    cachedStreams.sort(sortFn);

    const filteredStreams = [];
    const counts = {};
    for (const stream of streams) {
        const key = `${stream.language}_${stream.quality}`;
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] <= 2) {
            filteredStreams.push(stream);
        }
    }

    // Prepend cached streams to the very top, also sorted
    return [...cachedStreams, ...filteredStreams];
}
