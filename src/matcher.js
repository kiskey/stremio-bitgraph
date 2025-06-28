import PTT from 'parse-torrent-title';
import stringSimilarity from 'string-similarity';
import { SIMILARITY_THRESHOLD } from '../config.js';
import { getTorrentFiles } from './bitmagnet.js';
import { logger, QUALITY_ORDER, getQuality } from './utils.js';

function getTitleSimilarity(tmdbShow, torrentName) {
    // tmdbShow can be null if we are only processing cached results
    if (!tmdbShow) return 0;
    const parsed = PTT.parse(torrentName);
    if (!parsed.title) return 0;
    return stringSimilarity.compareTwoStrings(tmdbShow.name.toLowerCase(), parsed.title.toLowerCase());
}

export function getBestLanguage(torrentLanguages, preferredLanguages) {
    if (!torrentLanguages || torrentLanguages.length === 0) {
        return 'en';
    }
    if (preferredLanguages.length > 0) {
        const torrentLangCodes = new Set(torrentLanguages.map(l => l.id));
        for (const prefLang of preferredLanguages) {
            if (torrentLangCodes.has(prefLang)) {
                return prefLang;
            }
        }
    }
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

    // --- CORRECTED CACHING LOGIC ---
    // Process cached torrents first and check if they contain the *currently requested* episode.
    for (const torrent of cachedTorrents) {
        const file = findFileInTorrentInfo(torrent.rd_torrent_info_json, season, episode);
        if (file) {
            logger.debug(`[MATCHER] Found S${season}E${episode} in cached torrent: "${torrent.rd_torrent_info_json.filename}"`);
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

    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;

        logger.debug(`[MATCHER] Evaluating new torrent: "${torrentData.name}"`);

        const titleSimilarity = getTitleSimilarity(tmdbShow, torrentData.name);
        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER] -> REJECTED: Low title similarity.`);
            continue;
        }
        
        const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
        const torrentInfo = PTT.parse(torrentData.name);
        if (torrentInfo.season === season && torrentInfo.episode === episode) {
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

        const files = await getTorrentFiles(torrent.infoHash);
        if (!files || files.length === 0) continue;

        for (const file of files) {
            if (file.fileType !== 'video') continue;
            const fileInfo = PTT.parse(file.path);
            if (fileInfo.season === season && fileInfo.episode === episode) {
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
        if (preferredLanguages.length > 0) {
            const langPriorityA = getLangPriority(a.language);
            const langPriorityB = getLangPriority(b.language);
            if (langPriorityA !== langPriorityB) {
                return langPriorityA - langPriorityB;
            }
        }
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
