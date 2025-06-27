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
        logger.error('Failed to connect to PostgreSQL database:', error.message);
        // Exit the process if database connection fails critically at startup
        process.exit(1);
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
