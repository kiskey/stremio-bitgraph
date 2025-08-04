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

// R23: Fully rewritten function with a verifiable, prioritized, multi-stage parsing strategy.
export function robustParseInfo(title, fallbackSeason = null) {
    const sanitizedTitle = sanitizeName(title);
    const pttResult = PTT.parse(sanitizedTitle);
    
    let season = pttResult.season;
    let episode = pttResult.episode;
    
    logger.debug(`[ROBUST-PARSER] Initial PTT for "${sanitizedTitle}": season=${season}, episode=${episode}`);
    
    // If PTT gets a full result, trust it.
    if (season !== undefined && episode !== undefined) {
        logger.debug(`[ROBUST-PARSER] Success: PTT found both season and episode.`);
        return { ...pttResult, season, episode };
    }

    const regexSanitized = sanitizedTitle.toLowerCase().replace(/[()\[\]–×]/g, ' ');

    // --- Stage 1: High-Confidence, Specific Episode Patterns ---
    const highConfidenceRegex = [
        /[sStT](\d{1,2})[._\s-]*[eE](\d{1,2})/i,
        /[sStT](\d{1,2})[._\s-]*[eE][pP](\d{1,2})/i,
        /\b(\d{1,2})[xX](\d{1,2})\b/i,
        /season[._\s-]*(\d{1,2})[._\s-]*episode[._\s-]*(\d{1,2})/i,
    ];
    for (const re of highConfidenceRegex) {
        const match = regexSanitized.match(re);
        if (match) {
            season = parseInt(match[1], 10);
            episode = parseInt(match[2], 10);
            logger.debug(`[ROBUST-PARSER] Success: High-confidence regex matched S=${season}, E=${episode}.`);
            return { ...pttResult, season, episode };
        }
    }

    // --- Stage 2: Pack and Range Detection ---
    const packRegex = [
        /episodes?[\s._-]*[\[(]?\s*\d{1,2}[\s._-]*?-[\s._-]*?\d{1,2}\s*[\])]?/i, // Ep 1-10, Episodes (01-10)
        /\b(complete|season|s\d{1,2})\b/i, // "Complete", "Season 01", S01
    ];
    let isPack = false;
    for (const re of packRegex) {
        if (re.test(regexSanitized)) {
            isPack = true;
            episode = undefined; // Force episode to be undefined for packs
            logger.debug(`[ROBUST-PARSER] Info: Detected as a pack/range with regex: ${re}`);
            break;
        }
    }

    // --- Stage 3: Low-Confidence, Standalone Patterns (only if not a pack) ---
    if (!isPack) {
        if (episode === undefined) {
            const standaloneEpisodeRegex = /\b[eE][pP]?[._\s-]*(\d{1,2})\b/i;
            const match = regexSanitized.match(standaloneEpisodeRegex);
            if (match) {
                episode = parseInt(match[1], 10);
                logger.debug(`[ROBUST-PARSER] Info: Found standalone episode=${episode}.`);
            }
        }
    }
    
    // Find season if it's still missing
    if (season === undefined) {
        const seasonRegex = /\b(?:season|s|t)[\s._-]*(\d{1,2})\b/i;
        const match = regexSanitized.match(seasonRegex);
        if (match) {
            season = parseInt(match[1], 10);
            logger.debug(`[ROBUST-PARSER] Info: Found standalone season=${season}.`);
        }
    }

    // Apply fallback season from parent torrent if we still don't have one.
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
