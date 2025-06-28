import PTT from 'parse-torrent-title';
import stringSimilarity from 'string-similarity';
import { SIMILARITY_THRESHOLD, STRICT_LANGUAGE_FILTER } from '../config.js';
import { getTorrentFiles } from './bitmagnet.js';
import { logger, QUALITY_ORDER, getQuality } from './utils.js';

function getTitleSimilarity(tmdbTitle, torrentName) {
    if (!tmdbTitle) return 0;
    const parsed = PTT.parse(torrentName);
    if (!parsed.title) return 0;
    return stringSimilarity.compareTwoStrings(tmdbTitle.toLowerCase(), parsed.title.toLowerCase());
}

export function getBestLanguage(torrentLanguages, preferredLanguages) {
    if (!torrentLanguages || torrentLanguages.length === 0) return 'en';
    if (preferredLanguages.length > 0) {
        const torrentLangCodes = new Set(torrentLanguages.map(l => l.id));
        for (const prefLang of preferredLanguages) {
            if (torrentLangCodes.has(prefLang)) return prefLang;
        }
    }
    return torrentLanguages[0].id || 'en';
}

export function findFileInTorrentInfo(torrentInfo, season, episode) {
    for (const file of torrentInfo.files) {
        const fileInfo = PTT.parse(file.path);
        if (fileInfo.season === season && fileInfo.episode === episode) return file;
    }
    return null;
}

// Renamed for clarity
export async function findBestSeriesStreams(tmdbShow, season, episode, newTorrents, cachedTorrents, preferredLanguages) {
    const streams = [];
    const cachedStreams = [];

    for (const torrent of cachedTorrents) {
        if (findFileInTorrentInfo(torrent.rd_torrent_info_json, season, episode)) {
            cachedStreams.push({ infoHash: torrent.infohash, torrentName: torrent.rd_torrent_info_json.filename, seeders: torrent.seeders, language: torrent.language, quality: torrent.quality, isCached: true });
        }
    }

    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;
        if (getTitleSimilarity(tmdbShow.name, torrentData.name) < SIMILARITY_THRESHOLD) continue;
        
        const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
        const torrentInfo = PTT.parse(torrentData.name);
        if (torrentInfo.season === season && torrentInfo.episode === episode) {
            streams.push({ infoHash: torrent.infoHash, fileIndex: 0, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), isCached: false });
            continue;
        }

        const files = await getTorrentFiles(torrent.infoHash);
        if (!files || files.length === 0) continue;
        for (const file of files) {
            if (file.fileType !== 'video') continue;
            const fileInfo = PTT.parse(file.path);
            if (fileInfo.season === season && fileInfo.episode === episode) {
                streams.push({ infoHash: torrent.infoHash, fileIndex: file.index, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), isCached: false });
                break;
            }
        }
    }
    return { streams, cachedStreams };
}

// NEW: Dedicated matcher for movies
export async function findBestMovieStreams(tmdbMovie, newTorrents, cachedTorrents, preferredLanguages) {
    const streams = [];
    const cachedStreams = [];

    for (const torrent of cachedTorrents) {
        cachedStreams.push({ infoHash: torrent.infohash, torrentName: torrent.rd_torrent_info_json.filename, seeders: torrent.seeders, language: torrent.language, quality: torrent.quality, isCached: true });
    }

    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;

        const titleSimilarity = getTitleSimilarity(tmdbMovie.title, torrentData.name);
        const parsedInfo = PTT.parse(torrentData.name);
        const yearMatch = !parsedInfo.year || parsedInfo.year == new Date(tmdbMovie.release_date).getFullYear();

        if (titleSimilarity >= SIMILARITY_THRESHOLD && yearMatch) {
            const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
            streams.push({ infoHash: torrent.infoHash, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), isCached: false });
        }
    }
    return { streams, cachedStreams };
}

export function sortAndFilterStreams(streams, cachedStreams, preferredLanguages) {
    let allStreams = [...cachedStreams, ...streams];

    // NEW: Optional strict language filtering
    if (STRICT_LANGUAGE_FILTER && preferredLanguages.length > 0) {
        const prefLangSet = new Set(preferredLanguages);
        allStreams = allStreams.filter(stream => prefLangSet.has(stream.language));
        logger.debug(`[MATCHER] Applied strict language filter. Kept ${allStreams.length} streams.`);
    }

    const langIndexMap = new Map(preferredLanguages.map((lang, i) => [lang, i]));
    const getLangPriority = (lang) => langIndexMap.has(lang) ? langIndexMap.get(lang) : Infinity;

    allStreams.sort((a, b) => {
        if (a.isCached && !b.isCached) return -1;
        if (!a.isCached && b.isCached) return 1;
        
        if (preferredLanguages.length > 0) {
            const langPriorityA = getLangPriority(a.language);
            const langPriorityB = getLangPriority(b.language);
            if (langPriorityA !== langPriorityB) return langPriorityA - langPriorityB;
        }
        const qualityA = QUALITY_ORDER[a.quality] || 99;
        const qualityB = QUALITY_ORDER[b.quality] || 99;
        if (qualityA !== qualityB) return qualityA - qualityB;
        return b.seeders - a.seeders;
    });

    const finalStreams = [];
    const counts = {};
    for (const stream of allStreams) {
        const key = `${stream.language}_${stream.quality}`;
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] <= 2) {
            finalStreams.push(stream);
        }
    }
    return finalStreams;
}
