import pg from 'pg';
import { DATABASE_URL } from './config.js';
import { logger } from './src/utils.js';

const { Pool } = pg;

export const pool = new Pool({
    connectionString: DATABASE_URL,
});

// UPDATED: Added 'content_type' and included it in the unique constraint.
const CREATE_TABLE_QUERY = `
CREATE TABLE IF NOT EXISTS torrents (
    id SERIAL PRIMARY KEY,
    infohash TEXT NOT NULL,
    tmdb_id TEXT NOT NULL,
    content_type TEXT NOT NULL, -- 'movie' or 'series'
    rd_torrent_info_json JSONB,
    language TEXT NOT NULL,
    quality TEXT,
    seeders INTEGER,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_torrent_source UNIQUE (infohash, tmdb_id, content_type)
);
`;

// We remove the now-redundant columns for season/episode to keep the schema clean.
// The data is inside the JSON.
const ALTER_TABLE_QUERY_1 = `ALTER TABLE torrents DROP COLUMN IF EXISTS season_number;`;
const ALTER_TABLE_QUERY_2 = `ALTER TABLE torrents DROP COLUMN IF EXISTS episode_number;`;


export const initDb = async () => {
    try {
        await pool.query(CREATE_TABLE_QUERY);
        // These will run once and then do nothing on subsequent starts.
        await pool.query(ALTER_TABLE_QUERY_1);
        await pool.query(ALTER_TABLE_QUERY_2);
        logger.info('Database initialized successfully. "torrents" table is type-aware.');
    } catch (err) {
        logger.error('Error initializing database table:', err);
        process.exit(1);
    }
};

pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});
