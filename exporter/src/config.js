'use strict';

const path = require('path');

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Common placeholder patterns found in .env.example templates.
 * These values MUST never be used at runtime.
 */
const PLACEHOLDER_PATTERNS = [
  // .env.example patterns (new format: YOUR_AWS_ACCESS_KEY_ID_HERE, etc.)
  /^YOUR_\w+(?:_\w+)*_HERE$/,
  // .env.example patterns (old format)
  /^your[-_]\w+(?:[-_]\w+)*[-_]here$/i,
  /^your[-_]\w+(?:[-_]\w+)*[-_]key[-_]id$/i,
  /^your[-_]secret[-_]\w+(?:[-_]\w+)*$/i,
  /^your[-_]access[-_]\w+(?:[-_]\w+)*$/i,
  /^replace[-_]\w+(?:[-_]\w+)*$/i,
  /^placeholder/i,
  /^your[-_]sap[-_]\w+/,
];

/**
 * Check if a value matches any known placeholder pattern.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Log credential source information without exposing secrets.
 * Called once during startup after config is validated.
 *
 * @param {{ region: string, bucket: string, source: string }} info
 */
function logCredentialSource(info) {
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  AWS Credential Verification');
  console.log('══════════════════════════════════════════════');
  console.log(`  Source        : ${info.source}`);
  console.log(`  Region        : ${info.region}`);
  console.log(`  Bucket        : ${info.bucket}`);
  console.log('  Access Key ID : *** (present)');
  console.log('  Secret Key    : *** (present)');
  console.log('══════════════════════════════════════════════');
  console.log('');
}

/**
 * Determine whether the .env file was loaded from disk or the environment
 * variables came from the parent process / Docker Compose.
 *
 * @param {boolean} loadedFromFile - Whether dotenv successfully loaded .env
 * @returns {string}
 */
function detectCredentialSource(loadedFromFile) {
  if (loadedFromFile) {
    return '.env file (loaded by dotenv)';
  }

  // Check for Docker environment indicator
  if (process.env.DOCKER_CONTAINER === 'true') {
    return 'Docker Compose env_file';
  }

  // If AWS creds are set but dotenv didn't load, they came from the OS
  if (process.env.AWS_ACCESS_KEY_ID) {
    return 'System environment variables (Docker Compose / shell export)';
  }

  // Fallback
  return 'Environment variables';
}

// ── Load .env from disk ─────────────────────────────────────────────────
//
// Try to load .env from the project root (two levels up from src/).
// Examples:
//   New structure:   exporter/src/config.js  → ../../.env = project root
//   Docker:          /app/src/config.js      → ../../.env = /
//
// Inside Docker, the .env file is excluded from the image (see .dockerignore).
// Docker Compose passes env vars via its env_file directive instead.
// The dotenv load below will silently fail in Docker — which is expected.

let envLoadedFromFile = false;

try {
  // .env is at the project root (../../ from exporter/src/)
  const envPath = path.resolve(__dirname, '..', '..', '.env');
  const result = require('dotenv').config({ path: envPath });
  if (result && result.parsed) {
    envLoadedFromFile = true;
  }
} catch (_) {
  // .env file not found; using parent / system environment variables
}

// ── Build config object ─────────────────────────────────────────────────

/** @type {{ region: string, bucket: string, accessKeyId: string|undefined, secretAccessKey: string|undefined, sessionToken: string|undefined, endpoint: string|undefined, s3ForcePathStyle: boolean }} */
const awsConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
  bucket: process.env.S3_BUCKET_NAME || 'mkill',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
  endpoint: process.env.AWS_ENDPOINT || undefined,
  s3ForcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
};

const config = Object.freeze({
  aws: awsConfig,

  server: {
    port: parseInt(process.env.EXPORTER_PORT, 10) || 9105,
    host: process.env.EXPORTER_HOST || '0.0.0.0',
    metricsPath: process.env.METRICS_PATH || '/metrics',
    healthPath: process.env.HEALTH_PATH || '/health',
  },

  metrics: {
    prefix: process.env.METRICS_PREFIX || 'sap',
    defaultLabels: {
      exporter: 'sap-prometheus-exporter',
      version: '1.0.0',
    },
  },

  s3: {
    requestTimeout: parseInt(process.env.S3_REQUEST_TIMEOUT, 10) || 10000,
    maxRetries: parseInt(process.env.S3_MAX_RETRIES, 10) || 3,
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
    pretty: process.env.NODE_ENV !== 'production',
  },
});

// ── Validation ───────────────────────────────────────────────────────────
// Phase 1: Check that required values exist and are not empty

const requiredKeys = [
  ['aws', 'accessKeyId'],
  ['aws', 'secretAccessKey'],
];

const missing = requiredKeys.filter((keys) => {
  let val = config;
  for (const k of keys) {
    val = val[k];
  }
  return val === undefined || val === null || val === '';
});

if (missing.length > 0) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Missing required AWS credentials                ║');
  console.error('╠══════════════════════════════════════════════════════════╣');
  console.error(`║  Missing: ${missing.map((k) => k.join('.')).join(', ').padEnd(41)}║`);
  console.error('║                                                          ║');
  console.error('║  Set these in the .env file at the project root:         ║');
  console.error('║    AWS_ACCESS_KEY_ID=your-real-key                       ║');
  console.error('║    AWS_SECRET_ACCESS_KEY=your-real-secret                ║');
  console.error('║                                                          ║');
  console.error('║  Or export them directly in your shell.                  ║');
  console.error('╚══════════════════════════════════════════════════════════╝');
  console.error('');
  process.exit(1);
}

// Phase 2: Reject placeholder values that slipped through from .env.example

const credentialKeys = [
  { key: 'AWS_ACCESS_KEY_ID', value: awsConfig.accessKeyId },
  { key: 'AWS_SECRET_ACCESS_KEY', value: awsConfig.secretAccessKey },
];

const placeholders = credentialKeys.filter(({ value }) => isPlaceholder(value));
if (placeholders.length > 0) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Placeholder AWS credential detected                     ║');
  console.error('╠══════════════════════════════════════════════════════════════════╣');
  console.error('║  The following environment variable(s) contain placeholder      ║');
  console.error('║  values instead of real credentials:                            ║');
  console.error('║                                                                ║');
  for (const { key } of placeholders) {
    console.error(`║    ✗ ${key.padEnd(52)}║`);
  }
  console.error('║                                                                ║');
  console.error('║  Edit .env in the project root and replace them with your       ║');
  console.error('║  actual IAM Access Key and Secret Access Key from AWS.         ║');
  console.error('║                                                                ║');
  console.error('║  Then restart the exporter.                                     ║');
  console.error('╚══════════════════════════════════════════════════════════════════╝');
  console.error('');
  process.exit(1);
}

// ── Credential source logging ────────────────────────────────────────────
// Log where credentials came from (without exposing secrets)

const source = envLoadedFromFile
  ? '.env file (loaded by dotenv)'
  : detectCredentialSource(false);

logCredentialSource({
  source,
  region: awsConfig.region,
  bucket: awsConfig.bucket,
});

module.exports = config;
