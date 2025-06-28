import { ADDON_ID, ADDON_NAME, ADDON_VERSION } from './config.js';

export const manifest = {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: 'Streams Movies & TV Shows from Bitmagnet via Real-Debrid.',
    resources: ['stream'],
    // UPDATED: Now supports both movies and series
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
};
