/**
 * src/matcher.js
 * Intelligent Torrent Matching and Scoring
 * Contains logic to parse torrent names, apply fuzzy matching, and score torrents
 * to find the best match for a given TV show episode.
 */

const ptt = require('parse-torrent-title'); // CRITICAL FIX: Correctly import as 'ptt'
const stringSimilarity = require('string-similarity');
const { logger } = require('./utils');
const config = require('../config');
const bitmagnet = require('./bitmagnet'); // Import bitmagnet to fetch files if needed

const LEVENSHTEIN_THRESHOLD = config.levenshteinThreshold || 7;

/**
 * Parses a torrent name or file path to extract structured information.
 * Handles cases where torrentName might be undefined or null.
 * @param {string} torrentName - The name of the torrent or file.
 * @returns {object|null} Parsed torrent info or null if parsing fails.
 */
function parseTorrentInfo(torrentName) {
  if (!torrentName || typeof torrentName !== 'string' || torrentName.length === 0) {
    logger.warn(`Failed to parse torrent filename "${torrentName}": Invalid input.`);
    return null;
  }
  try {
    // CRITICAL FIX: Call ptt.parse() instead of parse()
    const parsed = ptt.parse(torrentName);
    // Add original name for debugging
    parsed.originalName = torrentName;
    return parsed;
  } catch (error) {
    logger.warn(`Failed to parse torrent filename "${torrentName}": ${error.message}`);
    return null;
  }
}

/**
 * Calculates a similarity score between two strings using string-similarity (Jaro-Winkler).
 * @param {string} str1 - First string.
 * @param {string} str2 - Second string.
 * @returns {number} Similarity score between 0 and 1.
 */
function calculateSimilarity(str1, str2) {
  return stringSimilarity.compareTwoStrings(str1, str2);
}

/**
 * Determines if a torrent or file path matches the requested episode.
 * Handles single episodes, season packs, and individual files within packs.
 * @param {object} parsedInfo - Parsed info from parseTorrentInfo.
 * @param {number} targetSeason - Target season number.
 * @param {number} targetEpisode - Target episode number.
 * @param {string} targetTitle - Canonical show title for fuzzy matching.
 * @returns {boolean} True if a match, false otherwise.
 */
function isEpisodeMatch(parsedInfo, targetSeason, targetEpisode, targetTitle) {
  if (!parsedInfo) {
    return false;
  }

  // Strict season and episode number match
  const seasonMatch = parsedInfo.season === targetSeason;
  const episodeMatch = parsedInfo.episode === targetEpisode;

  // Check for episode ranges (e.g., S01E01-E05)
  const isEpisodeInParsedRange = parsedInfo.episodes && parsedInfo.episodes.includes(targetEpisode);

  // Fuzzy match on title (to handle show title variations)
  const titleSimilarity = calculateSimilarity(parsedInfo.title || '', targetTitle);
  const isTitleSimilar = titleSimilarity >= config.titleSimilarityThreshold || 0.7; // Default 0.7 for strong match

  // Scenario 1: Exact season and episode match in torrent name
  if (seasonMatch && (episodeMatch || isEpisodeInParsedRange)) {
    logger.debug(`Exact S${targetSeason}E${targetEpisode} match in torrent name "${parsedInfo.originalName}".`);
    return true;
  }

  // Scenario 2: Torrent is a season pack, requires file-level matching (handled by caller)
  if (parsedInfo.season && parsedInfo.season === targetSeason && parsedInfo.isCompleteSeason) {
    logger.debug(`Torrent "${parsedInfo.originalName}" is a season pack for S${targetSeason}.`);
    // Return true, as it's a potential candidate for file-level inspection.
    return true;
  }

  logger.debug(`No direct match for S${targetSeason}E${targetEpisode} with title "${targetTitle}" in parsed info: ${JSON.stringify(parsedInfo)}`);
  return false;
}

/**
 * Scores a torrent based on various criteria for a specific episode.
 * Higher score means better match.
 * @param {object} bitmagnetItem - The item object from Bitmagnet's torrentContent.search.items.
 * This contains nested 'torrent' and 'content' objects.
 * @param {object} tmdbEpisodeDetails - TMDB details for the target episode.
 * @param {string} tmdbShowTitle - Canonical TMDB show title.
 * @returns {object} An object containing the original bitmagnetItem, calculated score,
 * matched file index, matched file path, and parsed torrent info.
 */
