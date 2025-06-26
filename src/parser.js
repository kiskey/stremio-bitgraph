const PTT = require('parse-torrent-title');

const METADATA_MODEL = {
    title: null,
    year: null,
    season: null,
    episode: null,
    resolution: null,
    codec: null,
    audio: null,
    language: null,
    group: null,
};

function parse(title) {
    const parsed = PTT.parse(title);

    // Simple regex fallback for season/episode if PTT fails
    if (!parsed.season) {
        const se_match = title.match(/s(\d{1,2})e(\d{1,2})/i)
                      || title.match(/(\d{1,2})x(\d{1,2})/i);
        if (se_match) {
            parsed.season = parseInt(se_match[1], 10);
            parsed.episode = parseInt(se_match[2], 10);
        }
    }

    // Normalize against our model
    const normalized = { ...METADATA_MODEL };
    for (const key in normalized) {
        if (parsed[key] !== undefined) {
            normalized[key] = parsed[key];
        }
    }
    return normalized;
}

// Scores how well a torrent title matches the official search title
function getFuzzyScore(torrentTitle, officialTitle) {
    if (!torrentTitle || !officialTitle) return 0;

    const torrentWords = new Set(torrentTitle.toLowerCase().split(' '));
    const officialWords = officialTitle.toLowerCase().split(' ');
    
    let matchCount = 0;
    for (const word of officialWords) {
        if (torrentWords.has(word)) {
            matchCount++;
        }
    }
    return matchCount / officialWords.length;
}

module.exports = { parse, getFuzzyScore };
