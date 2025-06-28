import { ADDON_ID, ADDON_NAME, ADDON_VERSION } from './config.js';

export const manifest = {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: 'Streams TV Shows from Bitmagnet via Real-Debrid. Configured via environment variables.',
    resources: ['stream'],
    types: ['series'],
    idPrefixes: ['tt'],
    catalogs: [],
    // The 'config' array is removed to prevent Stremio from prompting the user.
};
