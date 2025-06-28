import { ADDON_ID, ADDON_NAME, ADDON_VERSION } from './config.js';

export const manifest = {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: 'Streams TV Shows from Bitmagnet via Real-Debrid.',
    resources: ['stream'],
    types: ['series'],
    idPrefixes: ['tt'],
    catalogs: [],
    config: [
        {
            key: 'realDebridApiKey',
            type: 'text',
            title: 'Real-Debrid API Token',
            required: true,
        },
        {
            key: 'preferredLanguages',
            type: 'text',
            title: 'Preferred Languages (comma-separated, e.g., en,fr)',
            default: 'en',
        },
    ],
};