async function scoreTorrent(bitmagnetItem, tmdbEpisodeDetails, tmdbShowTitle) {
  let score = 0;
  const targetSeason = tmdbEpisodeDetails.season_number;
  const targetEpisode = tmdbEpisodeDetails.episode_number;

  // Access the nested torrent object and its name
  const torrent = bitmagnetItem.torrent;
  const torrentName = torrent ? torrent.name : null;
  const torrentInfoHash = torrent ? torrent.infoHash : 'N/A';

  // Log what torrent is being processed with the correct name
  logger.debug(`Processing torrent: "${torrentName}" (InfoHash: ${torrentInfoHash})`);

  // 1. Parse overall torrent name
  const parsedTorrent = parseTorrentInfo(torrentName);
  if (!parsedTorrent) {
    logger.warn(`Could not parse overall torrent name: "${torrentName}". Skipping.`);
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
  }

  // Levenshtein similarity for show title (0 to 1)
  // Use the content title from bitmagnetItem if available, otherwise parsedTorrent.title
  const mainTitle = bitmagnetItem.content && bitmagnetItem.content.title ? bitmagnetItem.content.title : parsedTorrent.title;
  const titleSimilarity = calculateSimilarity(mainTitle || '', tmdbShowTitle);
  logger.debug(`Title similarity for "${mainTitle}" vs "${tmdbShowTitle}": ${titleSimilarity.toFixed(2)}`);

  // If the show title similarity is too low, it's probably not the right show
  if (titleSimilarity < 0.5) { // Adjustable threshold
    logger.debug(`Title similarity too low (${titleSimilarity.toFixed(2)}). Skipping torrent.`);
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
  }
  score += titleSimilarity * 10; // Give a good base score for title similarity

  // Check for direct episode match in torrent name (e.g., "Show.S01E01.mkv")
  const isDirectEpisodeMatch = (
    parsedTorrent.season === targetSeason &&
    parsedTorrent.episode === targetEpisode
  );

  if (isDirectEpisodeMatch) {
    score += 100; // High score for direct episode match
    logger.debug(`Direct episode match in torrent name. Score +100.`);
  }

  // Prioritize torrents with more seeders (accessing from bitmagnetItem directly as per schema)
  score += (bitmagnetItem.seeders || 0) * 0.1; // Add a small value per seeder

  // Prefer higher quality (simple example, can be more complex)
  if (parsedTorrent.resolution === '2160p') score += 20;
  else if (parsedTorrent.resolution === '1080p') score += 15;
  else if (parsedTorrent.resolution === '720p') score += 10;

  // Prioritize preferred languages (if bitmagnetItem.languages are available)
  const torrentLanguages = bitmagnetItem.languages ? bitmagnetItem.languages.map(lang => lang.id.toLowerCase()) : [];
  const preferredLanguages = config.preferredLanguages ? config.preferredLanguages.split(',').map(lang => lang.trim().toLowerCase()) : ['en'];

  const hasPreferredLanguage = preferredLanguages.some(pl => torrentLanguages.includes(pl));
  if (hasPreferredLanguage) {
      score += 5; // Boost score for preferred language
      logger.debug(`Torrent has preferred language. Score +5.`);
  }

  let matchedFileIndex = null;
  let matchedFilePath = null;

  // If it's not a direct episode match or if it's a multi-file torrent,
  // we need to look into individual files.
  // Access files from the nested torrent object (`bitmagnetItem.torrent.files`)
  const torrentFiles = torrent ? torrent.files : null;


  if (!isDirectEpisodeMatch || (torrentFiles && torrentFiles.length > 1)) {
    logger.debug(`Torrent not a direct episode match or is multi-file. Inspecting individual files for "${torrentName}".`);

    // If files are not present or empty, try to fetch them specifically if it's a multi-file torrent that didn't provide files.
    let filesToProcess = torrentFiles;

    if (!filesToProcess || filesToProcess.length === 0) {
        logger.debug(`Files not available in search result for ${torrentInfoHash}, attempting to fetch directly.`);
        filesToProcess = await bitmagnet.getTorrentFiles(torrentInfoHash);
    }

    if (filesToProcess && filesToProcess.length > 0) {
      for (const file of filesToProcess) {
        const parsedFile = parseTorrentInfo(file.path);
        if (parsedFile) {
          // Check if the individual file matches the target episode
          const fileSeasonMatch = parsedFile.season === targetSeason;
          const fileEpisodeMatch = parsedFile.episode === targetEpisode;

          if (fileSeasonMatch && fileEpisodeMatch) {
            score += 200; // Very high score for direct file match
            matchedFileIndex = file.index; // Store the index of the matched file
            matchedFilePath = file.path;
            logger.debug(`Found specific file match for S${targetSeason}E${targetEpisode} in file "${file.path}". Score +200.`);
            break; // Stop after finding the first matching file
          }
        }
      }
    } else {
        logger.warn(`No files found for torrent "${torrentName}" (InfoHash: ${torrentInfoHash}) to perform file-level matching.`);
    }
  }

  // Return the original bitmagnetItem along with the calculated score and matched file info.
  return {
    torrent: bitmagnetItem,
    score: score,
    matchedFileIndex: matchedFileIndex,
    matchedFilePath: matchedFilePath,
    parsedInfo: parsedTorrent
  };
}

/**
 * Finds the best torrent match for a given episode from a list of Bitmagnet results.
 * @param {Array<object>} bitmagnetResults - Array of Bitmagnet TorrentContent objects.
 * @param {object} tmdbEpisodeDetails - TMDB details for the target episode.
 * @param {string} tmdbShowTitle - Canonical TMDB show title.
 * @returns {Promise<Array<object>>} Sorted array of torrents with scores.
 */
async function findBestTorrentMatch(bitmagnetResults, tmdbEpisodeDetails, tmdbShowTitle) {
  logger.info(`Starting intelligent matching for S${tmdbEpisodeDetails.season_number}E${tmdbEpisodeDetails.episode_number} of "${tmdbShowTitle}"`);
  const scoredTorrents = [];

  for (const bitmagnetItem of bitmagnetResults) { // Iterate over each TorrentContent item
    const result = await scoreTorrent(bitmagnetItem, tmdbEpisodeDetails, tmdbShowTitle);
    if (result.score > -Infinity) { // Only add if it's a valid candidate
      scoredTorrents.push(result);
    }
  }

  // Sort by score in descending order
  scoredTorrents.sort((a, b) => b.score - a.score);
  logger.info(`Intelligent matching yielded ${scoredTorrents.length} scored torrents.`);
  return scoredTorrents;
}

module.exports = {
  findBestTorrentMatch,
};
