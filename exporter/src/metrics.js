'use strict';

const promClient = require('prom-client');
const logger = require('./logger');
const config = require('./config');

/**
 * Dynamic Prometheus metric registry.
 *
 * Gauges are created on-the-fly when a new metric name is encountered.
 * Once registered, a gauge persists for the lifetime of the process.
 * This means the registry automatically supports new T-Codes and new
 * JSON fields without code changes or restarts.
 *
 * Supports dynamic labels – when a parsed metric includes labels (e.g.
 * `{ cpu: "0" }`), the gauge is registered with those label names
 * alongside the static default labels.
 *
 * The collector registry is reset before each scrape so that stale
 * metrics from removed T-Codes or vanished label combinations are
 * cleaned up.
 */

// Global Prometheus registry
const register = new promClient.Registry();

// Enable default metrics (Node.js process metrics)
promClient.collectDefaultMetrics({
  register,
  prefix: `${config.metrics.prefix}_node_`,
});

/**
 * In-memory cache of registered Gauge instances keyed by metric name.
 * @type {Map<string, promClient.Gauge>}
 */
const gaugeCache = new Map();

/**
 * Get or create a Gauge for the given fully-qualified metric name.
 *
 * Supports dynamic labels: the gauge is registered with the union of
 * the static default labels (exporter, version) and any additional
 * labels discovered at scrape time (e.g. cpu, client, user).
 *
 * @param {string} metricName     - Full metric name, e.g. "sap_st06_cpu_idle".
 * @param {string[]} [labelNames] - Dynamic label names discovered during parsing.
 * @returns {promClient.Gauge}
 */
function getOrCreateGauge(metricName, labelNames = []) {
  const cacheKey = metricName;

  if (gaugeCache.has(cacheKey)) {
    return gaugeCache.get(cacheKey);
  }

  // Combine static default labels with dynamic labels (deduped)
  const allLabelNames = [...new Set([
    ...Object.keys(config.metrics.defaultLabels),
    ...labelNames,
  ])];

  const gauge = new promClient.Gauge({
    name: metricName,
    help: `SAP metric: ${metricName}`,
    registers: [register],
    labelNames: allLabelNames,
  });

  // Initialize with default labels at 0 (the gauge will be available
  // even if no scrape data arrives).
  gauge.set(config.metrics.defaultLabels, 0);

  gaugeCache.set(cacheKey, gauge);
  logger.debug({ metricName, labelNames: allLabelNames }, 'Registered new Prometheus Gauge');
  return gauge;
}

/**
 * Update metrics from a batch of parsed values.
 *
 * Each metric can optionally carry dynamic labels that are merged with
 * the static default labels before the gauge value is set.
 *
 * @param {Array<{ fullName: string, value: number, labels?: Record<string,string> }>} metrics
 */
function updateMetrics(metrics) {
  for (const { fullName, value, labels = {} } of metrics) {
    try {
      const gauge = getOrCreateGauge(fullName, Object.keys(labels));

      // Merge dynamic labels over the top of default labels
      const allLabels = { ...config.metrics.defaultLabels, ...labels };
      gauge.set(allLabels, value);
    } catch (err) {
      logger.error({ err, metricName: fullName }, 'Failed to set metric value');
    }
  }
}

/**
 * Reset all registered gauges to zero.
 *
 * Uses prom-client's `reset()` method which clears ALL time series for
 * every registered gauge. This is more thorough than the previous
 * per-label-combination reset and correctly handles gauges with
 * dynamic labels whose label value combinations change between scrapes.
 */
function resetAllGauges() {
  for (const [name, gauge] of gaugeCache) {
    try {
      gauge.reset();
      // Re-seed default labels at 0 so the metrics endpoint always
      // has at least one time series per gauge.
      gauge.set(config.metrics.defaultLabels, 0);
    } catch (err) {
      logger.error({ err, metricName: name }, 'Failed to reset gauge');
    }
  }
}

/**
 * Expose the registry for the /metrics endpoint.
 *
 * @returns {import('prom-client').Registry}
 */
function getRegistry() {
  return register;
}

module.exports = {
  getOrCreateGauge,
  updateMetrics,
  resetAllGauges,
  getRegistry,
};
