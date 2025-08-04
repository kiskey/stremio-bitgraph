import stringSimilarity from 'string-similarity';
import { SIMILARITY_THRESHOLD, STRICT_LANGUAGE_FILTER, STREAM_LIMIT_PER_QUALITY } from '../config.js';
import { getTorrentFiles } from './bitmagnet.js';
import PTT from 'parse-torrent-title';
import { logger, QUALITY_ORDER, getQuality, sanitizeName, robustParseInfo } from './utils.js';


function getTitleSimilarity(tmdbTitle, torrentName) {
    if (!tmdbTitle) return 0;
    const parsed = robustParseInfo(torrentName);
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
    const { season: fallbackSeason } = robustParseInfo(torrentInfo.filename);

    for (const file of torrentInfo.files) {
        const fileInfo = robustParseInfo(file.path, fallbackSeason);
        if (fileInfo.season === season && fileInfo.episode === episode) return file;
    }
    return null;
}

export async function findBestSeriesStreams(tmdbShow, season, episode, newTorrents, cachedTorrents, preferredLanguages) {
    const streams = [];
    const cachedStreams = [];

    for (const torrent of cachedTorrents) {
        if (findFileInTorrentInfo(torrent.rd_torrent_info_json, season, episode)) {
            logger.debug(`[MATCHER-SERIES] Found S${season}E${episode} in cached torrent: "${torrent.rd_torrent_info_json.filename}"`);
            cachedStreams.push({ infoHash: torrent.infohash, torrentName: torrent.rd_torrent_info_json.filename, seeders: torrent.seeders, language: torrent.language, quality: torrent.quality, size: torrent.rd_torrent_info_json.bytes, isCached: true });
        }
    }

    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;

        logger.debug(`[MATCHER-SERIES] Evaluating torrent: "${torrentData.name}"`);

        const sanitizedForDiag = sanitizeName(torrentData.name);
        logger.debug(`[DIAGNOSTIC-PTT] Raw PTT result for "${sanitizedForDiag}": ${JSON.stringify(PTT.parse(sanitizedForDiag))}`);

        const titleSimilarity = getTitleSimilarity(tmdbShow.name, torrentData.name);
        logger.debug(`[MATCHER-SERIES] -> Similarity score: ${titleSimilarity.toFixed(2)} (Threshold: ${SIMILARITY_THRESHOLD})`);

        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER-SERIES] -> REJECTED: Low title similarity.`);
            continue;
        }
        
        const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
        
        const parsedInfo = robustParseInfo(torrentData.name);
        const { season: topSeason, episode: topEpisode } = parsedInfo;
        
        logger.debug(
            `[MATCHER-SERIES] -> Robust parse found: Season=${topSeason || 'N/A'}, Episode=${topEpisode || 'N/A'}`
        );

        if (topSeason === season && topEpisode === episode) {
            logger.debug(`[MATCHER-SERIES] -> ACCEPTED: Direct match on torrent name.`);
            streams.push({ infoHash: torrent.infohash, fileIndex: 0, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), size: torrentData.size, isCached: false });
            continue;
        }

        if (topSeason && topEpisode) {
            logger.debug(`[MATCHER-SERIES] -> REJECTED: Torrent name is for a different episode (S${topSeason}E${topEpisode}).`);
            continue;
        }

        if (topSeason === season) {
            logger.debug(`[MATCHER-SERIES] -> Torrent is a pack for the correct season. Checking file readiness and status...`);
            
            if (!torrentData.hasFilesInfo) {
                logger.warn(`[MATCHER-SERIES] -> REJECTED: Torrent pack '${torrentData.name}' has hasFilesInfo=false. Files are not indexed yet.`);
                continue;
            }

            // R30: This is the definitive, state-aware logic gate.
            if (torrentData.filesStatus === 'single') {
                logger.debug(`[MATCHER-SERIES] -> Torrent is 'single' file status. Treating as a single-file pack without a further API call.`);
                // Since this is a single file that is a season pack, it's a valid stream for any episode in that season.
                streams.push({ infoHash: torrent.infoHash, fileIndex: 0, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), size: torrentData.size, isCached: false });
            } else if (torrentData.filesStatus === 'multi') {
                logger.debug(`[MATCHER-SERIES] -> Torrent is 'multi' file status. Diving into files...`);
                const files = await getTorrentFiles(torrent.infoHash);
                if (!files || files.length === 0) {
                    logger.debug(`[MATCHER-SERIES] -> REJECTED: Multi-file pack contains no files according to the API.`);
                    continue;
                }

                const videoFiles = files.filter(f => f.fileType === 'video');
                if (videoFiles.length === 0) {
                    logger.debug(`[MATCHER-SERIES] -> REJECTED: Pack contains no video files.`);
                    continue;
                }

                logger.debug(`[MATCHER-SERIES] -> Found ${videoFiles.length} video file(s) in pack. Searching for S${season}E${episode}.`);

                const matchingFile = videoFiles.find(file => {
                    logger.debug(`[MATCHER-SERIES] -> Checking file path: "${file.path}"`);
                    const fileInfo = robustParseInfo(file.path, topSeason);
                    return fileInfo.season === season && fileInfo.episode === episode;
                });

                if (matchingFile) {
                    logger.debug(`[MATCHER-SERIES] -> ACCEPTED: Found matching file inside pack: "${matchingFile.path}"`);
                    streams.push({ infoHash: torrent.infoHash, fileIndex: matchingFile.index, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), size: torrentData.size, isCached: false });
                } else {
                    logger.debug(`[MATCHER-SERIES] -> REJECTED: Multi-file pack did not contain the requested episode.`);
                }
            } else {
                 logger.warn(`[MATCHER-SERIES] -> REJECTED: Unknown filesStatus '${torrentData.filesStatus}'.`);
            }
        }
    }
    return { streams, cachedStreams };
}

export async function findBestMovieStreams(tmdbMovie, newTorrents, cachedTorrents, preferredLanguages) {
    const streams = [];
    const cachedStreams = [];

    for (const torrent of cachedTorrents) {
        logger.debug(`[MATCHER-MOVIE] Found cached torrent: "${torrent.rd_torrent_info_json.filename}"`);
        cachedStreams.push({ infoHash: torrent.infohash, torrentName: torrent.rd_torrent_info_json.filename, seeders: torrent.seeders, language: torrent.language, quality: torrent.quality, size: torrent.rd_torrent_info_json.bytes, isCached: true });
    }

    const cachedInfoHashes = new Set(cachedTorrents.map(t => t.infohash));
    for (const torrent of newTorrents) {
        const torrentData = torrent.torrent;
        if (!torrentData || cachedInfoHashes.has(torrent.infoHash)) continue;

        logger.debug(`[MATCHER-MOVIE] Evaluating new torrent: "${torrentData.name}"`);

        const titleSimilarity = getTitleSimilarity(tmdbMovie.title, torrentData.name);
        logger.debug(`[MATCHER-MOVIE] -> Similarity score: ${titleSimilarity.toFixed(2)} (Threshold: ${SIMILARITY_THRESHOLD})`);
        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER-SERIES] -> REJECTED: Low title similarity.`);
            continue;
        }
        
        const parsedInfo = robustParseInfo(torrentData.name);
        const tmdbYear = new Date(tmdbMovie.release_date).getFullYear();
        const yearMatch = !parsedInfo.year || parsedInfo.year == tmdbYear;
        logger.debug(`[MATCHER-MOVIE] -> Year match: ${yearMatch} (Torrent: ${parsedInfo.year || 'N/A'}, TMDB: ${tmdbYear})`);
        
        if (!yearMatch) {
            logger.debug(`[MATCHER-MOVIE] -> REJECTED: Year mismatch.`);
            continue;
        }

        logger.debug(`[MATCHER-MOVIE] -> ACCEPTED: Title and year match.`);
        const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
        streams.push({ infoHash: torrent.infoHash, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), size: torrentData.size, isCached: false });
    }
    return { streams, cachedStreams };
}

export function sortAndFilterStreams(streams, cachedStreams, preferredLanguages) {
    let allStreams = [...cachedStreams, ...streams];

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
        if (counts[key] <= STREAM_LIMIT_PER_QUALITY) {
            finalStreams.push(stream);
        }
    }
    return finalStreams;
}
