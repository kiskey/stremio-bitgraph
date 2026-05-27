// File: src/debrid/cache.js
// Version: 1.0 - Abstract cache layer on top of debrid_cache table

import pg from 'pg';
import { DATABASE_URL, DEBRID_CACHE_TABLE } from '../../config.js';

let pool;
function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

/**
 * Initialize cache for a given provider.
 * @param {string} provider - e.g. 'torbox', 'realdebrid'
 * @returns {object} cache API
 */
export function createCache(provider) {
  const table = DEBRID_CACHE_TABLE;

  return {
    async get(hash) {
      const client = await getPool().connect();
      try {
        const res = await client.query(
          `SELECT * FROM ${table} WHERE provider = $1 AND hash = $2`,
          [provider, hash]
        );
        return res.rows[0] || null;
      } finally {
        client.release();
      }
    },

    async set(hash, data) {
      const client = await getPool().connect();
      try {
        const { provider_torrent_id, status, extra } = data;
        const jsonData = extra || {};
        await client.query(
          `INSERT INTO ${table} (provider, hash, provider_torrent_id, status, data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider, hash)
           DO UPDATE SET
             provider_torrent_id = EXCLUDED.provider_torrent_id,
             status = EXCLUDED.status,
             data = EXCLUDED.data,
             updated_at = NOW()`,
          [provider, hash, provider_torrent_id, status, JSON.stringify(jsonData)]
        );
        return true;
      } finally {
        client.release();
      }
    },

    async update(hash, updates) {
      const client = await getPool().connect();
      try {
        const sets = [];
        const values = [provider, hash];
        if (updates.provider_torrent_id !== undefined) {
          sets.push(`provider_torrent_id = $${values.push(updates.provider_torrent_id)}`);
        }
        if (updates.status !== undefined) {
          sets.push(`status = $${values.push(updates.status)}`);
        }
        if (updates.extra !== undefined) {
          sets.push(`data = $${values.push(JSON.stringify(updates.extra))}`);
        }
        sets.push('updated_at = NOW()');
        if (!sets.length) return null;
        await client.query(
          `UPDATE ${table} SET ${sets.join(', ')} WHERE provider = $1 AND hash = $2`,
          values
        );
        return true;
      } finally {
        client.release();
      }
    },

    async delete(hash) {
      const client = await getPool().connect();
      try {
        await client.query(
          `DELETE FROM ${table} WHERE provider = $1 AND hash = $2`,
          [provider, hash]
        );
      } finally {
        client.release();
      }
    },
  };
}
