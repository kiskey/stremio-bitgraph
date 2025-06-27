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
 * Attempts to clean a torrent title parsed by `parse-torrent-title`
 * by removing common extraneous elements like website names, years, or release groups
 * that might incorrectly be part of the 'title' property.
 * This is a heuristic and might need refinement.
 * @param {object} parsedInfo - The object returned by `parseTorrentInfo`.
 * @returns {string} A cleaner version of the torrent title.
 */
function cleanParsedTorrentTitle(parsedInfo) {
    let cleanedTitle = parsedInfo.title || '';

    // Remove common website/source prefixes
    cleanedTitle = cleanedTitle.replace(/^(www\.[a-z0-9]+\.org\s*-\s*)/i, '');
    cleanedTitle = cleanedTitle.replace(/(\s*-\s*www\.[a-z0-9]+\.org)$/i, '');
    cleanedTitle = cleanedTitle.replace(/(\s*-\s*UIndex\.org)$/i, ''); // Specific fix for UIndex example

    // Remove year if it's at the end or start of the title and already parsed separately
    if (parsedInfo.year && cleanedTitle.includes(String(parsedInfo.year))) {
        cleanedTitle = cleanedTitle.replace(new RegExp(`\\s*${parsedInfo.year}\\s*`, 'g'), ' ').trim();
    }

    // Remove known release group tags from the title itself if they are distinct
    if (parsedInfo.group && cleanedTitle.toLowerCase().endsWith(parsedInfo.group.toLowerCase())) {
        cleanedTitle = cleanedTitle.substring(0, cleanedTitle.length - parsedInfo.group.length).trim();
    }

    // Remove common trailing numbers/quality that might be part of release names but not title
    cleanedTitle = cleanedTitle.replace(/\s+\d{3,4}p$/, '').trim(); // e.g., "Show Title 1080p" -> "Show Title"
    cleanedTitle = cleanedTitle.replace(/\s+x264$/, '').trim();
    cleanedTitle = cleanedTitle.replace(/\s+x265$/, '').trim();
    cleanedTitle = cleanedTitle.replace(/\s+HEVC$/, '').trim();
    cleanedTitle = cleanedTitle.replace(/\s+H\.264$/, '').trim();
    cleanedTitle = cleanedTitle.replace(/\s+FENiX$/i, '').trim(); // Specific release group from example

    // Remove multiple spaces
    cleanedTitle = cleanedTitle.replace(/\s+/g, ' ').trim();

    return cleanedTitle;
}


/**
 * Calculates a similarity score between two strings using string-similarity (Jaro-Winkler).
 * @param {string} str1 - First string.
 * @param {string} str2 - Second string.
 * @returns {number} Similarity score between 0 and 1.
 */
function calculateSimilarity(str1, str2) {
  // Normalize strings before calculating similarity to handle case and some punctuation
  const normalizedStr1 = str1.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const normalizedStr2 = str2.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  return stringSimilarity.compareTwoStrings(normalizedStr1, normalizedStr2);
}

/**
 * Determines if a torrent or file path matches the requested episode.
 * @param {object} parsedInfo - Parsed info from parseTorrentInfo.
 * @param {number} targetSeason - Target season number.
 * @param {number} targetEpisode - Target episode number.
 * @returns {boolean} True if a match, false otherwise.
 */
