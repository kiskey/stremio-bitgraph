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

async function findBestFileMatch(files, season, episode) {
    if (!files || files.length === 0) {
        return null;
    }

    let bestMatch = null;
    let highestScore = -1;

    for (const file of files) {
        // Only consider video files
        if (file.fileType !== 'video') {
            continue;
        }

        const fileInfo = PTT.parse(file.path);

        if (fileInfo.season === season && fileInfo.episode === episode) {
            const score = file.size; // Use size as a tie-breaker, bigger is often better
            if (score > highestScore) {
                highestScore = score;
                bestMatch = { file, fileInfo };
            }
        }
    }
    return bestMatch;
}

export async function findBestStreams(tmdbShow, season, episode, torrents) {
    const matchedStreams = [];

    for (const torrent of torrents) {
        const titleSimilarity = getTitleSimilarity(tmdbShow.name, torrent.name);

        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            continue; // Skip torrents with low title similarity
        }

        const torrentInfo = PTT.parse(torrent.name);

        // Case 1: Torrent is a single episode file
        if (torrent.filesStatus === 'single' && torrentInfo.season === season && torrentInfo.episode === episode) {
            matchedStreams.push({
                infoHash: torrent.infoHash,
                fileIndex: 0, // In single file torrents, index is usually 0
                name: `[${getQuality(torrent.videoResolution)}] ${torrent.name}`,
                torrentName: torrent.name,
                parsedInfo: torrentInfo,
                seeders: torrent.seeders,
                language: torrent.languages?.[0]?.id || 'en', // Default to 'en'
                quality: getQuality(torrent.videoResolution),
            });
            continue;
        }

        // Case 2: Torrent is a pack, need to check files
        if (torrent.filesStatus === 'multi' || torrent.filesStatus === 'over_threshold') {
            const files = await getTorrentFiles(torrent.infoHash);
            const bestFile = await findBestFileMatch(files, season, episode);

            if (bestFile) {
                matchedStreams.push({
                    infoHash: torrent.infoHash,
                    fileIndex: bestFile.file.index,
                    name: `[${getQuality(torrent.videoResolution)}] ${bestFile.file.path}`,
                    torrentName: torrent.name,
                    parsedInfo: bestFile.fileInfo,
                    seeders: torrent.seeders,
                    language: torrent.languages?.[0]?.id || 'en',
                    quality: getQuality(torrent.videoResolution),
                });
            }
        }
    }
    return matchedStreams;
}

export function sortAndFilterStreams(streams, cachedStreams, preferredLanguages) {
    // 1. Prioritize by language
    const langIndexMap = new Map(preferredLanguages.map((lang, i) => [lang, i]));
    const getLangPriority = (lang) => langIndexMap.has(lang) ? langIndexMap.get(lang) : Infinity;

    streams.sort((a, b) => {
        const langPriorityA = getLangPriority(a.language);
        const langPriorityB = getLangPriority(b.language);
        if (langPriorityA !== langPriorityB) return langPriorityA - langPriorityB;

        // 2. Prioritize by quality
        const qualityA = QUALITY_ORDER[a.quality] || 99;
        const qualityB = QUALITY_ORDER[b.quality] || 99;
        if (qualityA !== qualityB) return qualityA - qualityB;

        // 3. Prioritize by seeders
        return b.seeders - a.seeders;
    });

    // 4. Filter to max 2 results per quality, per language bucket
    const filteredStreams = [];
    const counts = {}; // { "en_1080p": 1, "en_720p": 2, ... }

    for (const stream of streams) {
        const key = `${stream.language}_${stream.quality}`;
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] <= 2) {
            filteredStreams.push(stream);
        }
    }

    // 5. Prepend cached streams to the very top, sorted by quality
    cachedStreams.sort((a, b) => {
        const qualityA = QUALITY_ORDER[a.quality] || 99;
        const qualityB = QUALITY_ORDER[b.quality] || 99;
        return qualityA - qualityB;
    });

    return [...cachedStreams, ...filteredStreams];
}
