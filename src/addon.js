require('dotenv').config();
const { addonBuilder } = require('stremio-addon-sdk');
const path = require('path');
const { run } = require('serve-http');
const metadata = require('./metadata');
const bitmagnet = require('./bitmagnet');
const parser = require('./parser');
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

builder.defineStreamHandler(async ({ type, id, config }) => {
    console.log('\n\n============================================================');
    console.log(`[INFO] Stream handler invoked at: ${new Date().toISOString()}`);
    console.log('============================================================');

    // LOGGING: Log the initial request received from Stremio.
    console.log(`[INPUT] Received request for Type: ${type}, ID: ${id}`);
    console.log('[INPUT] User Configuration:', JSON.stringify(config, null, 2));

    try {
        const [imdbId, season, episode] = id.split(':');
        
        console.log('\n--- 1. Fetching Metadata ---');
        const meta = await metadata.getMetadata(imdbId, TMDB_API_KEY);
        if (!meta) {
            console.error('[ERROR] Could not fetch metadata from TMDB. Aborting.');
            return { streams: [] };
        }
        // LOGGING: Log the metadata found.
        console.log(`[DEBUG] Found metadata - Title: ${meta.title}, Year: ${meta.year}`);

        console.log('\n--- 2. Querying Bitmagnet ---');
        const searchParams = { ...meta, type, season, episode };
        const torrents = await bitmagnet.searchContent(searchParams, config, BITMAGNET_GRAPHQL_URL);
        // LOGGING: Log the results from Bitmagnet.
        console.log(`[RESPONSE] Bitmagnet returned ${torrents.length} torrents.`);
        if (torrents.length === 0) {
            console.log('[INFO] No torrents found. Aborting.');
            return { streams: [] };
        }
        console.log('[RESPONSE] Top 5 torrent titles from Bitmagnet:');
        torrents.slice(0, 5).forEach(t => console.log(`  - ${t.title}`));


        console.log('\n--- 3. Processing & Enrichment ---');
        let streamCandidates = torrents.map(torrent => ({
            torrent,
            parsed: parser.parse(torrent.title),
            fuzzyScore: parser.getFuzzyScore(parser.parse(torrent.title).title, meta.title),
            rdCached: false,
        }));
        // LOGGING: Show that initial processing is done.
        console.log(`[DEBUG] Created ${streamCandidates.length} initial stream candidates.`);

        let rdClient;
        if (config && config.rdKey) {
            console.log('\n--- 4. Checking Real-Debrid Cache ---');
            try {
                rdClient = new RealDebridClient(config.rdKey);
                const infoHashes = streamCandidates.map(c => c.torrent.infoHash);
                // LOGGING: Log the hashes being sent to RD.
                console.log(`[QUERY] Checking ${infoHashes.length} infohashes against RD cache.`);
                const rdCache = await rdClient.checkCache(infoHashes);
                const cachedHashes = [];
                streamCandidates.forEach(c => {
                    if (rdCache[c.torrent.infoHash] && Object.keys(rdCache[c.torrent.infoHash].rd).length > 0) {
                        c.rdCached = true;
                        cachedHashes.push(c.torrent.infoHash);
                    }
                });
                // LOGGING: Log the result of the cache check.
                console.log(`[RESPONSE] Found ${cachedHashes.length} cached torrents on Real-Debrid.`);
                if (cachedHashes.length > 0) {
                    console.log('[RESPONSE] Cached Hashes:', cachedHashes);
                }
            } catch (e) { console.error('[ERROR] Real-Debrid check failed:', e.message); }
        }

        console.log('\n--- 5. Sorting Streams ---');
        // LOGGING: Log the sorting priorities.
        const sortPriorities = config.sortOrder || ['language', 'quality', 'seeders'];
        console.log(`[DEBUG] Sorting streams with priority: ${sortPriorities.join(' > ')}`);

        // Sorting logic
        const QUALITY_ORDER = ['4k', '2160p', '1440p', '1080p', '720p', '480p'];
        const getQualityScore = (res) => { if (!res) return Infinity; const q = res.toLowerCase(); const i = QUALITY_ORDER.findIndex(x => q.includes(x)); return i === -1 ? Infinity : i; };
        streamCandidates.sort((a, b) => {
            // First, always prioritize RD cached streams if RD is used
            if (config && config.rdKey) {
                if (a.rdCached && !b.rdCached) return -1;
                if (!a.rdCached && b.rdCached) return 1;
            }
            for (const priority of sortPriorities) {
                if (priority === 'language') {
                    const langA = (a.parsed.language || '').toLowerCase(); const langB = (b.parsed.language || '').toLowerCase(); const pLang = (config.language || 'eng').split('|')[0].trim();
                    if (langA.includes(pLang) && !langB.includes(pLang)) return -1; if (!langA.includes(pLang) && langB.includes(pLang)) return 1;
                }
                if (priority === 'quality') { const sA = getQualityScore(a.parsed.resolution); const sB = getQualityScore(b.parsed.resolution); if (sA !== sB) return sA - sB; }
                if (priority === 'seeders') { const sA = a.torrent.seeders || 0; const sB = b.torrent.seeders || 0; if (sA !== sB) return sB - sA; }
                if (priority === 'fuzzyScore') { if (a.fuzzyScore !== b.fuzzyScore) return b.fuzzyScore - a.fuzzyScore; }
            }
            return 0;
        });
        
        console.log('\n--- 6. Generating Final Stream List ---');
        const streams = [];
        for (const candidate of streamCandidates) {
            const { torrent, rdCached } = candidate;
            const largestFile = torrent.files.sort((a, b) => b.size - a.size)[0];
            if (!largestFile) {
                console.log(`[WARN] Skipping torrent with no files: ${torrent.title}`);
                continue; // Skip torrents with no files
            }
            const fileIdx = torrent.files.indexOf(largestFile);
            const streamTitle = `${torrent.title}\n💾 ${Math.round(torrent.size / 1e9)} GB | 👤 ${torrent.seeders || 0}`;

            if (rdCached && rdClient) {
                try {
                    // LOGGING: Detail the RD unrestriction process.
                    console.log(`[RD-PROC] Attempting to unrestrict cached hash: ${torrent.infoHash}`);
                    const addedMagnet = await rdClient.addMagnet(torrent.infoHash);
                    if (addedMagnet.id) {
                        const torrentInfo = await rdClient.getTorrentInfo(addedMagnet.id);
                        const fileToUnrestrict = torrentInfo.files.find(f => f.path === largestFile.path);
                        if (fileToUnrestrict) {
                            console.log(`[RD-PROC] Found matching file to unrestrict: ${fileToUnrestrict.path}`);
                            const unrestricted = await rdClient.unrestrictLink(fileToUnrestrict.link);
                            if (unrestricted.download) {
                                console.log(`[RD-PROC] Successfully got streamable link for ${torrent.infoHash}`);
                                streams.push({
                                    name: '[RD+ Cached]',
                                    title: streamTitle,
                                    url: unrestricted.download,
                                });
                                continue; // Successfully added RD link, skip to next candidate
                            } else {
                                console.warn(`[RD-PROC] Unrestrict call succeeded but returned no download link for ${torrent.infoHash}`);
                            }
                        } else {
                            console.warn(`[RD-PROC] Could not find matching file in RD torrent info for ${torrent.infoHash}`);
                        }
                    } else {
                        console.warn(`[RD-PROC] Add magnet call succeeded but returned no ID for ${torrent.infoHash}`);
                    }
                } catch (e) {
                    console.error(`[ERROR] Full RD unrestrict process failed for ${torrent.infoHash}:`, e.message);
                }
            }
            
            // Fallback to P2P stream if not cached or if RD process fails
            streams.push({
                name: rdCached ? '[RD Cached]' : '[P2P Torrent]',
                title: streamTitle,
                infoHash: torrent.infoHash,
                fileIdx,
            });
        }
        
        // LOGGING: Log a summary of the final streams being returned.
        const finalStreams = streams.slice(0, 50);
        console.log(`[OUTPUT] Sending ${finalStreams.length} streams to Stremio.`);
        console.log('[OUTPUT] Top 5 final streams:');
        finalStreams.slice(0, 5).forEach(s => console.log(`  - ${s.name} | ${s.title.split('\n')[0]}`));
        console.log('============================================================\n');

        return { streams: finalStreams };
    } catch (err) {
        console.error("[FATAL] Unhandled error in stream handler:", err);
        return Promise.reject("Handler error");
    }
});

const addonInterface = builder.getInterface();
run(addonInterface, {
    port: PORT || 7000,
    cors: true,
    static: '/public'
}).on('listening', () => {
    console.log(`Stremio Fusion Addon running on http://127.0.0.1:${PORT}`);
    console.log('Open the above address in your browser to configure and install.');
});
