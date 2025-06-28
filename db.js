import pg from 'pg';
import { DATABASE_URL } from './config.js';
import { logger } from './src/utils.js';

const { Pool } = pg;

export const pool = new Pool({
    connectionString: DATABASE_URL,
});

const CREATE_TABLE_QUERY = `
CREATE TABLE IF NOT EXISTS torrents (
    id SERIAL PRIMARY KEY,
    infohash TEXT NOT NULL UNIQUE,
    tmdb_id TEXT NOT NULL,
    season_number INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    file_index INTEGER NOT NULL,
    torrent_name TEXT,
    parsed_info_json JSONB,
    real_debrid_torrent_id TEXT,
    unrestricted_link TEXT,
    language TEXT NOT NULL,
    quality TEXT,
    seeders INTEGER,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_checked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_torrent_episode_file UNIQUE (tmdb_id, season_number, episode_number, infohash, file_index)
);
`;

export const initDb = async () => {
    try {
        await pool.query(CREATE_TABLE_QUERY);
        logger.info('Database initialized successfully. "torrents" table is ready.');
    } catch (err) {
        logger.error('Error initializing database table:', err);
        // Exit process if DB connection fails, as the app is useless without it.
        process.exit(1);
    }
};

// Listen for connection errors on the pool
pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});
