'use strict';

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const S3ClientWrapper = require('./s3-client');
const { resolveLatestFiles } = require('./file-processor');
const { parseToMetrics } = require('./json-parser');
const { updateMetrics, resetAllGauges, getRegistry } = require('./metrics');

// ── Application readiness state ────────────────────────────────────────
// Track which components have been initialised so the health endpoint
// can report meaningful status to Docker and orchestrators.

/** @type {{ server: boolean, s3Client: boolean, awsVerified: boolean, startedAt: null|number }} */
const readiness = {
  server: false,
  s3Client: false,
  awsVerified: false,
  startedAt: null,
};

// ── Initialise ──────────────────────────────────────────────────────────

const app = express();
const s3 = new S3ClientWrapper();
readiness.s3Client = true;

// ── Verify AWS credentials at startup ───────────────────────────────────
//
// Before we start the HTTP server and accept metrics scrapes, make a
// lightweight request to S3 (ListObjectsV2 with MaxKeys=1) to confirm
// the credentials are valid and the bucket is accessible.
//
// If this fails, the process exits immediately with a clear diagnostic
// message instead of silently serving broken metrics or returning
// cryptic InvalidAccessKeyId errors at scrape time.

async function verifyAwsCredentials() {
  try {
    await s3.verifyConnection();
    readiness.awsVerified = true;
  } catch (err) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════════╗');
    console.error('║  AWS CREDENTIAL VERIFICATION FAILED                            ║');
    console.error('╠══════════════════════════════════════════════════════════════════╣');
    console.error('║  The exporter could not authenticate to AWS S3.                 ║');
    console.error('║  Check your .env file settings.                                ║');
    console.error('║                                                                ║');
    console.error(`║  ${err.message.padEnd(62)}║`);
    console.error('║                                                                ║');
    console.error('║  Fix the issue, then restart the exporter.                      ║');
    console.error('╚══════════════════════════════════════════════════════════════════╝');
    console.error('');
    process.exit(1);
  }
}

// Disable Express fingerprinting
app.set('x-powered-by', false);

// ── Prometheus metrics for exporter statistics ─────────────────────────
// These are emitted as part of the /metrics endpoint, separate from SAP data.

// We expose exporter stats as extra gauges attached at the end of updateMetrics().
// Stats are set before each metrics response.
let lastScrapeDuration = 0;
let lastScrapeSuccessCount = 0;
let lastScrapeErrorCount = 0;
let lastScrapeTotalTcodes = 0;
let lastScrapeTotalMetrics = 0;
let lastScrapeTimestamp = Date.now();
let lastJsonKey = '';
let lastJsonTcode = '';
let lastJsonFileTimestamp = null;
let lastJsonAgeSeconds = 0;

// ── S3 In-Memory Cache State ───────────────────────────────────────────
let lastCacheTimestamp = 0;
let hasCachedData = false;
let activeRefreshPromise = null;

// Cache parsed metrics per T-Code: tcode -> { key, lastModifiedTime, metrics }
const tcodeCache = new Map();

// ── Health endpoint ─────────────────────────────────────────────────────
//
// Returns 200 + { status: 'UP' } when the application is fully initialised
// and ready to serve requests. Returns 503 if any dependency is not ready.
//
// This endpoint is used by:
//   - Docker HEALTHCHECK (via curl)
//   - Orchestrators (Kubernetes liveness / readiness probes)
//   - Load balancer health checks

app.get(config.server.healthPath, (_req, res) => {
  const checks = {
    server: readiness.server,
    s3Client: readiness.s3Client,
    awsVerified: readiness.awsVerified,
  };

  const healthy = Object.values(checks).every(Boolean);

  const body = {
    status: healthy ? 'UP' : 'DOWN',
    checks,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    cache: {
      hasCachedData,
      cacheTtlSeconds: config.s3.cacheTtlSeconds,
      lastRefreshTimestamp: lastCacheTimestamp ? new Date(lastCacheTimestamp).toISOString() : null,
      ageSeconds: lastCacheTimestamp ? Math.floor((Date.now() - lastCacheTimestamp) / 1000) : null,
    },
    lastScrape: {
      durationMs: lastScrapeDuration,
      tcodesFound: lastScrapeTotalTcodes,
      successCount: lastScrapeSuccessCount,
      errorCount: lastScrapeErrorCount,
      metricsGenerated: lastScrapeTotalMetrics,
      lastFile: lastJsonKey,
      lastTcode: lastJsonTcode,
    },
  };

  res.status(healthy ? 200 : 503).json(body);
});

