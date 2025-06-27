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

    // CRITICAL FIX: Explicitly disable SSL if the PostgreSQL server does not support it
    // This is common for local/Docker setups where SSL is not configured.
    // If you enable SSL on your PostgreSQL server later, you might remove or adjust this.
    const url = new URL(config.database.url);
    if (!url.searchParams.has('sslmode')) { // Only add if sslmode is not already specified in the URL
      // Append a parameter to the connection string to disable SSL
      // The `pg` library respects `sslmode=disable`
      const separator = url.search ? '&' : '?';
      config.database.url += `${separator}sslmode=disable`;
      logger.info(`Appended 'sslmode=disable' to connection URL: ${config.database.url.replace(/:\/\/[^:]+:[^@]+@/, '://user:password@')}`);
    }

    pool = new Pool({
      connectionString: config.database.url,
      // The `ssl: false` directly passed in the config object
      // is another way to disable SSL, equivalent to sslmode=disable in URL.
      // We will rely on the `sslmode=disable` in the connection string to be explicit.
      // If you prefer, you can use: `ssl: false` directly here, and remove the URL modification.
      // For maximal clarity, adding `sslmode=disable` to the URL is often preferred for logging/debugging.
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
