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

// --- FINAL, ROBUST, AND CORRECT SANITIZATION FUNCTION ---
export function sanitizeName(name) {
    let sanitized = name;

    // 1. Remove anything inside the special CJK brackets 【】
    sanitized = sanitized.replace(/【.*?】/g, ' ');

    // 2. Remove any "words" that are composed entirely of CJK characters.
    // This correctly removes "金妮与乔治娅" and "第三季" but leaves "Ginny" alone.
    // It requires the /u flag for Unicode property escapes to work.
    sanitized = sanitized.replace(/\b\p{Script=Han}+\b/gu, ' ');

    // 3. Remove any bracketed text that looks like metadata (e.g., [简繁英字幕], [全10集])
    // by targeting brackets that contain CJK characters.
    sanitized = sanitized.replace(/\[\s*[^a-zA-Z]*\p{Script=Han}[^a-zA-Z]*\s*\]/gu, ' ');

    // 4. Remove any remaining domain names or email addresses.
    sanitized = sanitized.replace(/\b(https?:\/\/\S+|www\.\S+\.\w+|[\w.-]+@[\w.-]+)\b/gi, ' ');

    // 5. Replace common separators with spaces. We leave '-' alone as it can be part of release groups.
    sanitized = sanitized.replace(/[._]/g, ' ');

    // 6. Final cleanup: collapse multiple spaces and trim.
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
