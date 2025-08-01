import PTT from 'parse-torrent-title';
import stringSimilarity from 'string-similarity';
import { SIMILARITY_THRESHOLD, STRICT_LANGUAGE_FILTER, STREAM_LIMIT_PER_QUALITY } from '../config.js';
import { getTorrentFiles } from './bitmagnet.js';
import { logger, QUALITY_ORDER, getQuality, sanitizeName } from './utils.js';


// ─── Fallback helper for “S01 EP(01–08)” etc ───────────────────────────────
function fallbackParseSeasonPack(title) {
  const m = title.match(/\b(?:S|Season)[\s._-]*0*(\d{1,2})\b/i);
  if (m) return { season: parseInt(m[1], 10), episode: null };
  return { season: null, episode: null };
 }

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
        const fileInfo = PTT.parse(sanitizeName(file.path));
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
        const sanitizedName = sanitizeName(torrentData.name);
        logger.debug(`[MATCHER-SERIES] -> Sanitized to: "${sanitizedName}"`);

        const titleSimilarity = getTitleSimilarity(tmdbShow.name, sanitizedName);
        logger.debug(`[MATCHER-SERIES] -> Similarity score: ${titleSimilarity.toFixed(2)} (Threshold: ${SIMILARITY_THRESHOLD})`);

        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER-SERIES] -> REJECTED: Low title similarity.`);
            continue;
        }
        
        const bestLanguage = getBestLanguage(torrent.languages, preferredLanguages);
        const primary = PTT.parse(sanitizedName);
        logger.debug(`[MATCHER-SERIES] -> PTT found: Season ${primary.season || 'N/A'}, Episode ${primary.episode || 'N/A'}`);
        logger.debug(`[MATCHER-SERIES] -> Full PTT parse result: ${JSON.stringify(primary)}`);
        
        let   topSeason    = primary.season;
        let   topEpisode   = primary.episode;
        if (!topSeason) {
          const fb = fallbackParseSeasonPack(sanitizedName);
          topSeason  = fb.season;
          topEpisode = fb.episode;
          logger.debug(`[MATCHER-SERIES] -> Fallback parse: ${JSON.stringify(fb)}`);
     }

   logger.debug(
       `[MATCHER-SERIES] -> Parsed title => title="${primary.title}", ` +
       `Season=${topSeason||'N/A'}, Episode=${topEpisode||'N/A'}`
     );

        // --- FINAL, CORRECTED LOGIC ---
        // Case 1: Direct match on torrent name.
        if (topSeason === season && topEpisode === episode) {
            logger.debug(`[MATCHER-SERIES] -> ACCEPTED: Direct match on torrent name.`);
            streams.push({ infoHash: torrent.infoHash, fileIndex: 0, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), size: torrentData.size, isCached: false });
            continue;
        }

        // Case 2: PTT found a specific but *different* episode. Reject it.
        if (topSeason && topEpisode) {
            logger.debug(`[MATCHER-SERIES] -> REJECTED: Torrent name is for a different episode (S${topSeason}E${topEpisode}).`);
            continue;
        }

        // Case 3: PTT found a season pack or could not parse an episode number. Dive into files.
        logger.debug(`[MATCHER-SERIES] -> Torrent is a pack or unspecific. Diving into files...`);
        const files = await getTorrentFiles(torrent.infoHash);
        if (!files || files.length === 0) continue;
        for (const file of files) {
            if (file.fileType !== 'video') continue;
            const fileInfo = PTT.parse(sanitizeName(file.path));
            logger.debug(`[MATCHER-SERIES] -> Parsed file "${file.path}" => ${JSON.stringify(fileInfo)}`);
            
            if (fileInfo.season === season && fileInfo.episode === episode) {
                logger.debug(`[MATCHER-SERIES] -> ACCEPTED: Found matching file inside torrent: "${file.path}"`);
                streams.push({ infoHash: torrent.infoHash, fileIndex: file.index, torrentName: torrentData.name, seeders: torrent.seeders, language: bestLanguage, quality: getQuality(torrent.videoResolution), size: torrentData.size, isCached: false });
                break;
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
        const sanitizedName = sanitizeName(torrentData.name);
        logger.debug(`[MATCHER-MOVIE] -> Sanitized to: "${sanitizedName}"`);

        const titleSimilarity = getTitleSimilarity(tmdbMovie.title, sanitizedName);
        logger.debug(`[MATCHER-MOVIE] -> Similarity score: ${titleSimilarity.toFixed(2)} (Threshold: ${SIMILARITY_THRESHOLD})`);
        if (titleSimilarity < SIMILARITY_THRESHOLD) {
            logger.debug(`[MATCHER-MOVIE] -> REJECTED: Low title similarity.`);
            continue;
        }

        const parsedInfo = PTT.parse(sanitizedName);
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
