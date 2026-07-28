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
let lastJsonAgeSeconds = 0;

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

// ── Metrics endpoint ────────────────────────────────────────────────────

app.get(config.server.metricsPath, async (_req, res) => {
  const startTime = Date.now();

  try {
    // ═══════════════════════════════════════════════════════════════════
    // STAGE 1 — List all objects from S3 bucket
    // ═══════════════════════════════════════════════════════════════════
    logger.info('━━━ Scrape cycle started ━━━');
    const objects = await s3.listObjects();
    logger.info({ totalObjects: objects.length }, 'S3 listObjects complete');

    if (objects.length === 0) {
      logger.warn('No objects found in S3 bucket');
      res.set('Content-Type', getRegistry().contentType);
      res.end(await getRegistry().metrics());
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STAGE 2 — Group by T-Code, select latest per T-Code
    // ═══════════════════════════════════════════════════════════════════
    const latestFiles = resolveLatestFiles(objects);

    if (latestFiles.size === 0) {
      logger.warn('No matching JSON files found in S3 bucket');
      res.set('Content-Type', getRegistry().contentType);
      res.end(await getRegistry().metrics());
      return;
    }

    // Log every T-Code that was resolved
    const tcodeEntries = Array.from(latestFiles.entries());
    for (const [tcode, info] of tcodeEntries) {
      logger.info(
        { tcode, latestFile: info.key, lastModified: info.lastModified?.toISOString() },
        'Found T-Code → latest file',
      );
    }

    // Log skipped objects (non-JSON or unrecognised filename pattern)
    const matchedCount = tcodeEntries.reduce((sum, [, info]) => sum + 1, 0);
    const skippedCount = objects.length - matchedCount;
    if (skippedCount > 0) {
      logger.warn({ skippedCount, totalObjects: objects.length }, 'Objects skipped (non-JSON or unrecognised T-Code pattern)');
    }

    // ═══════════════════════════════════════════════════════════════════
    // STAGE 3 — Reset Prometheus gauges from previous scrape
    // ═══════════════════════════════════════════════════════════════════
    logger.info('Resetting all gauges from previous scrape');
    resetAllGauges();

    // ═══════════════════════════════════════════════════════════════════
    // STAGE 4 — Download & parse latest file for EVERY T-Code
    // ═══════════════════════════════════════════════════════════════════
    let successCount = 0;
    let errorCount = 0;
    /** @type {Array<{ fullName: string, value: number, labels?: Record<string,string> }>} */
    const allMetrics = [];

    const downloadPromises = [];

    for (const [tcode, fileInfo] of latestFiles) {
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
              return;
            }

            if (metrics.length === 0) {
              logger.warn({ tcode, key: fileInfo.key }, 'Parsed OK but zero numeric metrics found → skipped');
              errorCount++;
              return;
            }

            // ── Collect into combined batch ─────────────────────
            // DO NOT call updateMetrics() here — collect all T-Code
            // metrics first, THEN register once (below).
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
          }
        })(),
      );
    }

    await Promise.all(downloadPromises);

    // ── Register ALL SAP metrics in a single updateMetrics() call ──
    if (allMetrics.length > 0) {
      updateMetrics(allMetrics);
    }

    // ── Update exporter stats for health endpoint and Prometheus ──
    const duration = Date.now() - startTime;
    lastScrapeDuration = duration;
    lastScrapeSuccessCount = successCount;
    lastScrapeErrorCount = errorCount;
    lastScrapeTotalTcodes = latestFiles.size;
    lastScrapeTotalMetrics = allMetrics.length;
    lastScrapeTimestamp = Date.now();

    // Track latest file info from the last tcode in the list
    if (tcodeEntries.length > 0) {
      const [tcode, info] = tcodeEntries[tcodeEntries.length - 1];
      lastJsonKey = info.key;
      lastJsonTcode = tcode;
      lastJsonAgeSeconds = info.lastModified
        ? Math.floor((Date.now() - info.lastModified.getTime()) / 1000)
        : 0;
    }

    // ── Emit exporter stats as Prometheus metrics ──
    const statsMetrics = [
      { fullName: `${config.metrics.prefix}_exporter_scrape_duration_seconds`, value: parseFloat((duration / 1000).toFixed(3)), labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_scrape_success_total`, value: successCount, labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_scrape_error_total`, value: errorCount, labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_scrape_tcodes_total`, value: latestFiles.size, labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_scrape_metrics_total`, value: allMetrics.length, labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_scrape_timestamp_seconds`, value: parseFloat((lastScrapeTimestamp / 1000).toFixed(3)), labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_json_age_seconds`, value: lastJsonAgeSeconds, labels: {} },
      { fullName: `${config.metrics.prefix}_exporter_uptime_seconds`, value: Math.floor(process.uptime()), labels: {} },
    ];
    updateMetrics(statsMetrics);

    logger.info(
      {
        tcodesFound: latestFiles.size,
        tcodesProcessed: successCount,
        errors: errorCount,
        totalMetrics: allMetrics.length,
        durationMs: duration,
      },
      '━━━ Scrape cycle complete ━━━',
    );

    res.set('Content-Type', getRegistry().contentType);
    res.end(await getRegistry().metrics());
  } catch (err) {
    logger.error({ err }, 'Metrics scrape cycle failed');

    // Still serve whatever metrics we have, even if the scrape failed partially
    try {
      res.set('Content-Type', getRegistry().contentType);
      res.end(await getRegistry().metrics());
    } catch (serveErr) {
      logger.error({ err: serveErr }, 'Failed to serve metrics after error');
      res.status(500).json({
        status: 'error',
        message: 'Failed to scrape metrics',
      });
    }
  }
});

// ── Start server (after credential verification) ───────────────────────
//
// The server only starts listening AFTER the AWS credential check passes.
// This ensures the container healthcheck never returns UP with bad creds.

verifyAwsCredentials().then(() => {
  app.listen(config.server.port, config.server.host, () => {
    readiness.server = true;
    readiness.startedAt = Date.now();

    logger.info(
      {
        port: config.server.port,
        host: config.server.host,
        metricsPath: config.server.metricsPath,
        bucket: config.aws.bucket,
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
