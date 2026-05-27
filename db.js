import pg from 'pg';
import { DATABASE_URL } from './config.js';
import { logger } from './src/utils.js';

const { Pool } = pg;

export const pool = new Pool({
    connectionString: DATABASE_URL,
});

// ── New schema – provider-aware, generic column name ────────────
const CREATE_TABLE_QUERY = `
CREATE TABLE IF NOT EXISTS torrents (
    id SERIAL PRIMARY KEY,
    infohash TEXT NOT NULL,
    tmdb_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'realdebrid',          -- new column
    torrent_info_json JSONB,                              -- renamed from rd_torrent_info_json
    language TEXT NOT NULL,
    quality TEXT,
    seeders INTEGER,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT torrents_infohash_tmdb_id_content_type_provider_key
        UNIQUE (infohash, tmdb_id, content_type, provider)
);
`;

// ── Generic debrid cache table ────────────────────────────────
const CREATE_DEBRID_CACHE_TABLE = `
CREATE TABLE IF NOT EXISTS debrid_cache (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    hash TEXT NOT NULL,
    provider_torrent_id TEXT,
    status TEXT DEFAULT 'active',
    data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(provider, hash)
);
CREATE INDEX IF NOT EXISTS idx_debrid_cache_hash ON debrid_cache(hash);
`;

// ── Idempotent alterations for existing databases ──────────────
const IDEMPOTENT_MIGRATION = `
-- 1. Add provider column if it doesn't exist
ALTER TABLE torrents ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'realdebrid';

-- 2. Rename old info column to generic name (only if the old name exists)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='torrents' AND column_name='rd_torrent_info_json'
    ) THEN
        ALTER TABLE torrents RENAME COLUMN rd_torrent_info_json TO torrent_info_json;
    END IF;
END $$;

-- 3. Drop the old unique constraint if it still exists
ALTER TABLE torrents DROP CONSTRAINT IF EXISTS unique_torrent_source;

-- 4. Add the new provider‑aware unique constraint (if not already present)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'torrents_infohash_tmdb_id_content_type_provider_key'
    ) THEN
        ALTER TABLE torrents ADD CONSTRAINT torrents_infohash_tmdb_id_content_type_provider_key
            UNIQUE (infohash, tmdb_id, content_type, provider);
    END IF;
END $$;
`;

export const initDb = async () => {
    try {
        // 1. Create or update torrents table
        await pool.query(CREATE_TABLE_QUERY);
        // 2. Create debrid_cache table
        await pool.query(CREATE_DEBRID_CACHE_TABLE);
        // 3. Apply idempotent migration (safe to run on any state)
        await pool.query(IDEMPOTENT_MIGRATION);
        logger.info('Database initialized and migrated successfully.');
    } catch (err) {
        logger.error('Error initializing database:', err);
        process.exit(1);
    }
};

pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});
