/**
 * db.js
 * Database Connection (PostgreSQL with pg)
 * Initializes a PostgreSQL connection pool using the 'pg' library,
 * and ensures the necessary tables exist.
 */

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./src/utils').logger;

let pool;

/**
 * Initializes the PostgreSQL connection pool and ensures the database schema is set up.
 * This function should be called once when the application starts.
 */
async function initializePg() {
  if (!pool) {
    logger.info('Initializing PostgreSQL connection pool...');
    if (!config.database.url) {
      logger.error('DATABASE_URL is not set in config. Database operations will fail.');
      throw new Error('DATABASE_URL is not configured.');
    }
    logger.info(`Attempting to connect to database using URL: ${config.database.url.replace(/:\/\/[^:]+:[^@]+@/, '://user:password@')}`); // Log URL without actual password for security

    pool = new Pool({
      connectionString: config.database.url,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, // Adjust SSL for production
    });

    pool.on('error', (err) => {
      logger.error('Unexpected error on idle client in PostgreSQL pool', err);
      // It's critical to react to pool errors. Depending on your environment,
      // you might want to gracefully exit, or attempt a full re-initialization.
      // For now, we'll log and let the process continue, but prepare for failures.
      // process.exit(-1); // Consider uncommenting this for unrecoverable errors.
    });

    let client;
    try {
      client = await pool.connect();
      logger.info('Successfully connected to PostgreSQL database.');

      // --- Automate Table Creation ---
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS torrents (
            id SERIAL PRIMARY KEY,
            infohash VARCHAR(40) UNIQUE NOT NULL,
            tmdb_id VARCHAR(255) NOT NULL,
            season_number INTEGER NOT NULL,
            episode_number INTEGER NOT NULL,
            torrent_name TEXT NOT NULL,
            parsed_info_json JSONB NOT NULL,
            real_debrid_torrent_id VARCHAR(255) UNIQUE NOT NULL,
            real_debrid_file_id VARCHAR(255) NOT NULL,
            real_debrid_link TEXT NOT NULL,
            real_debrid_info_json JSONB, -- Storing full RD info for status checks
            added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            last_checked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            language_preference VARCHAR(10),
            seeders INTEGER, -- Allow null for seeders if Bitmagnet doesn't provide
            -- Combined index for quick episode lookups
            UNIQUE (tmdb_id, season_number, episode_number, infohash)
        );

        -- Add indexes for common lookup fields if not covered by unique constraints
        CREATE INDEX IF NOT EXISTS idx_torrents_infohash ON torrents (infohash);
        CREATE INDEX IF NOT EXISTS idx_torrents_rd_torrent_id ON torrents (real_debrid_torrent_id);
        CREATE INDEX IF NOT EXISTS idx_torrents_tmdb_episode ON torrents (tmdb_id, season_number, episode_number);
      `;
      await client.query(createTableSql);
      logger.info('Ensured "torrents" table schema exists in PostgreSQL.');

    } catch (err) {
      logger.error('Failed to connect to or set up PostgreSQL database schema:', err);
      // IMPORTANT: If schema setup fails, the app cannot function correctly.
      // It's appropriate to re-throw or exit here.
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  }
}

/**
 * Executes a SQL query using the PostgreSQL connection pool.
 * @param {string} text - The SQL query text.
 * @param {Array<any>} params - An array of query parameters.
 * @returns {Promise<object>} The query result object.
 */
async function query(text, params) {
  if (!pool) {
    logger.error('PostgreSQL pool not initialized. Call initializePg() first.');
    throw new Error('Database pool not initialized.');
  }
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug(`Executed query: ${text} with params: [${params}] in ${duration}ms. Rows: ${res.rowCount}`);
    return res;
  } catch (err) {
    logger.error(`Error executing query: ${text} with params: [${params}]`, err);
    throw err; // Re-throw the error for upstream error handling
  }
}

// Export functions to be used by other modules
module.exports = {
  initializePg,
  query,
};
