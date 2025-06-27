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
 * Escapes special characters in a string to be safely used in a regular expression.
 * @param {string} string - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}


/**
 * Parses a torrent name or file path to extract structured information.
 * Handles cases where torrentName might be undefined or null.
 * @param {string} torrentName - The name of the torrent or file.
 * @returns {object|null} Parsed torrent info or null if parsing fails.
 */
function parseTorrentInfo(torrentName) {
  if (!torrentName || typeof torrentName !== 'string' || torrentName.length === 0) {
    // logger.warn(`Failed to parse torrent filename "${torrentName}": Invalid input.`);
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

    // Remove common website/source prefixes/suffixes that parse-torrent-title might include
    cleanedTitle = cleanedTitle.replace(/^(www\.[a-z0-9]+\.org\s*-\s*)/i, '');
    cleanedTitle = cleanedTitle.replace(/(\s*-\s*www\.[a-z0-9]+\.org)$/i, '');
    cleanedTitle = cleanedTitle.replace(/(\s*-\s*UIndex\.org)$/i, ''); // Specific fix for UIndex example

    // Remove year if it's at the end or start of the title and already parsed separately
    // Only remove if it's a four-digit number likely representing a year
    if (parsedInfo.year && cleanedTitle.includes(String(parsedInfo.year))) {
        cleanedTitle = cleanedTitle.replace(new RegExp(`\\s*${parsedInfo.year}\\s*`, 'g'), ' ').trim();
    }

    // Remove known release group tags from the title itself if they are distinct
    if (parsedInfo.group) {
        // CRITICAL FIX: Escape parsedInfo.group to prevent regex syntax errors
        const escapedGroup = escapeRegExp(parsedInfo.group);
        // Use a regex to match the group name at the end, case-insensitive, with potential delimiters
        cleanedTitle = cleanedTitle.replace(new RegExp(`\\s*[\\-\\[\\(]?${escapedGroup}[\\)\\]]?$`, 'i'), '').trim();
    }

    // Remove common trailing numbers/quality/codec tags that might be part of release names but not title
    cleanedTitle = cleanedTitle.replace(/\s+\d{3,4}p$/, '').trim(); // e.g., "Show Title 1080p" -> "Show Title"
    cleanedTitle = cleanedTitle.replace(/\s+(x264|x265|HEVC|H\.264|DD5\.1)$/i, '').trim(); // Remove common codecs/audio
    cleanedTitle = cleanedTitle.replace(/\s+WEBRip$/i, '').trim(); // Remove source
    cleanedTitle = cleanedTitle.replace(/\s+AMZN$/i, '').trim(); // Remove specific source identifier

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
 * This is now more lenient to identify season packs without explicit episode numbers
 * in the top-level name, but with matching season.
 * @param {object} parsedInfo - Parsed info from parseTorrentInfo.
 * @param {number} targetSeason - Target season number.
 * @param {number} targetEpisode - Target episode number.
 * @returns {boolean} True if a match, false otherwise.
 */
function isEpisodeMatch(parsedInfo, targetSeason, targetEpisode) {
  if (!parsedInfo) {
    return false;
  }

  // Case 1: Direct Episode Match (SxxExx or SxxE[start]-[end])
  const isDirectEpisodeMatch = (parsedInfo.season === targetSeason &&
                                (parsedInfo.episode === targetEpisode ||
                                 (Array.isArray(parsedInfo.episode) && parsedInfo.episode.includes(targetEpisode)) ||
                                 (parsedInfo.range && targetEpisode >= parsedInfo.range.start && targetEpisode <= parsedInfo.range.end)));

  // Case 2: Season Pack Match (Sxx without explicit Exx, but matches season)
  // This covers names like "Show.S01.Pack" or "Show.2025.S01.1080p" where ptt provides isCompleteSeason or seasonpack
  const isSeasonPackExplicit = (parsedInfo.season === targetSeason &&
                             (parsedInfo.episode === undefined || parsedInfo.episode === null || Array.isArray(parsedInfo.episode)) &&
                             (parsedInfo.isCompleteSeason || parsedInfo.seasonpack));

  // Case 3: General Season Match (Sxx present, but no explicit episode or pack flag from PTT)
  // This covers cases like "Revival.S01.400p.Ultradox" where PTT gives season but not isCompleteSeason/seasonpack
  // This implies it's a pack *if* there's no explicit episode.
  const isGeneralSeasonMatchImplicit = (parsedInfo.season === targetSeason &&
                                (parsedInfo.episode === undefined || parsedInfo.episode === null));


  if (isDirectEpisodeMatch || isSeasonPackExplicit || isGeneralSeasonMatchImplicit) {
    logger.debug(`Match found for S${targetSeason}E${targetEpisode} in parsed info: ${parsedInfo.originalName}. Type: ${
      isDirectEpisodeMatch ? 'Direct Episode' : isSeasonPackExplicit ? 'Season Pack Explicit' : 'General Season Implicit'
    }`);
    return true;
  }

  logger.debug(`No episode or season pack match for S${targetSeason}E${targetEpisode} in parsed info: ${JSON.stringify(parsedInfo)}`);
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
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null, parsedInfo: null };
  }

  // Only use the cleaned parsed torrent title for similarity
  const titleForSimilarity = cleanParsedTorrentTitle(parsedTorrent);

  const titleSimilarity = calculateSimilarity(titleForSimilarity || '', tmdbShowTitle);
  logger.debug(`Title similarity for "${titleForSimilarity}" vs "${tmdbShowTitle}": ${titleSimilarity.toFixed(2)}`);

  // Initial title similarity filter. This is the first gate.
  if (titleSimilarity < 0.5) {
    logger.debug(`Title similarity too low (${titleSimilarity.toFixed(2)}). Skipping torrent.`);
    return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null, parsedInfo: null };
  }
  score += titleSimilarity * 100; // Boost this heavily as it's the primary match factor


  let matchedFileIndex = null;
  let matchedFilePath = null;
  let finalParsedInfo = parsedTorrent; // This will hold the parsed info of the winning item (torrent or file)

  // Determine if we need to inspect individual files.
  // We MUST inspect files if:
  // 1. The torrent name itself is NOT a direct episode match (e.g., it's a season pack).
  // 2. The title similarity is high enough (>= 0.75) to warrant a deeper look, even if it *is* a direct episode match,
  //    to ensure we find the *best* file within multi-file torrents.
  const isTorrentDirectEpisodeMatch = (parsedTorrent.season === targetSeason && parsedTorrent.episode === targetEpisode);
  const needsFileInspection = !isTorrentDirectEpisodeMatch || titleSimilarity >= 0.75;


  if (needsFileInspection) {
    logger.debug(`Torrent is a potential pack or title similarity is high enough (${titleSimilarity.toFixed(2)}). Inspecting individual files for "${torrentName}".`);

    let filesToProcess = torrent ? torrent.files : null;
    // If files are not embedded in the initial search result, fetch them directly from Bitmagnet.
    if (!filesToProcess || filesToProcess.length === 0) {
        logger.debug(`Files not available in search result for ${torrentInfoHash}, attempting to fetch directly.`);
        if (torrentInfoHash && torrentInfoHash !== 'N/A') {
            try {
                filesToProcess = await bitmagnet.getTorrentFiles(torrentInfoHash);
            } catch (err) {
                logger.error(`Error fetching individual files for ${torrentInfoHash}: ${err.message}. Skipping file inspection.`);
                filesToProcess = []; // Ensure it's an empty array on error
            }
        } else {
            logger.warn(`Cannot fetch files, torrent infoHash is invalid for "${torrentName}". Skipping file inspection.`);
            filesToProcess = [];
        }
    }

    if (filesToProcess && filesToProcess.length > 0) {
      let currentBestFileScore = -Infinity; // Keep track of the best file score found within this torrent
      let bestFileParsedInfo = null;

      for (const file of filesToProcess) {
        const parsedFile = parseTorrentInfo(file.path);
        if (parsedFile) {
          const isFileEpisodeMatch = isEpisodeMatch(parsedFile, targetSeason, targetEpisode); // Use refined isEpisodeMatch
          if (isFileEpisodeMatch) {
            // Score the individual file, boosting it significantly
            const fileTitleForSimilarity = cleanParsedTorrentTitle(parsedFile);
            const fileScore = 500 + calculateSimilarity(fileTitleForSimilarity, tmdbShowTitle) * 50; // Boost for file title
            
            if (fileScore > currentBestFileScore) {
              currentBestFileScore = fileScore;
              matchedFileIndex = file.index;
              matchedFilePath = file.path;
              bestFileParsedInfo = parsedFile;
              logger.debug(`Found better file match in "${torrentName}": "${file.path}". Score: ${fileScore}`);
            }
          }
        } else {
            logger.warn(`Could not parse file path: "${file.path}" within torrent "${torrentName}".`);
        }
      }

      if (bestFileParsedInfo && currentBestFileScore > -Infinity) {
          score += currentBestFileScore; // Add the score of the best matched file
          finalParsedInfo = bestFileParsedInfo; // Use file's parsed info for final output
          logger.debug(`Final parsed info updated from best matching file.`);
      } else {
          // If it was a pack/potential pack but no specific file matched the episode, penalize.
          logger.warn(`Torrent was a pack/potential pack, but no specific file for S${targetSeason}E${targetEpisode} found in files: "${torrentName}". Penalizing.`);
          return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null, parsedInfo: null };
      }
    } else {
        logger.warn(`No files found for torrent "${torrentName}" (InfoHash: ${torrentInfoHash}) that could be processed for file-level matching, and it required file inspection. Penalizing.`);
        return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null, parsedInfo: null };
    }
  } else {
      // If it's a direct single-episode torrent (as per PTT) and does not need file inspection
      matchedFileIndex = 0; // Assume index 0 for single file torrents if not explicitly found.
      matchedFilePath = torrentName; // Use torrent name as path if single file
      logger.debug(`Torrent "${torrentName}" is a direct single episode torrent, assuming main file at index 0.`);
      // Score already includes base 1000 for direct episode match.
  }

  // If after all checks, we still don't have a valid parsedInfo (e.g., if the initial parse failed
  // and no file-level match saved it), return -Infinity.
  if (!finalParsedInfo) {
      return { torrent: bitmagnetItem, score: -Infinity, matchedFileIndex: null, matchedFilePath: null, parsedInfo: null };
  }

  // Language Scoring (using finalParsedInfo for quality and language)
  const torrentLanguages = bitmagnetItem.languages ? bitmagnetItem.languages.map(lang => lang.id.toLowerCase()) : [];
  let languageScore = 0;
  let foundLanguage = false;

  for (const preferredLang of preferredLanguages) {
    if (torrentLanguages.includes(preferredLang)) {
      languageScore = LANGUAGE_PREFERENCE_SCORES[preferredLang] || 0;
      foundLanguage = true;
      logger.debug(`Torrent has preferred language "${preferredLang}" from Bitmagnet. Base language score: ${languageScore}.`);
      break;
    }
    // Check for aliases (e.g., 'tam' for 'tamil', 'eng' for 'en')
    if ((preferredLang === 'tam' && torrentLanguages.includes('tamil')) || (preferredLang === 'eng' && torrentLanguages.includes('en'))) {
        languageScore = LANGUAGE_PREFERENCE_SCORES[preferredLang] || 0; // Use the score of the alias or the full name
        foundLanguage = true;
        logger.debug(`Torrent has language matching preferred alias '${preferredLang}' from Bitmagnet. Base language score: ${languageScore}.`);
        break;
    }
  }

  if (!foundLanguage && finalParsedInfo.languages && finalParsedInfo.languages.length > 0) {
      const parsedTorrentLang = finalParsedInfo.languages[0].toLowerCase();
      let pttLanguageScore = LANGUAGE_PREFERENCE_SCORES[parsedTorrentLang] || 0;
      if (parsedTorrentLang === 'tamil' && !pttLanguageScore) pttLanguageScore = LANGUAGE_PREFERENCE_SCORES['tam'];
      if (parsedTorrentLang === 'english' && !pttLanguageScore) pttLanguageScore = LANGUAGE_PREFERENCE_SCORES['en'];

      if (pttLanguageScore > 0) {
        languageScore = pttLanguageScore;
        foundLanguage = true;
        logger.debug(`Torrent parsed language "${parsedTorrentLang}" from PTT has score: ${languageScore}.`);
      }
  }

  if (!foundLanguage) {
      languageScore = LANGUAGE_PREFERENCE_SCORES['en'] || 0; // Default to English score if no language found
      logger.debug(`Torrent has no specified language. Defaulting to English score: ${languageScore}.`);
  }
  score += languageScore;


  // Prioritize torrents with more seeders
  score += (bitmagnetItem.seeders || 0) * 0.1;

  // Prefer higher quality (using finalParsedInfo)
  if (finalParsedInfo.resolution === '2160p') score += 20;
  else if (finalParsedInfo.resolution === '1080p') score += 15;
  else if (finalParsedInfo.resolution === '720p') score += 10;
  if (finalParsedInfo.hdr) score += 5;
  if (finalParsedInfo.dolbyvision) score += 5;


  return {
    torrent: bitmagnetItem,
    score: score,
    matchedFileIndex: matchedFileIndex,
    matchedFilePath: matchedFilePath,
    parsedInfo: finalParsedInfo // Ensure this is the most accurate parsed info (torrent or file)
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
  parseTorrentInfo, // Renamed from parseFilename for clarity
  findBestTorrentMatch,
  cleanParsedTorrentTitle // Export for potential testing/reuse
};
