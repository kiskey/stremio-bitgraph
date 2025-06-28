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
            // Return the file object from the RD JSON, which includes the private link
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

    // Process new torrents from Bitmagnet search
    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        // Avoid reprocessing if we already have it cached
        if (cachedInfoHashes.has(torrent.infoHash)) continue;

        const titleSimilarity = getTitleSimilarity(tmdbShow.name, torrent.name);
        if (titleSimilarity < SIMILARITY_THRESHOLD) continue;

        const torrentInfo = PTT.parse(torrent.name);

        if (torrent.filesStatus === 'single' && torrentInfo.season === season && torrentInfo.episode === episode) {
            streams.push({
                infoHash: torrent.infoHash,
                fileIndex: 0,
                torrentName: torrent.name,
                seeders: torrent.seeders,
                language: torrent.languages?.[0]?.id || 'en',
                quality: getQuality(torrent.videoResolution),
                isCached: false,
            });
            continue;
        }

        if (torrent.filesStatus === 'multi' || torrent.filesStatus === 'over_threshold') {
            const files = await getTorrentFiles(torrent.infoHash);
            const bestFile = files.find(f => {
                const fi = PTT.parse(f.path);
                return f.fileType === 'video' && fi.season === season && fi.episode === episode;
            });

            if (bestFile) {
                streams.push({
                    infoHash: torrent.infoHash,
                    fileIndex: bestFile.index,
                    torrentName: torrent.name,
                    seeders: torrent.seeders,
                    language: torrent.languages?.[0]?.id || 'en',
                    quality: getQuality(torrent.videoResolution),
                    isCached: false,
                });
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

    return [...cachedStreams, ...filteredStreams];
}
