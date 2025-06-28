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

// --- NEW, MORE INTELLIGENT SANITIZATION FUNCTION ---
export function sanitizeName(name) {
    let sanitized = name;

    // 1. Remove known website prefixes that are often outside brackets.
    // This looks for "www.domain.tld - " and removes it.
    sanitized = sanitized.replace(/www\.\S+\.\w+\s*-\s*/gi, ' ');

    // 2. Remove bracketed website/release group prefixes.
    // This looks for "[ some.thing ]" at the beginning of the string.
    sanitized = sanitized.replace(/^\[.*?\]\s*/, ' ');

    // 3. Remove CJK (Chinese, Japanese, Korean) characters, which often contain ads or metadata.
    sanitized = sanitized.replace(/[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\u3400-\u4dbf]/g, ' ');

    // 4. Remove the bracket characters themselves, but LEAVE the content inside.
    // This is the key change that fixes the bug you found.
    sanitized = sanitized.replace(/[\[\]【】]/g, ' ');

    // 5. Replace common separators with spaces to help PTT parse correctly.
    sanitized = sanitized.replace(/[._-]/g, ' ');

    // 6. Clean up any resulting multiple spaces.
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
