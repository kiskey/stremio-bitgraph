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

export function sanitizeName(name) {
    let sanitized = name;

    // 1. Remove anything inside special CJK brackets 【】
    sanitized = sanitized.replace(/【.*?】/g, ' ');

    // 2. Remove sequences of non-Latin script characters
    sanitized = sanitized.replace(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Thai}]+/gu,
        ' '
    );

    // 3. Remove [ ... ] if it contains any non-ASCII character (i.e., non-English content)
    sanitized = sanitized.replace(/\[[^\[\]]*[^\u0000-\u007F][^\[\]]*\]/g, ' ');

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
