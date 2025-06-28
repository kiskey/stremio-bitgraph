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

// --- UPDATED LANGUAGE DETECTION ---
function getBestLanguage(torrentLanguages, preferredLanguages) {
    // Case 1: Torrent has no language data from Bitmagnet. Default to 'en'.
    if (!torrentLanguages || torrentLanguages.length === 0) {
        return 'en';
    }

    // Case 2: User has provided preferences. Find the best match.
    if (preferredLanguages.length > 0) {
        const torrentLangCodes = new Set(torrentLanguages.map(l => l.id));
        for (const prefLang of preferredLanguages) {
            if (torrentLangCodes.has(prefLang)) {
                return prefLang; // Return highest-priority match
            }
        }
    }

    // Case 3: User has no preferences, OR their preferences didn't match.
    // In this case, just return the first language the torrent actually lists.
    return torrentLanguages[0].id;
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

export async function findBestStreams(tmdbShow, season, episode, newTorrents, cachedTorrents, preferredLanguages) {
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

    // Process new torrents from Bitmagnet search
    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;

        logger.debug(`[MATCHER] Evaluating torrent: "${torrentData.name}"`);

        const titleSimilarity = getTitleSimilarity(tmdbShow.name, torrentData.name);
        logger.debug(`[MATCHER] -> Similarity score: ${titleSimilarity.toFixed(2)} (Threshold: ${SIMILARITY_THRESHOLD})`);

        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER] -> REJECTED: Low title similarity.`);
            continue;
        }
        
        const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
        logger.debug(`[MATCHER] -> Detected language as "${bestLanguage}" based on user preferences.`);

        const torrentInfo = PTT.parse(torrentData.name);
        if (torrentInfo.season === season && torrentInfo.episode === episode) {
            logger.debug(`[MATCHER] -> ACCEPTED: Direct match on torrent name.`);
            streams.push({
                infoHash: torrent.infoHash,
                fileIndex: 0,
                torrentName: torrentData.name,
                seeders: torrent.seeders,
                language: bestLanguage,
                quality: getQuality(torrent.videoResolution),
                isCached: false,
            });
            continue;
        }

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
                    torrentName: torrentData.name,
                    seeders: torrent.seeders,
                    language: bestLanguage,
                    quality: getQuality(torrent.videoResolution),
                    isCached: false,
                });
                break;
            }
        }
    }
    return { streams, cachedStreams };
}

export function sortAndFilterStreams(streams, cachedStreams, preferredLanguages) {
    const langIndexMap = new Map(preferredLanguages.map((lang, i) => [lang, i]));
    const getLangPriority = (lang) => langIndexMap.has(lang) ? langIndexMap.get(lang) : Infinity;

    const sortFn = (a, b) => {
        // --- CORRECTED: Only sort by language if preferences are provided ---
        if (preferredLanguages.length > 0) {
            const langPriorityA = getLangPriority(a.language);
            const langPriorityB = getLangPriority(b.language);
            if (langPriorityA !== langPriorityB) {
                return langPriorityA - langPriorityB;
            }
        }

        // Fallback sorting for all cases (no preference, or same preference)
        const qualityA = QUALITY_ORDER[a.quality] || 99;
        const qualityB = QUALITY_ORDER[b.quality] || 99;
        if (qualityA !== qualityB) {
            return qualityA - qualityB;
        }

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

    return [...cachedStreams, ...filteredStreams];
}
