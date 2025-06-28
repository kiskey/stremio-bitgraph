/**
 * src/utils.js
 * Utility functions for the Stremio Addon.
 * Includes logging and retry mechanisms.
 */

const winston = require('winston');
const config = require('../config'); // Import config to get logging level

// Setup Winston logger
const logger = winston.createLogger({
  level: config.logLevel, // Use log level from config
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

/**
 * Sleeps for a specified duration.
 * @param {number} ms - The duration in milliseconds.
 * @returns {Promise<void>} A promise that resolves after the duration.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retries an asynchronous function with exponential backoff.
 * @param {Function} fn - The asynchronous function to retry.
 * @param {object} retryConfig - Configuration for retries.
 * @param {number} retryConfig.maxRetries - Maximum number of retry attempts.
 * @param {number} retryConfig.initialDelay - Initial delay in milliseconds before the first retry.
 * @param {number} retryConfig.maxDelayMs - Maximum delay in milliseconds between retries.
 * @returns {Promise<any>} The result of the function if successful.
 * @throws {Error} The error from the function if all retries fail.
 */
async function retryWithExponentialBackoff(fn, retryConfig) {
  const { maxRetries, initialDelay, maxDelayMs } = retryConfig;
  let delay = initialDelay;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      logger.warn(`Attempt ${i + 1}/${maxRetries} failed. Retrying in ${delay / 1000}s... Error: ${error.message}`);
      if (error.response) { // Log Axios specific response if available
          logger.debug('Axios response error details:', JSON.stringify({
              status: error.response.status,
              headers: error.response.headers,
              data: error.response.data
          }, null, 2));
      } else if (error.request) { // Log Axios request details if no response
          logger.debug('Axios request details (no response):', error.request);
      }
      
      if (i < maxRetries - 1) {
        await sleep(Math.min(delay, maxDelayMs)); // Cap the delay at maxDelayMs
        delay *= 2; // Exponential backoff
      } else {
        // If it's the last attempt, re-throw the original error
        throw error;
      }
    }
  }
}

module.exports = {
  logger,
  sleep,
  retryWithExponentialBackoff,
};
