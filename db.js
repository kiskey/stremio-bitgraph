/**
 * db.js
 * Database Connection (PostgreSQL with pg library)
 * Initializes a PostgreSQL connection pool and provides a simple query function.
 */

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./src/utils').logger;

let pool;

/**
 * Initializes the PostgreSQL connection pool.
 * This function should be called once when the application starts.
 * It also creates the 'torrents' table if it doesn't exist.
 */
async function initializePg() {
  if (!pool) {
    logger.info('Initializing PostgreSQL connection pool...');
    if (!config.database.url) {
      logger.error('DATABASE_URL is not set in config. Database operations will fail.');
      throw new Error('DATABASE_URL is not configured.');
    }

    // Mask password for logging purposes
    const maskedUrl = config.database.url.replace(/:\/\/[^:]+:[^@]+@/, '://user:password@');
    logger.info(`Attempting to connect to database using URL: ${maskedUrl}`);

    pool = new Pool({
      connectionString: config.database.url,
      ssl: {
        rejectUnauthorized: false // Adjust for production environments with proper certs
      }
    });

    try {
      // Test the connection
      await pool.query('SELECT NOW()');
      logger.info('Successfully connected to PostgreSQL database.');

      // Create the torrents table if it doesn't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS torrents (
          id SERIAL PRIMARY KEY,
          infohash TEXT UNIQUE NOT NULL,
          tmdb_id TEXT NOT NULL,
          season_number INTEGER NOT NULL,
          episode_number INTEGER NOT NULL,
          torrent_name TEXT NOT NULL,
          parsed_info_json JSONB,
          real_debrid_torrent_id TEXT UNIQUE NOT NULL,
          real_debrid_file_id TEXT,
          real_debrid_link TEXT NOT NULL,
          added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          last_checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          language_preference TEXT,
          seeders INTEGER,
          CONSTRAINT unique_infohash UNIQUE (infohash),
          CONSTRAINT unique_real_debrid_torrent_id UNIQUE (real_debrid_torrent_id)
        );
        -- Add indexes for common lookup fields
        CREATE INDEX IF NOT EXISTS idx_torrents_tmdb_episode ON torrents (tmdb_id, season_number, episode_number);
        CREATE INDEX IF NOT EXISTS idx_torrents_infohash ON torrents (infohash);
        CREATE INDEX IF NOT EXISTS idx_torrents_real_debrid_torrent_id ON torrents (real_debrid_torrent_id);
      `);
      logger.info('Ensured "torrents" table exists in the database.');

    } catch (error) {
      logger.error('Failed to connect to PostgreSQL database or create table:', error);
      // Do not exit the process here, allow app to start, but DB ops will fail
    }
  }
  return pool;
}

/**
 * Executes a SQL query using the connection pool.
 * @param {string} text - The SQL query string.
 * @param {Array<any>} [params] - An array of parameters for the query.
 * @returns {Promise<import('pg').QueryResult>} The result of the query.
 */
async function query(text, params) {
  if (!pool) {
    logger.error('PostgreSQL pool not initialized. Cannot execute query.');
    throw new Error('Database pool not ready.');
  }
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (error) {
    logger.error(`Error executing query: "${text}" with params: ${JSON.stringify(params)}`, error);
    throw error;
  }
}

// Export functions to be used by other modules
module.exports = {
  initializePg,
  query,
};