// ── S3 Refresh & Parsing Core ──────────────────────────────────────────

/**
 * Execute a complete S3 list, file selection, download, and metrics parsing cycle.
 * Atomically updates Prometheus metrics upon success.
 */
async function doRefreshS3Data() {
  const startTime = Date.now();
  logger.info('━━━ S3 Cache refresh cycle started ━━━');

  try {
    // ═══════════════════════════════════════════════════════════════════
    // STAGE 1 — List all objects from S3 bucket
    // ═══════════════════════════════════════════════════════════════════
    const objects = await s3.listObjects();
    logger.info({ totalObjects: objects.length }, 'S3 listObjects complete');

    if (objects.length === 0) {
      logger.warn('No objects found in S3 bucket');
      lastCacheTimestamp = Date.now();
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STAGE 2 — Group by T-Code, select latest per T-Code
    // ═══════════════════════════════════════════════════════════════════
    const latestFiles = resolveLatestFiles(objects);

    if (latestFiles.size === 0) {
      logger.warn('No matching JSON files found in S3 bucket');
      lastCacheTimestamp = Date.now();
      return;
    }

    const tcodeEntries = Array.from(latestFiles.entries());
    for (const [tcode, info] of tcodeEntries) {
      logger.info(
        { tcode, latestFile: info.key, lastModified: info.lastModified?.toISOString() },
        'Found T-Code → latest file',
      );
    }

    const matchedCount = tcodeEntries.length;
    const skippedCount = objects.length - matchedCount;
    if (skippedCount > 0) {
      logger.warn({ skippedCount, totalObjects: objects.length }, 'Objects skipped (non-JSON or unrecognised T-Code pattern)');
    }

    // ═══════════════════════════════════════════════════════════════════
    // STAGE 3 & 4 — Download & parse latest file for EVERY T-Code
    // ═══════════════════════════════════════════════════════════════════
    let successCount = 0;
    let errorCount = 0;
    /** @type {Array<{ fullName: string, value: number, labels?: Record<string,string> }>} */
    const allMetrics = [];
    const downloadPromises = [];

    for (const [tcode, fileInfo] of latestFiles) {
      const cached = tcodeCache.get(tcode);
      const fileModifiedTime = fileInfo.lastModified?.getTime() || 0;

      // Avoid re-downloading identical JSON file if key and LastModified have not changed
      if (cached && cached.key === fileInfo.key && cached.lastModifiedTime === fileModifiedTime) {
        logger.debug({ tcode, key: fileInfo.key }, 'File unchanged → reusing parsed metrics (skipped S3 GetObject)');
        allMetrics.push(...cached.metrics);
        successCount++;
        continue;
      }

      downloadPromises.push(
        (async () => {
          try {
            // ── Download ────────────────────────────────────────
            logger.info({ tcode, key: fileInfo.key }, 'Downloading…');
            const body = await s3.getObject(fileInfo.key);
            logger.info({ tcode, bytes: body.length }, 'Downloaded');

            // ── Parse ───────────────────────────────────────────
            const { metrics, parseError } = parseToMetrics(body, tcode, config.metrics.prefix);

            if (parseError) {
              logger.error({ tcode, key: fileInfo.key, err: parseError }, 'Parse FAILED → skipped');
              errorCount++;
              // Cache unparseable result so the same invalid file isn't repeatedly re-downloaded
              tcodeCache.set(tcode, {
                key: fileInfo.key,
                lastModifiedTime: fileModifiedTime,
                metrics: [],
              });
              return;
            }

            if (metrics.length === 0) {
              logger.warn({ tcode, key: fileInfo.key }, 'Parsed OK but zero numeric metrics found → skipped');
              errorCount++;
              // Cache zero-metric result (e.g. ST03N) so unchanged file is not re-downloaded every refresh
              tcodeCache.set(tcode, {
                key: fileInfo.key,
                lastModifiedTime: fileModifiedTime,
                metrics: [],
              });
              return;
            }

            // Cache successfully parsed metrics for this T-Code
            tcodeCache.set(tcode, {
              key: fileInfo.key,
              lastModifiedTime: fileModifiedTime,
              metrics,
            });

            allMetrics.push(...metrics);
            successCount++;

            const sampleNames = metrics.slice(0, 3).map((m) => m.fullName);
            logger.info(
              { tcode, metricCount: metrics.length, sampleNames },
              'Parsed ✓ → collected',
            );
          } catch (err) {
            logger.error({ err, tcode, key: fileInfo.key }, 'Download/parse FAILED');
            errorCount++;
            // If download failed but older cached metrics exist for this T-Code, keep them
            if (cached) {
              allMetrics.push(...cached.metrics);
              successCount++;
            }
          }
        })(),
      );
    }

    await Promise.all(downloadPromises);

    // Clean up tcodeCache for T-Codes no longer present in latestFiles
    for (const cachedTcode of tcodeCache.keys()) {
      if (!latestFiles.has(cachedTcode)) {
        tcodeCache.delete(cachedTcode);
      }
    }

    // ── Atomically register SAP metrics in Prometheus registry ──
    if (allMetrics.length > 0) {
      resetAllGauges();
      updateMetrics(allMetrics);
      hasCachedData = true;
    }

    // ── Update exporter stats for health endpoint and Prometheus ──
    const duration = Date.now() - startTime;
    lastScrapeDuration = duration;
    lastScrapeSuccessCount = successCount;
    lastScrapeErrorCount = errorCount;
    lastScrapeTotalTcodes = latestFiles.size;
    lastScrapeTotalMetrics = allMetrics.length;
    lastScrapeTimestamp = Date.now();
    lastCacheTimestamp = Date.now();

    // Track latest file info from the last tcode in the list
    if (tcodeEntries.length > 0) {
      const [tcode, info] = tcodeEntries[tcodeEntries.length - 1];
      lastJsonKey = info.key;
      lastJsonTcode = tcode;
      lastJsonFileTimestamp = info.lastModified ? info.lastModified.getTime() : null;
      lastJsonAgeSeconds = lastJsonFileTimestamp
        ? Math.floor((Date.now() - lastJsonFileTimestamp) / 1000)
        : 0;
    }

    logger.info(
      {
        tcodesFound: latestFiles.size,
        tcodesProcessed: successCount,
        errors: errorCount,
        totalMetrics: allMetrics.length,
        durationMs: duration,
      },
      '━━━ S3 Cache refresh cycle complete ━━━',
    );
  } catch (err) {
    logger.error({ err }, 'S3 Cache refresh cycle failed');
    if (hasCachedData) {
      logger.warn('Serving previously cached metrics despite S3 refresh failure');
    } else {
      logger.error('No cached metrics available; initial S3 load failed');
    }
  }
}

/**
 * Single-flight S3 refresh manager.
 * Ensures concurrent calls share the exact same in-flight S3 refresh promise
 * to prevent duplicate simultaneous S3 requests.
 *
 * @returns {Promise<void>}
 */
function refreshS3Data() {
  if (activeRefreshPromise) {
    logger.debug('S3 refresh already in progress; attaching to active refresh');
    return activeRefreshPromise;
  }

  activeRefreshPromise = doRefreshS3Data().finally(() => {
    activeRefreshPromise = null;
  });

  return activeRefreshPromise;
}

/**
 * Update dynamic exporter metrics (uptime, json age) before serving /metrics.
 */
function updateDynamicStats() {
  const currentUptime = Math.floor(process.uptime());
  const currentJsonAge = lastJsonFileTimestamp
    ? Math.floor((Date.now() - lastJsonFileTimestamp) / 1000)
    : lastJsonAgeSeconds;

  const statsMetrics = [
    { fullName: `${config.metrics.prefix}_exporter_scrape_duration_seconds`, value: parseFloat((lastScrapeDuration / 1000).toFixed(3)), labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_scrape_success_total`, value: lastScrapeSuccessCount, labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_scrape_error_total`, value: lastScrapeErrorCount, labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_scrape_tcodes_total`, value: lastScrapeTotalTcodes, labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_scrape_metrics_total`, value: lastScrapeTotalMetrics, labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_scrape_timestamp_seconds`, value: parseFloat((lastScrapeTimestamp / 1000).toFixed(3)), labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_json_age_seconds`, value: currentJsonAge, labels: {} },
    { fullName: `${config.metrics.prefix}_exporter_uptime_seconds`, value: currentUptime, labels: {} },
  ];
  updateMetrics(statsMetrics);
}

// ── Metrics endpoint ────────────────────────────────────────────────────

app.get(config.server.metricsPath, async (_req, res) => {
  const cacheTtlMs = config.s3.cacheTtlSeconds * 1000;
  const isCacheExpired = !hasCachedData || (Date.now() - lastCacheTimestamp >= cacheTtlMs);

  if (isCacheExpired) {
    if (!hasCachedData) {
      // Cold start: wait for initial S3 data load so first scrape receives valid metrics
      logger.info(
        { reason: 'no_cache', ttlSeconds: config.s3.cacheTtlSeconds },
        'Initial S3 load required before serving metrics…',
      );
      await refreshS3Data();
    } else {
      // Warm cache expired: refresh in background without blocking Prometheus scrape
      logger.debug(
        { reason: 'ttl_expired', ttlSeconds: config.s3.cacheTtlSeconds },
        'S3 cache expired; triggering non-blocking background refresh and serving cached metrics…',
      );
      refreshS3Data().catch((err) => {
        logger.error({ err }, 'Background S3 refresh failed; continuing to serve last known good metrics');
      });
    }
  } else {
    logger.debug(
      { ageMs: Date.now() - lastCacheTimestamp, ttlMs: cacheTtlMs },
      'Serving metrics from in-memory cache',
    );
  }

  try {
    updateDynamicStats();
    res.set('Content-Type', getRegistry().contentType);
    res.end(await getRegistry().metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to serve metrics after error');
    res.status(500).json({
      status: 'error',
      message: 'Failed to scrape metrics',
    });
  }
});

// ── Start server (after credential verification) ───────────────────────
//
// The server only starts listening AFTER the AWS credential check passes.
// This ensures the container healthcheck never returns UP with bad creds.

verifyAwsCredentials().then(async () => {
  // Pre-load S3 data once at startup before accepting traffic
  logger.info('Pre-loading S3 data into cache at startup…');
  try {
    await refreshS3Data();
  } catch (err) {
    logger.error({ err }, 'Initial S3 pre-load failed; will retry on first metrics scrape');
  }

  app.listen(config.server.port, config.server.host, () => {
    readiness.server = true;
    readiness.startedAt = Date.now();

    logger.info(
      {
        port: config.server.port,
        host: config.server.host,
        metricsPath: config.server.metricsPath,
        bucket: config.aws.bucket,
        cacheTtlSeconds: config.s3.cacheTtlSeconds,
      },
      'SAP Prometheus Exporter started',
    );
  });
});

// ── Graceful shutdown ───────────────────────────────────────────────────

process.on('SIGTERM', () => {
  readiness.server = false;
  logger.info('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  readiness.server = false;
  logger.info('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  readiness.server = false;
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  readiness.server = false;
  logger.error({ err: reason }, 'Unhandled rejection — exiting process');
  process.exit(1);
});
