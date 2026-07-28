'use strict';

const pino = require('pino');
const config = require('./config');

/**
 * Structured logger built on Pino.
 *
 * In development (NODE_ENV !== 'production') the output is prettified
 * for human readability. In production it emits newline-delimited JSON
 * for consumption by log aggregators (e.g. ELK, Loki, Datadog).
 *
 * If pino-pretty is not installed (e.g. Docker production image),
 * the logger gracefully falls back to standard JSON output without crashing.
 */

// Determine transport — gracefully fall back if pino-pretty is unavailable
let transport;

if (config.log.pretty) {
  try {
    require.resolve('pino-pretty');
    transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    };
  } catch (_) {
    // pino-pretty not installed — fall back to standard JSON logging silently
    transport = undefined;
  }
}

const logger = pino({
  level: config.log.level,
  transport,
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  redact: {
    paths: ['aws.accessKeyId', 'aws.secretAccessKey'],
    censor: '***',
  },
});

module.exports = logger;