function isEpisodeMatch(parsedInfo, targetSeason, targetEpisode) {
  if (!parsedInfo) {
    return false;
  }

  const seasonMatch = parsedInfo.season === targetSeason;
  const episodeMatch = parsedInfo.episode === targetEpisode;
  const isEpisodeInParsedRange = parsedInfo.episodes && parsedInfo.episodes.includes(targetEpisode);

  // If there's a specific episode match
  if (seasonMatch && (episodeMatch || isEpisodeInParsedRange)) {
    logger.debug(`Exact S${targetSeason}E${targetEpisode} match in parsed info: ${parsedInfo.originalName}`);
    return true;
  }

  // If it's a season pack and the season matches, it's a potential match that needs file inspection
  if (parsedInfo.season === targetSeason && (parsedInfo.isCompleteSeason || parsedInfo.seasonpack)) {
    logger.debug(`Torrent "${parsedInfo.originalName}" is a season pack for S${targetSeason}.`);
    return true;
  }

  logger.debug(`No direct episode or season pack match for S${targetSeason}E${targetEpisode} in parsed info: ${JSON.stringify(parsedInfo)}`);
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

  // CRITICAL FIX: Only use the cleaned parsed torrent title for similarity
  const titleForSimilarity = cleanParsedTorrentTitle(parsedTorrent);

  const titleSimilarity = calculateSimilarity(titleForSimilarity || '', tmdbShowTitle);
  logger.debug(`Title similarity for "${titleForSimilarity}" vs "${tmdbShowTitle}": ${titleSimilarity.toFixed(2)}`);

  // Initial title similarity filter. This is the first gate.
  if (titleSimilarity < 0.5) { // Adjustable threshold for initial filtering
    logger.debug(`Title similarity too low (${titleSimilarity.toFixed(2)}). Skipping torrent.`);
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
  }
  score += titleSimilarity * 100; // Boost this heavily as it's the primary match factor


  // Now, check for episode match based on the parsed torrent name.
  // If it's not an episode or season pack match, it's irrelevant.
  const isTorrentEpisodeOrPackMatch = isEpisodeMatch(parsedTorrent, targetSeason, targetEpisode);
  if (!isTorrentEpisodeOrPackMatch) {
      logger.debug(`Torrent name does not match episode or season pack. Skipping: "${torrentName}"`);
      return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
  }
  score += 100; // Base score for being a relevant torrent (episode or season pack)


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
  // Add other quality indicators if available in parsedTorrent (e.g., hdr, dolbyvision)
  if (parsedTorrent.hdr) score += 5;
  if (parsedTorrent.dolbyvision) score += 5;


  let matchedFileIndex = null;
  let matchedFilePath = null;

  const torrentFiles = torrent ? torrent.files : null;

  // We only need to inspect individual files if the torrent is a season pack or range,
  // or if the torrent name itself doesn't directly indicate the episode.
  // If `parsedTorrent.episode` is an array (e.g., [1,2,3]), it's also a pack.
  const needsFileInspection = parsedTorrent.season === targetSeason &&
                              (parsedTorrent.isCompleteSeason || parsedTorrent.seasonpack ||
                               (Array.isArray(parsedTorrent.episode) && parsedTorrent.episode.includes(targetEpisode)) ||
                               (parsedTorrent.range && targetEpisode >= parsedTorrent.range.start && targetEpisode <= parsedTorrent.range.end));

  if (needsFileInspection) {
    logger.debug(`Torrent is identified as a multi-episode pack, inspecting individual files for "${torrentName}".`);

    let filesToProcess = torrentFiles;
    // If files are not embedded in the initial search result, fetch them directly from Bitmagnet.
    if (!filesToProcess || filesToProcess.length === 0) {
        logger.debug(`Files not available in search result for ${torrentInfoHash}, attempting to fetch directly.`);
        filesToProcess = await bitmagnet.getTorrentFiles(torrentInfoHash);
    }

    if (filesToProcess && filesToProcess.length > 0) {
      let currentBestFileScore = -Infinity; // Keep track of the best file score found within this torrent
      for (const file of filesToProcess) {
        const parsedFile = parseTorrentInfo(file.path);
        if (parsedFile) {
          // Check if the individual file matches the target episode
          const isFileEpisodeMatch = isEpisodeMatch(parsedFile, targetSeason, targetEpisode); // Use isEpisodeMatch here

          if (isFileEpisodeMatch) {
            // Score the individual file, boosting it significantly
            const fileScore = 500 + calculateSimilarity(cleanParsedTorrentTitle(parsedFile), tmdbShowTitle) * 50; // Boost for file title
            if (fileScore > currentBestFileScore) {
              currentBestFileScore = fileScore;
              matchedFileIndex = file.index;
              matchedFilePath = file.path;
              logger.debug(`Found better file match in "${torrentName}": "${file.path}". Score: ${fileScore}`);
            }
          }
        } else {
            logger.warn(`Could not parse file path: "${file.path}" within torrent "${torrentName}".`);
        }
      }
      if (currentBestFileScore > -Infinity) {
          score += currentBestFileScore; // Add the score of the best matched file
      } else {
          // If it was a pack but no specific file matched the episode, penalize.
          logger.warn(`Torrent was a pack, but no specific file for S${targetSeason}E${targetEpisode} found: "${torrentName}". Penalizing.`);
          return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
      }
    } else {
        logger.warn(`No files found for torrent "${torrentName}" (InfoHash: ${torrentInfoHash}) to perform file-level matching.`);
        // If it's a pack type and no files are available or match, it's a bad torrent for this episode.
        return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null };
    }
  } else {
      // If it's a single episode torrent (as per PTT) and it already passed isEpisodeMatch at the torrent level,
      // and it does not need file inspection, then its 'matchedFileIndex' should be 0 or null/undefined
      // indicating the main file, and `real-debrid` will usually pick the largest.
      matchedFileIndex = 0; // Assume index 0 for single file torrents if not explicitly found.
      matchedFilePath = torrentName; // Use torrent name as path if single file
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
  parseTorrentInfo,
  findBestTorrentMatch,
  cleanParsedTorrentTitle // Export for potential testing/reuse
};
