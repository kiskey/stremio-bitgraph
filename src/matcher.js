/**
 * src/matcher.js
 * Intelligent Torrent Matching and Scoring
 * Contains logic to parse torrent names, apply fuzzy matching, and score torrents
 * to find the best match for a given TV show episode.
 */

const parse = require('parse-torrent-title');
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
    const parsed = parse(torrentName);
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

  // Check for episode ranges (e.g., S01E01-E05) - requires further logic if specific range is needed
  // For simplicity, we assume single episode or the file itself identifies it.
  const isEpisodeInParsedRange = parsedInfo.episodes && parsedInfo.episodes.includes(targetEpisode);

  // Fuzzy match on title (to handle show title variations)
  // Use a higher threshold for exact matching on episodes after initial filter
  const titleSimilarity = calculateSimilarity(parsedInfo.title || '', targetTitle);
  const isTitleSimilar = titleSimilarity >= config.titleSimilarityThreshold || 0.7; // Default 0.7 for strong match

  // Scenario 1: Exact season and episode match in torrent name
  if (seasonMatch && (episodeMatch || isEpisodeInParsedRange)) {
    logger.debug(`Exact S${targetSeason}E${targetEpisode} match in torrent name "${parsedInfo.originalName}".`);
    return true;
  }

  // Scenario 2: Torrent is a season pack, requires file-level matching (handled by caller)
  // If the torrent is detected as a full season and our target episode is within that season
  if (parsedInfo.season && parsedInfo.season === targetSeason && parsedInfo.isCompleteSeason) {
    logger.debug(`Torrent "${parsedInfo.originalName}" is a season pack for S${targetSeason}.`);
    // This is a candidate for file-level inspection
    return true; // We return true here, indicating it's a potential candidate,
                 // and the scoring logic will later look into its files.
  }

  logger.debug(`No direct match for S${targetSeason}E${targetEpisode} with title "${targetTitle}" in parsed info: ${JSON.stringify(parsedInfo)}`);
  return false;
}

/**
 * Scores a torrent based on various criteria for a specific episode.
 * Higher score means better match.
 * @param {object} torrent - The torrent object from Bitmagnet.
 * @param {object} tmdbEpisodeDetails - TMDB details for the target episode.
 * @param {string} tmdbShowTitle - Canonical TMDB show title.
 * @returns {number} The score for the torrent.
 */
