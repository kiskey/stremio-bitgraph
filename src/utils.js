import winston from 'winston';
import { LOG_LEVEL } from '../config.js';
import PTT from 'parse-torrent-title';

export const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
            ),
        }),
    ],
});

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function formatSize(bytes) {
    if (!bytes || bytes === 0) return 'N/A';
    const gb = bytes / 1e9;
    return `${gb.toFixed(2)} GB`;
}

export function sanitizeName(name) {
    let sanitized = name;
    sanitized = sanitized.replace(/【.*?】/g, ' ');
    sanitized = sanitized.replace(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Thai}]+/gu,
        ' '
    );
    sanitized = sanitized.replace(/\[.*?[^\w\s\-].*?\]/g, ' ');
    sanitized = sanitized.replace(/\b(https?:\/\/\S+|www\.\S+\.\w+|[\w.-]+@[\w.-]+)\b/gi, ' ');
    sanitized = sanitized.replace(/^\s*[-–—]+\s*|\s*[-–—]+\s*$/g, ' ');
    sanitized = sanitized.replace(/\s+[-–—]+\s+/g, ' ');
    sanitized = sanitized.replace(/[._]/g, ' ');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    return sanitized;
}

// R21: Enhanced range detection regex to handle plural 'episodes'.
export function robustParseInfo(title, fallbackSeason = null) {
    const sanitizedTitle = sanitizeName(title);
    const pttResult = PTT.parse(sanitizedTitle);
    
    let { season, episode } = pttResult;
    
    logger.debug(`[ROBUST-PARSER] Initial PTT for "${sanitizedTitle}": season=${season}, episode=${episode}`);

    // R21 FIX IS HERE: `episodes?` now matches both "episode" and "episodes".
    const rangeRegex = /(episodes?|ep|e)[\s._-]*[\[(]?\s*\d{1,2}[\s._-]*?-[\s._-]*?\d{1,2}\s*[\])]?/i;
    if (rangeRegex.test(sanitizedTitle)) {
        logger.debug(`[ROBUST-PARSER] Detected episode range in "${sanitizedTitle}". Forcing episode to undefined.`);
        episode = undefined;
    }

    // If PTT found both and we didn't override, our job is done.
    if (season !== undefined && episode !== undefined) {
        return { ...pttResult, season, episode };
    }

    // --- Unified Regex Fallback System ---
    const regexSanitized = sanitizedTitle.toLowerCase().replace(/[()\[\]–×]/g, ' ');

    const regexList = [
        { re: /season[._\s-]*(\d{1,2})[._\s-]*episode[._\s-]*(\d{1,2})/i, s: 1, e: 2 },
        { re: /season[._\s-]*(\d{1,2})[._\s-]*ep[._\s-]*(\d{1,2})/i, s: 1, e: 2 },
        { re: /[sStT](\d{1,2})[._\s-]*[eE](\d{1,2})/i, s: 1, e: 2 },
        { re: /[sStT](\d{1,2})[._\s-]*[eE][pP](\d{1,2})/i, s: 1, e: 2 },
        { re: /\b(\d{1,2})[xX](\d{1,2})\b/i, s: 1, e: 2 },
        { re: /season[._\s-]*(\d{1,2})/i, s: 1, e: null },
        { re: /\b[sStT](\d{1,2})\b/i, s: 1, e: null },
        { re: /\b[eE][pP]?[._\s-]*(\d{1,2})\b/i, s: null, e: 1 },
    ];

    for (const { re, s: s_idx, e: e_idx } of regexList) {
        if ((season !== undefined && episode !== undefined) || (e_idx && rangeRegex.test(sanitizedTitle))) continue;

        const match = regexSanitized.match(re);
        if (match) {
            if (season === undefined && s_idx !== null && match[s_idx]) {
                season = parseInt(match[s_idx], 10);
                logger.debug(`[ROBUST-PARSER] Found season=${season} with regex: ${re}`);
            }
            if (episode === undefined && e_idx !== null && match[e_idx]) {
                episode = parseInt(match[e_idx], 10);
                logger.debug(`[ROBUST-PARSER] Found episode=${episode} with regex: ${re}`);
            }
        }
    }
    
    if (season === undefined && fallbackSeason !== null) {
        season = fallbackSeason;
    }

    logger.debug(`[ROBUST-PARSER] Final result: season=${season}, episode=${episode}`);
    return { ...pttResult, season, episode };
}


export const QUALITY_ORDER = {
    '4k': 1, '2160p': 1, '1080p': 2, '720p': 3, '480p': 4, '360p': 5, 'sd': 6,
};

export const getQuality = (resolution) => {
    if (!resolution) return 'sd';
    const res = resolution.toLowerCase();
    if (res.includes('2160') || res.includes('4k')) return '4k';
    if (res.includes('1080')) return '1080p';
    if (res.includes('720')) return '720p';
    if (res.includes('480')) return '480p';
    if (res.includes('360')) return '360p';
    return 'sd';
};
