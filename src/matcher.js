/**
 * src/matcher.js
 * Intelligent Torrent File Matching & Pruning
 * Contains logic for parsing torrent titles, fuzzy matching, and selecting the best torrent file.
 */

const parseTorrentTitle = require('parse-torrent-title');
const { levenshteinDistance, logger } = require('./utils');
const config = require('../config');

// Set a default threshold for Levenshtein distance if not specified in config
const LEVENSHTEIN_THRESHOLD = config.levenshteinThreshold;

/**
 * Parses a torrent filename using parse-torrent-title.
 * @param {string} filename - The torrent filename.
 * @returns {object|null} Parsed info or null if parsing fails.
 */
function parseFilename(filename) {
  try {
    const parsed = parseTorrentTitle.parse(filename);
    return parsed;
  } catch (error) {
    logger.warn(`Failed to parse torrent filename "${filename}": ${error.message}`);
    return null;
  }
}

/**
 * Calculates a confidence score based on Levenshtein distance.
 * Lower distance means higher similarity (better match).
 * @param {string} str1 - First string.
 * @param {string} str2 - Second string.
 * @returns {number} Confidence score (0 to 1), where 1 is perfect match.
 */
function calculateLevenshteinConfidence(str1, str2) {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLength = Math.max(str1.length, str2.length);
  // Avoid division by zero if both strings are empty
  if (maxLength === 0) return 1;
  return 1 - (distance / maxLength);
}

/**
 * Matches a torrent entry (or a file within a torrent) against a target TMDB episode.
 * Prioritizes based on season/episode match, then title similarity.
 * @param {object} torrentOrFile - The parsed torrent or file object.
 * @param {object} tmdbEpisode - The TMDB episode object (with title, season_number, episode_number).
 * @param {string} tmdbShowTitle - The canonical TMDB show title.
 * @returns {number} A score representing how well it matches. Higher is better.
 * - Infinity for no match, positive for good matches.
 */
function scoreMatch(torrentOrFile, tmdbEpisode, tmdbShowTitle) {
  const { title, season, episode, episodes } = torrentOrFile;
  const targetSeason = tmdbEpisode.season_number;
  const targetEpisode = tmdbEpisode.episode_number;
  const targetTitle = tmdbShowTitle; // Use show title for main fuzzy matching

  let score = 0;

  // 1. Exact Season/Episode Match (Highest Priority)
  // Check if it's a single episode or a season pack containing the episode
  const isSingleEpisode = season === targetSeason && episode === targetEpisode;
  const isSeasonPackContainingEpisode = (season === targetSeason && episodes && episodes.includes(targetEpisode));
  const isRangeContainingEpisode = (season === targetSeason && torrentOrFile.range &&
                                    targetEpisode >= torrentOrFile.range.start && targetEpisode <= torrentOrFile.range.end);

  if (isSingleEpisode) {
    score += 1000; // High score for direct SxxExx match
    logger.debug(`Direct S${targetSeason}E${targetEpisode} match for ${title}`);
  } else if (isSeasonPackContainingEpisode || isRangeContainingEpisode) {
    score += 500; // Good score for season pack/range that contains the episode
    logger.debug(`Season pack/range match for S${targetSeason}E${targetEpisode} in ${title}`);
  } else {
    // If neither directly matches the episode, it's probably not the right one or needs deeper file inspection.
    // Return a very low score if it's not a direct episode match unless further logic is added for files.
    // For now, only allow if the torrent contains the episode in its name or file list
    // (This simplified score assumes parse-torrent-title already handled simple episode extraction from packs)
    if (!(season === targetSeason && episode && typeof episode === 'object' && episode.includes(targetEpisode))) {
       // If it's not a direct episode, and not a parsed pack containing the episode, then it's a poor match.
       // This needs refinement with actual file inspection.
       return -Infinity; // No match if season/episode doesn't align at all
    }
  }

  // 2. Fuzzy Matching on Show Title (Important for variations)
  if (title) {
    const distance = levenshteinDistance(title, targetTitle);
    const normalizedDistance = distance / Math.max(title.length, targetTitle.length);

    if (distance <= LEVENSHTEIN_THRESHOLD) {
      // Award score based on inverse of distance (closer to 0 is better)
      score += (LEVENSHTEIN_THRESHOLD - distance) * 10;
      logger.debug(`Title fuzzy match for "${title}" vs "${targetTitle}". Distance: ${distance}`);
    } else {
      // If title is too different, penalize heavily or discard.
      // For now, we penalize, but can be adjusted to return -Infinity if strict.
      score -= 50;
      logger.debug(`Title fuzzy match too high for "${title}" vs "${targetTitle}". Distance: ${distance}`);
    }
  } else {
    // No title to compare, penalize slightly.
    score -= 5;
  }

  // 3. Language Preference (if available in parsed_info_json)
  // Assuming 'languages' array might be present from parse-torrent-title or Bitmagnet tags
  const preferredLanguages = config.preferredLanguages ? config.preferredLanguages.split(',').map(lang => lang.trim().toLowerCase()) : ['en'];
  if (torrentOrFile.languages && torrentOrFile.languages.some(lang => preferredLanguages.includes(lang.toLowerCase()))) {
    score += 50; // Boost for preferred language
    logger.debug(`Preferred language match for ${torrentOrFile.languages}`);
  }

  // 4. Quality (Resolution) Preference (future enhancement)
  // You can add logic here to prioritize 1080p over 720p, etc.
  // Example: if (torrentOrFile.resolution === '1080p') score += 20;

  // 5. Codec/Source Preference (future enhancement)
  // Example: if (torrentOrFile.codec === 'x265') score += 10;

  // 6. Seeders (already handled by Bitmagnet's orderBy, but can be a tie-breaker)
  if (torrentOrFile.seeders) {
      // Add a small score based on seeders, normalized or capped
      score += Math.min(torrentOrFile.seeders / 10, 50); // Max 50 points for seeders
  }


  return score;
}

