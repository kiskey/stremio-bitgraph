/**
 * src/utils.js
 * Utility Functions
 * Contains helper functions for retry mechanisms, delays, and logging.
 */

const winston = require('winston');
const { format } = winston;
const config = require('../config');

// --- Logger Setup ---
const logger = winston.createLogger({
  level: config.logLevel, // 'info', 'debug', 'error', 'warn'
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    // Add file transport for production logging if desired
    // new winston.transports.File({ filename: 'error.log', level: 'error' }),
    // new winston.transports.File({ filename: 'combined.log' }),
  ],
});

/**
 * Promisified sleep function.
 * @param {number} ms - The number of milliseconds to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retries an asynchronous function with exponential backoff and jitter.
 * @param {function} fn - The asynchronous function to retry.
 * @param {object} options - Retry options.
 * @param {number} options.maxAttempts - Maximum number of retry attempts.
 * @param {number} options.initialDelayMs - Initial delay before the first retry in milliseconds.
 * @param {number} options.maxDelayMs - Maximum delay between retries in milliseconds.
 * @returns {Promise<any>} The result of the function if successful.
 * @throws {Error} The last error encountered if all retries fail.
 */
async function retryWithExponentialBackoff(fn, { maxAttempts, initialDelayMs, maxDelayMs }) {
  let attempts = 0;
  let currentDelay = initialDelayMs;

  while (attempts < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempts++;
      logger.warn(`Attempt ${attempts}/${maxAttempts} failed: ${error.message}`);

      if (attempts >= maxAttempts) {
        logger.error(`Max retries (${maxAttempts}) reached. Failed to execute function.`);
        throw error; // Rethrow the last error
      }

      // Calculate next delay with exponential backoff and jitter
      const jitter = Math.random() * (currentDelay / 2); // Randomness up to half the current delay
      const delayWithJitter = Math.min(maxDelayMs, currentDelay + jitter);

      logger.info(`Retrying in ${delayWithJitter / 1000} seconds...`);
      await sleep(delayWithJitter);
      currentDelay *= 2; // Double the delay for the next attempt
    }
  }
}


/**
 * Calculates the Levenshtein distance between two strings.
 * This measures the minimum number of single-character edits
 * (insertions, deletions, or substitutions) required to change one word into the other.
 * @param {string} a - The first string.
 * @param {string} b - The second string.
 * @returns {number} The Levenshtein distance.
 */
function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // Increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // Increment along the first row of each column
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            const cost = (a[j - 1] === b[i - 1]) ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,       // Deletion
                matrix[i][j - 1] + 1,       // Insertion
                matrix[i - 1][j - 1] + cost // Substitution
            );
        }
    }

    return matrix[b.length][a.length];
}

module.exports = {
  sleep,
  retryWithExponentialBackoff,
  levenshteinDistance,
  logger,
};
