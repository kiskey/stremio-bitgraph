import winston from 'winston';

// Setup logger
export const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            ),
        }),
    ],
});

// Sleep utility for exponential backoff
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Quality sorting map
export const QUALITY_ORDER = {
    '4k': 1,
    '2160p': 1,
    '1080p': 2,
    '720p': 3,
    '480p': 4,
    '360p': 5,
    'sd': 6,
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
