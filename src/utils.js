import winston from 'winston';
import { LOG_LEVEL } from '../config.js';

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

// --- FINAL, PRODUCTION-READY SANITIZATION FUNCTION ---
export function sanitizeName(name) {
    let sanitized = name;

    // 1. Remove URLs and email addresses
    sanitized = sanitized.replace(/\b(https?:\/\/\S+|www\.\S+\.\w+|[\w.-]+@[\w.-]+)\b/gi, ' ');

    // 2. Remove CJK characters and symbols. This is a more comprehensive range.
    sanitized = sanitized.replace(/[\u2E80-\u9FFF【】]/g, ' ');

    // 3. Remove bracketed content that is likely metadata (e.g., [10集], [ExYuSubs])
    // This looks for brackets containing mostly non-alphanumeric characters, or common keywords.
    sanitized = sanitized.replace(/\[([^a-zA-Z0-9]*|subs?|web|dl|rip|hd|x264|x265|h264|h265)\]/gi, ' ');

    // 4. Replace common separators with spaces.
    sanitized = sanitized.replace(/[._-]/g, ' ');

    // 5. Remove any remaining bracket characters.
    sanitized = sanitized.replace(/[\[\]()]/g, ' ');

    // 6. Clean up multiple spaces and trim any leading/trailing spaces or separators.
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
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
}