async function scoreTorrent(torrent, tmdbEpisodeDetails, tmdbShowTitle) {
  let score = 0;
  const targetSeason = tmdbEpisodeDetails.season_number;
  const targetEpisode = tmdbEpisodeDetails.episode_number;

  // Log what torrent is being processed
  logger.debug(`Processing torrent: "${torrent.name}" (InfoHash: ${torrent.infoHash})`);

  // 1. Parse overall torrent name
  const parsedTorrent = parseTorrentInfo(torrent.name);
  if (!parsedTorrent) {
    logger.warn(`Could not parse overall torrent name: "${torrent.name}". Skipping.`);
    return -Infinity; // Very low score if torrent name can't be parsed
  }

  // Levenshtein similarity for show title (0 to 1)
  const titleSimilarity = calculateSimilarity(parsedTorrent.title || '', tmdbShowTitle);
  logger.debug(`Title similarity for "${parsedTorrent.title}" vs "${tmdbShowTitle}": ${titleSimilarity.toFixed(2)}`);

  // If the show title similarity is too low, it's probably not the right show
  if (titleSimilarity < 0.5) { // Adjustable threshold
    logger.debug(`Title similarity too low (${titleSimilarity.toFixed(2)}). Skipping torrent.`);
    return -Infinity;
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

  // Prioritize torrents with more seeders
  score += (torrent.seeders || 0) * 0.1; // Add a small value per seeder

  // Prefer higher quality (simple example, can be more complex)
  if (parsedTorrent.resolution === '2160p') score += 20;
  else if (parsedTorrent.resolution === '1080p') score += 15;
  else if (parsedTorrent.resolution === '720p') score += 10;

  // Prioritize preferred languages (if torrent.languages are available)
  // Language filtering happens in index.js for streams, but here for scoring preference
  const torrentLanguages = torrent.languages ? torrent.languages.map(lang => lang.id.toLowerCase()) : [];
  const preferredLanguages = config.preferredLanguages ? config.preferredLanguages.split(',').map(lang => lang.trim().toLowerCase()) : ['en'];

  const hasPreferredLanguage = preferredLanguages.some(pl => torrentLanguages.includes(pl));
  if (hasPreferredLanguage) {
      score += 5; // Boost score for preferred language
      logger.debug(`Torrent has preferred language. Score +5.`);
  }

  let matchedFileIndex = null;
  let matchedFilePath = null;

  // If it's not a direct episode match OR if it's a multi-file torrent,
  // we need to look into individual files.
  if (!isDirectEpisodeMatch || (torrent.files && torrent.files.length > 1)) {
    logger.debug(`Torrent not a direct episode match or is multi-file. Inspecting individual files for "${torrent.name}".`);

    // Bitmagnet's search results already contain torrent.files.
    // If files are not present or empty, try to fetch them specifically if it's a multi-file torrent that didn't provide files.
    let torrentFiles = torrent.files;

    if (!torrentFiles || torrentFiles.length === 0) {
        // Fallback: If search didn't provide files, attempt to fetch them using the dedicated query
        // This is important for large torrents where files might not be inline in search results
        logger.debug(`Files not available in search result for ${torrent.infoHash}, attempting to fetch directly.`);
        torrentFiles = await bitmagnet.getTorrentFiles(torrent.infoHash);
    }

    if (torrentFiles && torrentFiles.length > 0) {
      for (const file of torrentFiles) {
        const parsedFile = parseTorrentInfo(file.path);
        if (parsedFile) {
          // Check if the individual file matches the target episode
          const fileSeasonMatch = parsedFile.season === targetSeason;
          const fileEpisodeMatch = parsedFile.episode === targetEpisode;

          if (fileSeasonMatch && fileEpisodeMatch) {
            // Found a specific file for the episode!
            score += 200; // Very high score for direct file match
            matchedFileIndex = file.index; // Store the index of the matched file
            matchedFilePath = file.path;
            logger.debug(`Found specific file match for S${targetSeason}E${targetEpisode} in file "${file.path}". Score +200.`);
            break; // Stop after finding the first matching file
          }
        }
      }
    } else {
        logger.warn(`No files found for torrent ${torrent.name} (${torrent.infoHash}) to perform file-level matching.`);
    }
  }

  // Store the matched file index and path on the torrent object for later use
  torrent._matchedFileIndex = matchedFileIndex;
  torrent._matchedFilePath = matchedFilePath;
  torrent._parsedInfo = parsedTorrent; // Store overall parsed info

  logger.debug(`Final score for torrent "${torrent.name}" (InfoHash: ${torrent.infoHash}): ${score}`);
  return { torrent, score, matchedFileIndex, matchedFilePath };
}

/**
 * Finds the best torrent match for a given episode from a list of Bitmagnet results.
 * @param {Array<object>} bitmagnetResults - Array of torrent objects from Bitmagnet.
 * @param {object} tmdbEpisodeDetails - TMDB details for the target episode.
 * @param {string} tmdbShowTitle - Canonical TMDB show title.
 * @returns {Promise<Array<object>>} Sorted array of torrents with scores.
 */
async function findBestTorrentMatch(bitmagnetResults, tmdbEpisodeDetails, tmdbShowTitle) {
  logger.info(`Starting intelligent matching for S${tmdbEpisodeDetails.season_number}E${tmdbEpisodeDetails.episode_number} of "${tmdbShowTitle}"`);
  const scoredTorrents = [];

  for (const torrent of bitmagnetResults) {
    const result = await scoreTorrent(torrent, tmdbEpisodeDetails, tmdbShowTitle);
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
