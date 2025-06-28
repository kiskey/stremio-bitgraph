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
    infohash TEXT NOT NULL,
    tmdb_id TEXT NOT NULL,
    rd_torrent_info_json JSONB,
    language TEXT NOT NULL,
    quality TEXT,
    seeders INTEGER,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_torrent_source UNIQUE (infohash, tmdb_id)
);
`;

export const initDb = async () => {
    try {
        await pool.query(CREATE_TABLE_QUERY);
        logger.info('Database initialized successfully. "torrents" table is ready.');
    } catch (err) {
        logger.error('Error initializing database table:', err);
        process.exit(1);
    }
};

pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});
