require('dotenv').config();
const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const path = require('path');
const cors = require('cors'); // <-- 1. IMPORT CORS
const metadata = require('./metadata');
const bitmagnet = require('./bitmagnet');
const parser =require('./parser');
const RealDebridClient = require('./realdebrid');

const { PORT, TMDB_API_KEY, BITMAGNET_GRAPHQL_URL } = process.env;

if (!TMDB_API_KEY || !BITMAGNET_GRAPHQL_URL) {
    console.error('FATAL: Missing required environment variables (TMDB_API_KEY, BITMAGNET_GRAPHQL_URL)');
    process.exit(1);
}

const builder = new addonBuilder({
    id: 'com.stremio.fusion',
    version: '1.0.0',
    name: 'Fusion',
    description: 'Advanced addon using Bitmagnet and Real-Debrid with smart filtering and sorting.',
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: false,
    }
});

const QUALITY_ORDER = ['4k', '2160p', '1440p', '1080p', '720p', '480p'];

function getQualityScore(resolution) {
    if (!resolution) return Infinity;
    const quality = resolution.toLowerCase();
    const index = QUALITY_ORDER.findIndex(q => quality.includes(q));
    return index === -1 ? Infinity : index;
}

function sortStreams(streamCandidates, config) {
    const priorities = config.sortOrder || ['language', 'quality', 'seeders'];
    streamCandidates.sort((a, b) => {
        for (const priority of priorities) {
            if (priority === 'language') {
                const langA = (a.parsed.language || '').toLowerCase();
                const langB = (b.parsed.language || '').toLowerCase();
                const preferredLang = (config.language || 'eng').split('|')[0].trim();
                if (langA.includes(preferredLang) && !langB.includes(preferredLang)) return -1;
                if (!langA.includes(preferredLang) && langB.includes(preferredLang)) return 1;
            }
            if (priority === 'quality') {
                const scoreA = getQualityScore(a.parsed.resolution);
                const scoreB = getQualityScore(b.parsed.resolution);
                if (scoreA !== scoreB) return scoreA - scoreB;
            }
            if (priority === 'seeders') {
                const seedersA = a.torrent.seeders || 0;
                const seedersB = b.torrent.seeders || 0;
                if (seedersA !== seedersB) return seedersB - seedersA;
            }
            if (priority === 'fuzzyScore') {
                if (a.fuzzyScore !== b.fuzzyScore) return b.fuzzyScore - a.fuzzyScore;
            }
        }
        return 0;
    });
    return streamCandidates;
}

builder.defineStreamHandler(async ({ type, id, config }) => {
    console.log(`Request for streams: ${type} ${id}`);
    try {
        const [imdbId, season, episode] = id.split(':');
        const meta = await metadata.getMetadata(imdbId, TMDB_API_KEY);
        if (!meta) return { streams: [] };

        const searchParams = { ...meta, type, season, episode };
        const torrents = await bitmagnet.searchContent(searchParams, config, BITMAGNET_GRAPHQL_URL);
        if (!torrents || torrents.length === 0) return { streams: [] };

        let streamCandidates = torrents.map(torrent => ({
            torrent,
            parsed: parser.parse(torrent.title),
            fuzzyScore: parser.getFuzzyScore(parser.parse(torrent.title).title, meta.title),
            rdCached: false,
        }));

        let rdClient;
        if (config && config.rdKey) {
            try {
                rdClient = new RealDebridClient(config.rdKey);
                const infoHashes = streamCandidates.map(c => c.torrent.infoHash);
                const rdCache = await rdClient.checkCache(infoHashes);
                streamCandidates.forEach(c => {
                    if (rdCache[c.torrent.infoHash] && Object.keys(rdCache[c.torrent.infoHash].rd).length > 0) {
                        c.rdCached = true;
                    }
                });
            } catch (e) { console.warn('Real-Debrid check failed:', e.message); }
        }

        streamCandidates.sort((a, b) => b.rdCached - a.rdCached);
        const sortedCandidates = sortStreams(streamCandidates, config);

        const streams = [];
        for (const candidate of sortedCandidates) {
            const { torrent, rdCached } = candidate;
            const largestFile = torrent.files.sort((a, b) => b.size - a.size)[0];
            const fileIdx = torrent.files.indexOf(largestFile);
            const streamTitle = `${torrent.title}\n💾 ${Math.round(torrent.size / 1e9)} GB | 👤 ${torrent.seeders || 0}`;

            if (rdCached && rdClient) {
                try {
                    const addedMagnet = await rdClient.addMagnet(torrent.infoHash);
                    if (addedMagnet.id) {
                        const torrentInfo = await rdClient.getTorrentInfo(addedMagnet.id);
                        const fileToUnrestrict = torrentInfo.files.find(f => f.path === largestFile.path);
                        if (fileToUnrestrict) {
                            const unrestricted = await rdClient.unrestrictLink(fileToUnrestrict.link);
                            if (unrestricted.download) {
                                streams.push({ name: '[RD+ Cached]', title: streamTitle, url: unrestricted.download });
                                continue;
                            }
                        }
                    }
                } catch (e) { console.error(`Failed to get RD link for ${torrent.infoHash}`, e.message) }
            }
            streams.push({ name: rdCached ? '[RD-Cached]' : '[Torrent]', title: streamTitle, infoHash: torrent.infoHash, fileIdx });
        }
        return { streams: streams.slice(0, 50) };
    } catch (err) {
        console.error("Error in stream handler:", err);
        return Promise.reject("Handler error");
    }
});

const addonInterface = builder.getInterface();
const app = express();

app.use(cors()); // <-- 2. ENABLE CORS FOR ALL ROUTES
app.use(express.static(path.join(__dirname, '../public')));

const manifestHandler = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const manifest = { ...addonInterface.manifest };
    if (req.params.userConfig) {
        manifest.behaviorHints.configurationRequired = true;
    }
    res.send(manifest);
};

const streamHandler = async (req, res) => {
    const { type, id, userConfig } = req.params;
    let config = {};
    if (userConfig) {
        try { config = JSON.parse(decodeURIComponent(userConfig)); } catch (e) { /* ignore */ }
    }
    try {
        const response = await addonInterface.get('stream', type, id, config);
        res.setHeader('Content-Type', 'application/json');
        res.send(response);
    } catch (err) {
        console.error(err);
        res.status(500).send({ err: "handler error" });
    }
};

app.get('/manifest.json', manifestHandler);
app.get('/:userConfig/manifest.json', manifestHandler);

app.get('/stream/:type/:id.json', streamHandler);
app.get('/stream/:type/:id/:userConfig.json', streamHandler);

app.listen(PORT, () => {
    console.log(`Stremio Fusion Addon running on http://127.0.0.1:${PORT}`);
    console.log('Open the above address in your browser to configure and install.');
});
