// File: db/migrate.js
// Version: 1.0 - Unified debrid cache table
import pg from 'pg';
import { DATABASE_URL } from '../config.js';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

const createTableSQL = `
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

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(createTableSQL);
    console.log('Migration successful: debrid_cache table ready.');
  } finally {
    client.release();
    pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
