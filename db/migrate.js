// File: db/migrate.js
// Version: 2.1 – Provider-aware torrents table + generic debrid cache

import pg from 'pg';
import { DATABASE_URL } from '../config.js';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    // 1. Debrid cache table
    await client.query(`
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
    `);

    // 2. Make torrents table provider-aware
    await client.query(`
      ALTER TABLE torrents ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'realdebrid';

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='torrents' AND column_name='rd_torrent_info_json'
        ) THEN
          ALTER TABLE torrents RENAME COLUMN rd_torrent_info_json TO torrent_info_json;
        END IF;
      END $$;

      ALTER TABLE torrents DROP CONSTRAINT IF EXISTS torrents_infohash_tmdb_id_content_type_key;
      ALTER TABLE torrents ADD CONSTRAINT torrents_infohash_tmdb_id_content_type_provider_key
        UNIQUE (infohash, tmdb_id, content_type, provider);
    `);

    console.log('Migration successful.');
  } finally {
    client.release();
    pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
