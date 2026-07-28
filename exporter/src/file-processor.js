'use strict';

const logger = require('./logger');

/**
 * File-processor groups S3 objects by SAP T-Code and selects the
 * latest file for each group using S3's LastModified property.
 *
 * T-Code is extracted from file names matching the convention:
 *   {TCODE}_{ISO_TIMESTAMP}.json
 *
 * Examples:
 *   AL08_2026-07-27T06-29-13.json  →  AL08
 *   SM50_2026-07-27T06-29-11.json  →  SM50
 */

// Match T-CODE at the start of the filename (uppercase letters + optional digits)
const TCODE_PATTERN = /^([A-Z][A-Z0-9]{2,})_/;
// Only process .json files
const JSON_EXTENSION = '.json';

/**
 * Extract the T-Code from an S3 object key.
 *
 * @param {string} key - S3 object key (filename).
 * @returns {string|null} T-Code or null if the key doesn't match the pattern.
 */
function extractTCode(key) {
  const basename = key.split('/').pop() || key;
  if (!basename.endsWith(JSON_EXTENSION)) return null;
  const match = basename.match(TCODE_PATTERN);
  return match ? match[1] : null;
}

/**
 * Group S3 objects by T-Code.
 *
 * @param {import('@aws-sdk/client-s3')._Object[]} objects
 * @returns {Map<string, import('@aws-sdk/client-s3')._Object[]>}
 */
function groupByTCode(objects) {
  /** @type {Map<string, import('@aws-sdk/client-s3')._Object[]>} */
  const groups = new Map();

  for (const obj of objects) {
    if (!obj.Key) continue;
    const tcode = extractTCode(obj.Key);
    if (!tcode) continue;

    if (!groups.has(tcode)) {
      groups.set(tcode, []);
    }
    groups.get(tcode).push(obj);
  }

  logger.debug({ tcodes: Array.from(groups.keys()) }, 'Grouped objects by T-Code');
  return groups;
}

/**
 * Select the latest object for each T-Code group based on LastModified.
 *
 * @param {Map<string, import('@aws-sdk/client-s3')._Object[]>} groups
 * @returns {Map<string, import('@aws-sdk/client-s3')._Object>}
 */
function selectLatestPerGroup(groups) {
  /** @type {Map<string, import('@aws-sdk/client-s3')._Object>} */
  const latest = new Map();

  for (const [tcode, objects] of groups) {
    // Sort descending by LastModified — most recent first
    const sorted = [...objects].sort((a, b) => {
      const aTime = a.LastModified?.getTime() || 0;
      const bTime = b.LastModified?.getTime() || 0;
      return bTime - aTime;
    });

    latest.set(tcode, sorted[0]);
    logger.debug(
      { tcode, latestKey: sorted[0].Key, lastModified: sorted[0].LastModified?.toISOString() },
      'Selected latest file for T-Code',
    );
  }

  return latest;
}

/**
 * High-level processor: given S3 objects, return a Map of
 * { T-Code → { key, lastModified } } for the latest file of each T-Code.
 *
 * @param {import('@aws-sdk/client-s3')._Object[]} objects
 * @returns {Map<string, { key: string, lastModified: Date }>}
 */
function resolveLatestFiles(objects) {
  const groups = groupByTCode(objects);
  const latest = selectLatestPerGroup(groups);

  const result = new Map();
  for (const [tcode, obj] of latest) {
    result.set(tcode, {
      key: obj.Key,
      lastModified: obj.LastModified,
    });
  }

  logger.info({ tcodeCount: result.size, tcodes: Array.from(result.keys()) }, 'Resolved latest files');
  return result;
}

module.exports = {
  extractTCode,
  groupByTCode,
  selectLatestPerGroup,
  resolveLatestFiles,
};