/**
 * Matches torrents from Bitmagnet against a specific TMDB episode.
 * This is the core "intelligent matching" function.
 * @param {Array<object>} bitmagnetTorrents - Array of raw torrent objects from Bitmagnet.
 * @param {object} tmdbEpisode - The TMDB episode object.
 * @param {string} tmdbShowTitle - The canonical TMDB show title.
 * @param {Array<object>} bitmagnetTorrentFiles - (Optional) Array of file objects for the torrent, if already fetched.
 * @returns {Array<object>} Filtered and scored torrents, sorted by best match.
 */
async function findBestTorrentMatch(bitmagnetTorrents, tmdbEpisode, tmdbShowTitle, bitmagnetTorrentFiles = []) {
  logger.info(`Starting intelligent matching for S${tmdbEpisode.season_number}E${tmdbEpisode.episode_number} of "${tmdbShowTitle}"`);
  const matchedTorrents = [];

  for (const torrent of bitmagnetTorrents) {
    const { name: torrentName, infoHash, files: torrentFilesFromBitmagnet } = torrent;
    logger.debug(`Processing torrent: "${torrentName}" (InfoHash: ${infoHash})`);

    // First, try to parse the overall torrent name
    const parsedTorrent = parseFilename(torrentName);

    if (!parsedTorrent) {
      logger.warn(`Could not parse overall torrent name: "${torrentName}". Skipping.`);
      continue;
    }

    // Determine if the torrent is an exact episode match, a season pack, or a range
    const isSingleEpisodeTorrent = parsedTorrent.season === tmdbEpisode.season_number && parsedTorrent.episode === tmdbEpisode.episode_number;
    const isSeasonPackOrRange = parsedTorrent.seasons || parsedTorrent.episodes || parsedTorrent.range;

    let bestFileMatch = null;
    let fileMatchScore = -Infinity; // Initialize with a very low score

    if (isSingleEpisodeTorrent) {
      // If the torrent name itself is an exact match for the episode, score it directly
      const score = scoreMatch(parsedTorrent, tmdbEpisode, tmdbShowTitle);
      if (score > -Infinity) {
        matchedTorrents.push({
          torrent: { ...torrent, parsed: parsedTorrent },
          score: score,
          matchedFileIndex: null, // No specific file index needed if torrent is single episode
          matchedFilePath: null,
        });
        logger.debug(`Torrent "${torrentName}" is a single episode direct match. Score: ${score}`);
      }
    } else if (isSeasonPackOrRange) {
      // If it's a pack/range, we need to inspect the files within the torrent
      let filesToParse = torrentFilesFromBitmagnet || bitmagnetTorrentFiles.filter(f => f.infoHash === infoHash);

      // If files are not available from the initial Bitmagnet search, you might need to fetch them
      // via getTorrentFiles(infoHash) here if the Bitmagnet API supports it as a separate query
      // (as outlined in the research, `TorrentFiles.graphql` implies this)
      // For now, assuming files are either present in `torrentFilesFromBitmagnet` or passed in `bitmagnetTorrentFiles`.
      if (filesToParse.length === 0) {
        logger.warn(`No file list available for pack/range torrent: "${torrentName}". Skipping file matching.`);
        continue;
      }

      logger.debug(`Inspecting ${filesToParse.length} files within pack: "${torrentName}"`);
      for (const file of filesToParse) {
        const parsedFile = parseFilename(file.path);
        if (parsedFile) {
          // Check if the file name contains the target episode
          const isFileEpisodeMatch = parsedFile.season === tmdbEpisode.season_number && parsedFile.episode === tmdbEpisode.episode_number;
          if (isFileEpisodeMatch) {
            // Score the individual file within the pack
            const currentFileScore = scoreMatch(parsedFile, tmdbEpisode, tmdbShowTitle);
            if (currentFileScore > fileMatchScore) {
              fileMatchScore = currentFileScore;
              bestFileMatch = {
                torrent: { ...torrent, parsed: parsedTorrent }, // Store the parent torrent and its overall parse
                score: currentFileScore,
                matchedFileIndex: file.index,
                matchedFilePath: file.path,
                fileParsed: parsedFile, // Store parsed info for the file
              };
              logger.debug(`Found better file match in "${torrentName}": "${file.path}". Score: ${currentFileScore}`);
            }
          }
        } else {
            logger.warn(`Could not parse file path: "${file.path}" within torrent "${torrentName}".`);
        }
      }

      if (bestFileMatch && bestFileMatch.score > -Infinity) {
        matchedTorrents.push(bestFileMatch);
      }
    } else {
      logger.debug(`Torrent "${torrentName}" is not a direct episode or identifiable pack. Skipping.`);
    }
  }

  // Sort by score in descending order (highest score first)
  matchedTorrents.sort((a, b) => b.score - a.score);

  logger.info(`Finished matching. Found ${matchedTorrents.length} potential torrents.`);
  return matchedTorrents;
}


/**
 * Normalizes a string for better fuzzy matching.
 * Converts to lowercase, removes non-alphanumeric characters (except spaces),
 * and removes common stop words or common release artifacts.
 * @param {string} str - The input string.
 * @returns {string} The normalized string.
 */
function normalizeString(str) {
  if (!str) return '';
  // Convert to lowercase, remove common symbols/punctuation, replace multiple spaces
  return str.toLowerCase()
            .replace(/[\(\)\[\]\{\}\-_\.:,!?'"&]/g, ' ') // Replace common symbols with space
            .replace(/\s+/g, ' ') // Replace multiple spaces with single space
            .trim();
}

/**
 * Calculates Levenshtein distance with string normalization.
 * @param {string} s1 - First string.
 * @param {string} s2 - Second string.
 * @returns {number} Normalized Levenshtein distance.
 */
function normalizedLevenshteinDistance(s1, s2) {
    const norm1 = normalizeString(s1);
    const norm2 = normalizeString(s2);
    return levenshteinDistance(norm1, norm2);
}

module.exports = {
  parseFilename,
  findBestTorrentMatch,
  levenshteinDistance: normalizedLevenshteinDistance, // Exporting normalized version
  scoreMatch // For testing/debugging purposes
};
