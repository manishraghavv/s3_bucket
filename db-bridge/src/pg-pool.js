'use strict';

const { Pool } = require('pg');
const logger = require('./logger');

let pool;

/**
 * Get or create the singleton PostgreSQL connection pool.
 * @returns {import('pg').Pool}
 */
function getPgPool() {
  if (pool) return pool;

  pool = new Pool({
    host: process.env.POSTGRES_HOST || 'timescaledb',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'sapmonitor',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'sap_monitoring',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'PostgreSQL pool error');
  });

  logger.info(
    {
      host: process.env.POSTGRES_HOST,
      database: process.env.POSTGRES_DB,
    },
    'PostgreSQL pool created',
  );

  return pool;
}

module.exports = { getPgPool };
