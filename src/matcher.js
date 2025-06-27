/**
 * src/matcher.js
 * Intelligent Torrent Matching and Scoring
 * Contains logic to parse torrent names, apply fuzzy matching, and score torrents
 * to find the best match for a given TV show episode.
 */

const ptt = require('parse-torrent-title');
const stringSimilarity = require('string-similarity');
const { logger } = require('./utils');
const config = require('../config');
const bitmagnet = require('./bitmagnet'); // Import bitmagnet to fetch files if needed

const LEVENSHTEIN_THRESHOLD = config.levenshteinThreshold || 7;
// Define base language scores based on preference order
// Higher score indicates higher priority.
const LANGUAGE_PREFERENCE_SCORES = {
  'tamil': 1000, // Highest priority
  'tam': 1000,   // Alias for Tamil
  'en': 500,     // Second priority
  'eng': 500,    // Alias for English
  // Add other languages as needed with descending scores
  'und': 100, // Undetermined language, treat as lower priority but still above no match
  'null': 100 // Treat null/unspecified as unknown, default to a lower English priority
};

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
    const parsed = ptt.parse(torrentName);
    parsed.originalName = torrentName; // Add original name for debugging
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

  const seasonMatch = parsedInfo.season === targetSeason;
  const episodeMatch = parsedInfo.episode === targetEpisode;
  const isEpisodeInParsedRange = parsedInfo.episodes && parsedInfo.episodes.includes(targetEpisode);

  const titleSimilarity = calculateSimilarity(parsedInfo.title || '', targetTitle);
  const isTitleSimilar = titleSimilarity >= config.titleSimilarityThreshold || 0.7;

  if (seasonMatch && (episodeMatch || isEpisodeInParsedRange)) {
    logger.debug(`Exact S${targetSeason}E${targetEpisode} match in torrent name "${parsedInfo.originalName}".`);
    return true;
  }

  if (parsedInfo.season && parsedInfo.season === targetSeason && parsedInfo.isCompleteSeason) {
    logger.debug(`Torrent "${parsedInfo.originalName}" is a season pack for S${targetSeason}.`);
    return true;
  }

  logger.debug(`No direct match for S${targetSeason}E${targetEpisode} with title "${targetTitle}" in parsed info: ${JSON.stringify(parsedInfo)}`);
  return false;
}

/**
 * Scores a torrent based on various criteria for a specific episode.
 * @param {object} bitmagnetItem - The item object from Bitmagnet's torrentContent.search.items.
 * This contains nested 'torrent' and 'content' objects.
 * @param {object} tmdbEpisodeDetails - TMDB details for the target episode.
 * @param {string} tmdbShowTitle - Canonical TMDB show title.
 * @param {Array<string>} preferredLanguages - User's preferred language order (e.g., ['tamil', 'en']).
 * @returns {object} An object containing the original bitmagnetItem, calculated score,
 * matched file index, matched file path, and parsed torrent info.
 */
