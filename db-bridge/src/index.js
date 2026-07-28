'use strict';

/**
 * SAP DB Bridge
 * =============
 * Reads the latest SAP JSON payloads from S3 for each T-Code
 * and writes parsed records into TimescaleDB hypertables.
 *
 * Architecture:
 *   S3 (JSON files) → DB Bridge → TimescaleDB
 *
 * Runs on a configurable interval (default: 60s).
 * Uses the same S3 client and file-processor as the exporter.
 */

const S3ClientWrapper = require('./s3-client');
const { resolveLatestFiles } = require('./file-processor');
const { getPgPool } = require('./pg-pool');
const { insertAL08 } = require('./parsers/al08');
const { insertSM12 } = require('./parsers/sm12');
const { insertSM50 } = require('./parsers/sm50');
const { insertST06 } = require('./parsers/st06');
const { insertST22 } = require('./parsers/st22');
const logger = require('./logger');

const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_SECONDS || '60', 10) * 1000;
const TENANT = process.env.SAP_TENANT || 'DEFAULT';

// Map T-Codes to parser functions
const PARSER_MAP = {
  AL08: insertAL08,
  SM12: insertSM12,
  SM50: insertSM50,
  ST06: insertST06,
  ST22: insertST22,
};

const s3 = new S3ClientWrapper();

async function syncCycle() {
  const startTime = Date.now();
  logger.info('━━━ DB Bridge sync cycle started ━━━');

  try {
    // 1. List S3 objects
    const objects = await s3.listObjects();
    if (objects.length === 0) {
      logger.warn('No objects in S3 bucket — skipping sync');
      return;
    }

    // 2. Get latest file per T-Code
    const latestFiles = resolveLatestFiles(objects);

    // 3. Process each T-Code
    const pool = getPgPool();
    const results = await Promise.allSettled(
      Array.from(latestFiles.entries()).map(async ([tcode, fileInfo]) => {
        const parser = PARSER_MAP[tcode];
        if (!parser) {
          logger.debug({ tcode }, 'No parser registered for T-Code — skipping');
          return;
        }

        try {
          logger.info({ tcode, key: fileInfo.key }, 'Downloading and parsing…');
          const body = await s3.getObject(fileInfo.key);
          const data = JSON.parse(body);
          const rowsInserted = await parser(pool, data, TENANT, fileInfo.lastModified);
          logger.info({ tcode, rowsInserted }, 'Inserted rows into TimescaleDB ✓');
        } catch (err) {
          logger.error({ err, tcode }, 'Failed to process T-Code');
          throw err;
        }
      }),
    );

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected').length;
    const durationMs = Date.now() - startTime;

    logger.info(
      { successes, failures, durationMs },
      '━━━ DB Bridge sync cycle complete ━━━',
    );
  } catch (err) {
    logger.error({ err }, 'Sync cycle failed');
  }
}

async function main() {
  logger.info({ tenant: TENANT, intervalMs: SYNC_INTERVAL_MS }, 'SAP DB Bridge starting');

  // Verify AWS connectivity
  try {
    await s3.verifyConnection();
  } catch (err) {
    logger.fatal({ err }, 'S3 connection failed — exiting');
    process.exit(1);
  }

  // Verify DB connectivity
  const pool = getPgPool();
  try {
    await pool.query('SELECT 1');
    logger.info('TimescaleDB connection verified ✓');
  } catch (err) {
    logger.fatal({ err }, 'TimescaleDB connection failed — exiting');
    process.exit(1);
  }

  // Run initial sync immediately, then on interval
  await syncCycle();
  setInterval(syncCycle, SYNC_INTERVAL_MS);
}

process.on('SIGTERM', () => { logger.info('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received'); process.exit(0); });

main();
