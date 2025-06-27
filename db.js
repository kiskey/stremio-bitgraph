/**
 * db.js
 * Database Connection (Prisma Client)
 * Initializes the Prisma Client for interacting with the PostgreSQL database.
 */

const { PrismaClient } = require('@prisma/client');
const config = require('./config');
const logger = require('./src/utils').logger;

let prisma;

/**
 * Initializes the PrismaClient.
 * This function should be called once when the application starts.
 */
function initializePrisma() {
  if (!prisma) {
    logger.info('Initializing Prisma Client...');
    if (!config.database.url) {
      logger.error('DATABASE_URL is not set in config. Database operations will fail.');
      throw new Error('DATABASE_URL is not configured.');
    }
    logger.info(`Attempting to connect to database using URL: ${config.database.url.replace(/:\/\/[^:]+:[^@]+@/, '://user:password@')}`); // Log URL without actual password for security
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: config.database.url,
        },
      },
      log: ['query', 'error', 'warn'], // Log database queries, errors, and warnings
    });

    // Connect to the database
    prisma.$connect()
      .then(() => {
        logger.info('Successfully connected to PostgreSQL database.');
      })
      .catch((error) => {
        // IMPORTANT: Log the full error object for detailed debugging
        logger.error('Failed to connect to PostgreSQL database:', error);
        // Do NOT exit the process immediately here. The addon might still serve manifest/metadata
        // but stream requests would fail if they hit the DB.
        // Prisma Client will automatically retry to connect on subsequent operations if connection is lost.
      });
  }
  return prisma;
}

/**
 * Retrieves the initialized PrismaClient instance.
 * @returns {PrismaClient} The PrismaClient instance.
 */
function getPrismaClient() {
  if (!prisma) {
    logger.warn('Prisma Client not initialized. Calling initializePrisma().');
    return initializePrisma();
  }
  return prisma;
}

// Export functions to be used by other modules
module.exports = {
  initializePrisma,
  getPrismaClient,
};