async function scoreTorrent(bitmagnetItem, tmdbEpisodeDetails, tmdbShowTitle, preferredLanguages) {
  let score = 0;
  const targetSeason = tmdbEpisodeDetails.season_number;
  const targetEpisode = tmdbEpisodeDetails.episode_number;

  const torrent = bitmagnetItem.torrent;
  const torrentName = torrent ? torrent.name : null;
  const torrentInfoHash = torrent ? torrent.infoHash : 'N/A';

  logger.debug(`Processing torrent: "${torrentName}" (InfoHash: ${torrentInfoHash})`);

  const parsedTorrent = parseTorrentInfo(torrentName);
  if (!parsedTorrent) {
    logger.warn(`Could not parse overall torrent name: "${torrentName}". Skipping.`);
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
  }

  const mainTitle = bitmagnetItem.content && bitmagnetItem.content.title ? bitmagnetItem.content.title : parsedTorrent.title;
  const titleSimilarity = calculateSimilarity(mainTitle || '', tmdbShowTitle);
  logger.debug(`Title similarity for "${mainTitle}" vs "${tmdbShowTitle}": ${titleSimilarity.toFixed(2)}`);

  if (titleSimilarity < 0.5) {
    logger.debug(`Title similarity too low (${titleSimilarity.toFixed(2)}). Skipping torrent.`);
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
  }
  score += titleSimilarity * 10;

  const isDirectEpisodeMatch = (
    parsedTorrent.season === targetSeason &&
    parsedTorrent.episode === targetEpisode
  );

  if (isDirectEpisodeMatch) {
    score += 100;
    logger.debug(`Direct episode match in torrent name. Score +100.`);
  }

  // Language Scoring
  const torrentLanguages = bitmagnetItem.languages ? bitmagnetItem.languages.map(lang => lang.id.toLowerCase()) : [];
  let languageScore = 0;
  let foundLanguage = false;

  for (const preferredLang of preferredLanguages) {
    if (torrentLanguages.includes(preferredLang)) {
      languageScore = LANGUAGE_PREFERENCE_SCORES[preferredLang] || 0;
      foundLanguage = true;
      logger.debug(`Torrent has preferred language "${preferredLang}". Base language score: ${languageScore}.`);
      break; // Take the first matched preferred language
    }
  }

  // If no language found from Bitmagnet, try to use parsedTorrent.languages (from ptt)
  if (!foundLanguage && parsedTorrent.languages && parsedTorrent.languages.length > 0) {
      const parsedTorrentLang = parsedTorrent.languages[0].toLowerCase(); // Assuming first language from ptt
      languageScore = LANGUAGE_PREFERENCE_SCORES[parsedTorrentLang] || (LANGUAGE_PREFERENCE_SCORES['en'] || 0); // Default to English if parsed language is not in our map
      logger.debug(`Torrent parsed language "${parsedTorrentLang}" not in preferred list. Using its score or defaulting to English score: ${languageScore}.`);
  } else if (!foundLanguage) {
      // No language info at all from Bitmagnet or PTT
      languageScore = LANGUAGE_PREFERENCE_SCORES['en'] || 0; // Default to English score
      logger.debug(`Torrent has no specified language. Defaulting to English score: ${languageScore}.`);
  }
  score += languageScore;


  // Prioritize torrents with more seeders
  score += (bitmagnetItem.seeders || 0) * 0.1;

  // Prefer higher quality (simple example, can be more complex based on ptt resolution)
  if (parsedTorrent.resolution === '2160p') score += 20;
  else if (parsedTorrent.resolution === '1080p') score += 15;
  else if (parsedTorrent.resolution === '720p') score += 10;

  let matchedFileIndex = null;
  let matchedFilePath = null;

  const torrentFiles = torrent ? torrent.files : null;

  if (!isDirectEpisodeMatch || (torrentFiles && torrentFiles.length > 1)) {
    logger.debug(`Torrent not a direct episode match or is multi-file. Inspecting individual files for "${torrentName}".`);

    let filesToProcess = torrentFiles;
    if (!filesToProcess || filesToProcess.length === 0) {
        logger.debug(`Files not available in search result for ${torrentInfoHash}, attempting to fetch directly.`);
        filesToProcess = await bitmagnet.getTorrentFiles(torrentInfoHash);
    }

    if (filesToProcess && filesToProcess.length > 0) {
      for (const file of filesToProcess) {
        const parsedFile = parseTorrentInfo(file.path);
        if (parsedFile) {
          const fileSeasonMatch = parsedFile.season === targetSeason;
          const fileEpisodeMatch = parsedFile.episode === targetEpisode;

          if (fileSeasonMatch && fileEpisodeMatch) {
            score += 200; // Very high score for direct file match
            matchedFileIndex = file.index;
            matchedFilePath = file.path;
            logger.debug(`Found specific file match for S${targetSeason}E${targetEpisode} in file "${file.path}". Score +200.`);
            break;
          }
        }
      }
    } else {
        logger.warn(`No files found for torrent "${torrentName}" (InfoHash: ${torrentInfoHash}) to perform file-level matching.`);
    }
  }

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
 * @param {Array<string>} preferredLanguages - User's preferred language order (e.g., ['tamil', 'en']).
 * @returns {Promise<Array<object>>} Sorted array of torrents with scores.
 */
async function findBestTorrentMatch(bitmagnetResults, tmdbEpisodeDetails, tmdbShowTitle, preferredLanguages) {
  logger.info(`Starting intelligent matching for S${tmdbEpisodeDetails.season_number}E${tmdbEpisodeDetails.episode_number} of "${tmdbShowTitle}"`);
  const scoredTorrents = [];

  for (const bitmagnetItem of bitmagnetResults) {
    // Pass preferredLanguages to scoreTorrent for language-based scoring
    const result = await scoreTorrent(bitmagnetItem, tmdbEpisodeDetails, tmdbShowTitle, preferredLanguages);
    if (result.score > -Infinity) { // Only add if it's a valid candidate
      scoredTorrents.push(result);
    }
  }

  // Primary sort by score (descending), which now includes language preference.
  scoredTorrents.sort((a, b) => b.score - a.score);
  logger.info(`Intelligent matching yielded ${scoredTorrents.length} scored torrents.`);
  logger.debug(`Top ${Math.min(3, scoredTorrents.length)} scored torrents: ${JSON.stringify(scoredTorrents.slice(0, 3))}`); // Log top 3 for debug

  return scoredTorrents;
}

module.exports = {
  findBestTorrentMatch,
};
