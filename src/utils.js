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

// R13: Rewritten robust parsing function based on log evidence.
export function robustParseInfo(title, fallbackSeason = null) {
    const sanitizedTitle = sanitizeName(title);
    const pttResult = PTT.parse(sanitizedTitle);
    
    let season = pttResult.season;
    let episode = pttResult.episode;
    
    logger.debug(`[ROBUST-PARSER] PTT result for "${sanitizedTitle}": season=${season}, episode=${episode}`);

    // If PTT found both, our job is done.
    if (season !== undefined && episode !== undefined) {
        return { ...pttResult, season, episode };
    }

    // --- LOGIC CORRECTION ---
    // The previous logic was flawed. We now check for ranges and apply fallbacks correctly.
    const regexSanitized = sanitizedTitle.toLowerCase().replace(/[()\[\]]/g, ' ');
    
    // Step 1: Check for an episode range. If one exists, episode MUST be undefined.
    const rangeRegex = /\b\d{1,2}[._\s-]*-[._\s-]*\d{1,2}\b/;
    if (rangeRegex.test(regexSanitized)) {
        logger.debug(`[ROBUST-PARSER] Detected episode range. Ensuring episode is treated as undefined.`);
        episode = undefined;
    }

    // Step 2: If season is missing, try to find it.
    if (season === undefined) {
        const seasonRegexes = [
            /season[._\s-]*(\d{1,2})/,
            /\b[sS](\d{1,2})\b/
        ];
        for (const re of seasonRegexes) {
            const match = regexSanitized.match(re);
            if (match) {
                season = parseInt(match[1], 10);
                logger.debug(`[ROBUST-PARSER] Found season=${season} with regex.`);
                break;
            }
        }
    }

    // Step 3: If episode is still missing AND it's not a range pack, try to find it.
    if (episode === undefined && !rangeRegex.test(regexSanitized)) {
        const episodeRegexes = [
             // Full words: episode 03
            /episode[._\s-]*(\d{1,2})/,
            // S01E03, s01e03
            /[sS]\d{1,2}[._\s-]*[eE](\d{1,2})/,
            // S01EP03, s01ep03
            /[sS]\d{1,2}[._\s-]*[eE][pP](\d{1,2})/,
             // 1x03, 1x03
            /\b\d{1,2}[xX](\d{1,2})\b/,
            // standalone E03, ep03
            /\b[eE][pP]?[._\s-]*(\d{1,2})\b/,
        ];
        for (const re of episodeRegexes) {
            // For regexes that capture season and episode, we need the second capture group.
            const captureGroup = re.source.includes('[sS]') || re.source.includes('xX') ? 2 : 1;
            const match = regexSanitized.match(re);
            if (match && match[captureGroup]) {
                episode = parseInt(match[captureGroup], 10);
                logger.debug(`[ROBUST-PARSER] Found episode=${episode} with regex.`);
                break;
            }
        }
    }
    
    // Apply fallback season if necessary
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
