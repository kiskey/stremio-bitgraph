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

    // 1. Remove anything inside special CJK brackets 【】
    sanitized = sanitized.replace(/【.*?】/g, ' ');

    // 2. Remove sequences of non-Latin script characters
    sanitized = sanitized.replace(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Thai}]+/gu,
        ' '
    );

    // 3. Remove [ ... ] if it contains any non-English (non-alphanumeric/dash/space) characters
    sanitized = sanitized.replace(/\[.*?[^\w\s\-].*?\]/g, ' ');

    // 4. Remove URLs, domains, or emails
    sanitized = sanitized.replace(/\b(https?:\/\/\S+|www\.\S+\.\w+|[\w.-]+@[\w.-]+)\b/gi, ' ');

    // 4b. Clean up stray hyphens or dashes left from domain removal
    sanitized = sanitized.replace(/^\s*[-–—]+\s*|\s*[-–—]+\s*$/g, ' ');
    sanitized = sanitized.replace(/\s+[-–—]+\s+/g, ' ');

    // 5. Replace . and _ with space (but keep -)
    sanitized = sanitized.replace(/[._]/g, ' ');

    // 6. Collapse multiple spaces and trim
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
}

// R10: Fixed robust parsing function to correctly handle episode ranges.
export function robustParseInfo(title, fallbackSeason = null) {
    const sanitizedTitle = sanitizeName(title);
    const pttResult = PTT.parse(sanitizedTitle);
    let { season, episode } = pttResult;

    // Use fallback season if PTT fails for season
    if (season === undefined && fallbackSeason !== null) {
        season = fallbackSeason;
    }

    // If PTT got both, we are done.
    if (season !== undefined && episode !== undefined) {
        return { ...pttResult, season, episode };
    }

    // --- REGEX FALLBACKS ---
    const regexSanitized = sanitizedTitle
        .replace(/[()\[\]]/g, ' ')
        .replace(/[–×]/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase();

    const regexes = [
        { re: /season[._\s-]*(\d{1,2})[._\s-]*episode[._\s-]*(\d{1,2})/, s: 1, e: 2 },
        { re: /season[._\s-]*(\d{1,2})[._\s-]*ep[._\s-]*(\d{1,2})/, s: 1, e: 2 },
        { re: /season[._\s-]*(\d{1,2})[._\s-]*e[._\s-]*(\d{1,2})/, s: 1, e: 2 },
        { re: /[sS](\d{1,2})[._\s-]*[eE](\d{1,2})/, s: 1, e: 2 },
        { re: /[sS](\d{1,2})[._\s-]*[eE][pP][._\s-]*(\d{1,2})/, s: 1, e: 2 },
        { re: /\b(\d{1,2})[xX](\d{1,2})\b/, s: 1, e: 2 },
        { re: /\b(?<!\d)(\d)(\d{2})\b/, s: 1, e: 2 },
        { re: /\b(\d{1,2})\.(\d{2})\b/, s: 1, e: 2 },
    ];

    for (const { re, s: s_idx, e: e_idx } of regexes) {
        const match = regexSanitized.match(re);
        if (match) {
            if (season === undefined && s_idx) season = parseInt(match[s_idx], 10);
            if (episode === undefined && e_idx) episode = parseInt(match[e_idx], 10);
        }
        if (season !== undefined && episode !== undefined) break;
    }

    // Last-ditch effort for season or episode if one is still missing
    if (season === undefined) {
        const seasonMatch = regexSanitized.match(/\b[sS](\d{1,2})\b/);
        if (seasonMatch) season = parseInt(seasonMatch[1], 10);
    }
    if (episode === undefined) {
        // R10 FIX: This regex now uses a negative lookahead `(?![-\d])` to ensure it doesn't match
        // the start of a range (e.g., "01" in "01-07").
        const episodeMatch = regexSanitized.match(/\b[eE][pP]?[._\s-]*(\d{1,2})(?![-\d])/);
        if (episodeMatch) {
            episode = parseInt(episodeMatch[1], 10);
            logger.debug(`[ROBUST-PARSER] Last-ditch episode regex found: ${episode}`);
        }
    }
    
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
