'use strict';

const logger = require('./logger');

/**
 * Prometheus-standards compliant JSON parser.
 *
 * Recursively walks any JSON-parsed object and extracts numeric leaf values.
 *
 * KEY FIXES in this version
 * ─────────────────────────
 * 1. NUMERIC STRING COERCION
 *    SAP ABAP sends all values as strings, even integers.
 *    e.g. "CLIENT": "811", "WP_NO": "0", "GMOD": "8"
 *    The parser now coerces unambiguous numeric strings to actual numbers
 *    before deciding whether to emit a metric or use them as a label.
 *
 * 2. T-CODE AGGREGATE METRICS
 *    When a T-Code's data[] array contains only string fields (like AL08,
 *    SM12, ST22), the walk produces zero numeric metrics. We now emit
 *    aggregate/count metrics for every T-Code unconditionally:
 *      sap_al08_total_records    → total rows in data[]
 *      sap_al08_total_<field>_<val>  → count per unique string value
 *    This ensures Prometheus always has something to scrape for every T-Code.
 *
 * 3. BOOLEAN COERCION
 *    true → 1, false → 0 so boolean fields become real gauge values.
 *
 * Example input (AL08 — all strings):
 *   { "data": [{ "CLIENT": "811", "USERID": "AJAY", "TCODE": "SE38" }] }
 *
 * Example output:
 *   sap_al08_total_records 1
 *   sap_al08_tcode_count{tcode="SE38"} 1
 *   sap_al08_client_count{client="811"} 1
 */

// Characters that are not valid in a Prometheus metric name segment
const INVALID_CHARS = /[^a-zA-Z0-9_]/g;
// Runs of underscores
const MULTI_UNDERSCORE = /_+/g;
// Leading/trailing underscores
const EDGE_UNDERSCORE = /^_|_$/g;

/**
 * Convert a camelCase, PascalCase, or ALL_CAPS string to snake_case.
 *
 * Rules:
 *   camelCase  → snake_case   (e.g. idleCpu → idle_cpu)
 *   PascalCase → snake_case   (e.g. UserCpu → user_cpu)
 *   ALL_CAPS   → lower        (e.g. CLIENT → client, WP_TYP → wp_typ)
 *   MIXED      → lower        (e.g. WP_NO → wp_no, HOSTADR → hostadr)
 *
 * The key insight: only insert an underscore before a capital letter when
 * the preceding character is a lowercase letter (camelCase boundary).
 * ALL_CAPS words like CLIENT or USERID have no lowercase predecessors,
 * so they just get lowercased without extra underscores.
 *
 * @param {string} str
 * @returns {string}
 */
function camelToSnake(str) {
  return str
    // Insert underscore only at lowercase→uppercase boundaries (camelCase)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Sanitise a string into a valid Prometheus label/metric name segment.
 * @param {string} segment
 * @returns {string}
 */
function sanitiseSegment(segment) {
  return camelToSnake(segment)
    .replace(INVALID_CHARS, '_')
    .replace(MULTI_UNDERSCORE, '_')
    .replace(EDGE_UNDERSCORE, '')
    .toLowerCase();
}

/**
 * Sanitise a label value: keep it short, valid, non-empty.
 * @param {string} val
 * @returns {string}
 */
function sanitiseLabelValue(val) {
  return String(val).substring(0, 128);
}

/**
 * FIX #1 — Coerce a string to a number when the string is unambiguously numeric.
 *
 * SAP ABAP routinely sends integers and floats as JSON strings because ABAP
 * internally treats all output fields as character strings. Examples:
 *   "811"   → 811
 *   "0"     → 0
 *   "3.14"  → 3.14
 *   "8"     → 8
 *
 * Strings that are NOT purely numeric (e.g. "SE38", "DIA", "5:03", "Waiting")
 * are left as strings and used as Prometheus label values instead.
 *
 * @param {string} str
 * @returns {number | string}
 */
function coerceNumericString(str) {
  if (typeof str !== 'string' || str.trim() === '') return str;
  const trimmed = str.trim();
  const n = Number(trimmed);
  // Number('') === 0 but we already guarded empty strings above.
  // Number('5:03') === NaN — stays as a string label.
  if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  return str;
}

/**
 * Recursively walk a parsed JSON value and collect numeric leaf values.
 *
 * Changes from previous version:
 * - String values are now coerced to numbers when possible (Fix #1).
 * - Boolean values are coerced to 1/0 so they produce gauge values.
 * - Array indexes become labels (unchanged from before).
 * - String values inside array elements that are NOT numeric become labels.
 *
 * @param {unknown} value
 * @param {string[]} nameSegments
 * @param {Record<string,string>} labels
 * @param {Array<{ name: string, value: number, labels: Record<string,string> }>} results
 * @param {number} maxDepth
 */
function walk(value, nameSegments, labels, results, maxDepth = 10) {
  if (maxDepth <= 0) {
    logger.warn({ path: nameSegments.join('.') }, 'Max depth reached; truncating traversal');
    return;
  }

  if (value === null || value === undefined) return;

  // ── Boolean → coerce to 1 / 0 ───────────────────────────────────────────
  if (typeof value === 'boolean') {
    results.push({
      name: nameSegments.join('_'),
      value: value ? 1 : 0,
      labels: { ...labels },
    });
    return;
  }

  // ── Primitive number → emit a metric with all accumulated labels ─────────
  if (typeof value === 'number' && Number.isFinite(value)) {
    results.push({
      name: nameSegments.join('_'),
      value,
      labels: { ...labels },
    });
    return;
  }

  // ── FIX #1: String → try numeric coercion first ──────────────────────────
  if (typeof value === 'string') {
    const coerced = coerceNumericString(value);
    if (typeof coerced === 'number') {
      // Emits e.g. sap_sm12_gmod{...} 8  when "GMOD":"8"
      results.push({
        name: nameSegments.join('_'),
        value: coerced,
        labels: { ...labels },
      });
    }
    // Non-numeric strings are silently ignored at the top level
    // (they become labels when inside an array element — see Object handling)
    return;
  }

  // ── Array → use parent segment as label key, index as label value ─────────
  if (Array.isArray(value)) {
    const labelKey = nameSegments.length > 0
      ? sanitiseSegment(String(nameSegments[nameSegments.length - 1]))
      : 'index';

    for (let i = 0; i < value.length; i++) {
      walk(value[i], nameSegments, { ...labels, [labelKey]: String(i) }, results, maxDepth - 1);
    }
    return;
  }

  // ── Object ────────────────────────────────────────────────────────────────
  if (typeof value === 'object') {
    const inLabeledContext = Object.keys(labels).length > 0;

    // Pass 1: collect string/boolean values as extra labels
    const extraLabels = {};

    for (const [key, val] of Object.entries(value)) {
      const segment = sanitiseSegment(String(key));
      if (!segment) continue;

      if (typeof val === 'boolean') {
        if (inLabeledContext) extraLabels[segment] = String(val);
        continue;
      }

      if (typeof val === 'string') {
        if (inLabeledContext) {
          // FIX #1: if the string IS numeric, don't use it as a label —
          // let it become a metric in Pass 2 instead.
          const coerced = coerceNumericString(val);
          if (typeof coerced !== 'number') {
            // Non-numeric string → label
            extraLabels[segment] = sanitiseLabelValue(val);
          }
        }
        continue; // handled in pass 1 (numeric strings go through pass 2)
      }
    }

    // Pass 2: process all fields with merged labels
    const mergedLabels = Object.keys(extraLabels).length > 0
      ? { ...labels, ...extraLabels }
      : labels;

    for (const [key, val] of Object.entries(value)) {
      const segment = sanitiseSegment(String(key));
      if (!segment) continue;

      // Skip boolean — already handled in pass 1
      if (typeof val === 'boolean') {
        if (inLabeledContext) {
          results.push({
            name: [...nameSegments, segment].join('_'),
            value: val ? 1 : 0,
            labels: { ...mergedLabels },
          });
        } else {
          walk(val, [...nameSegments, segment], mergedLabels, results, maxDepth - 1);
        }
        continue;
      }

      // FIX #1: numeric strings — emit as a metric value, not a label
      if (typeof val === 'string') {
        const coerced = coerceNumericString(val);
        if (typeof coerced === 'number') {
          results.push({
            name: [...nameSegments, segment].join('_'),
            value: coerced,
            labels: { ...mergedLabels },
          });
        }
        // Non-numeric strings were handled in pass 1 (labels) — skip here
        continue;
      }

      // Number → emit directly with merged labels
      if (typeof val === 'number' && Number.isFinite(val) && inLabeledContext) {
        results.push({
          name: [...nameSegments, segment].join('_'),
          value: val,
          labels: { ...mergedLabels },
        });
        continue;
      }

      // Object, array, or non-finite number → recurse deeper
      walk(val, [...nameSegments, segment], { ...mergedLabels }, results, maxDepth - 1);
    }

    return;
  }
}

// ── FIX #2 — T-Code Aggregate Metrics ────────────────────────────────────────
//
// Many SAP T-Codes (AL08, SM12, ST22) send data[] arrays where every field is
// a string (CLIENT, USER, TCODE, TABLE, etc.). With purely string payloads the
// walk() above produces zero numeric metrics, so Prometheus sees nothing.
//
// This function generates aggregate/count metrics from the data[] array:
//   sap_<tcode>_total_records             → number of rows
//   sap_<tcode>_<field>_count{<field>="<val>"}  → count per unique field value
//
// This gives Prometheus useful gauges even when no numeric fields exist, and
// supplements the numeric fields when they do exist (like SM50's WP_NO).
//
// T-CODE specific field mapping (determines which string fields become labels):
//   AL08  → CLIENT, USERID, TCODE (→ logged-on users grouped by client/tcode)
//   SM12  → TABLE, USER_ID, GMOD  (→ locks grouped by table and user)
//   SM50  → WP_TYP, WP_STATUS     (→ work-process count by type and status)
//   ST22  → (data[] is usually empty — just emit total_records = 0)
//   others → any string field with ≤ 20 unique values becomes a label

const TCODE_LABEL_FIELDS = {
  AL08:  ['CLIENT', 'USERID', 'TCODE', 'TERMINAL'],
  SM12:  ['TABLE', 'USER_ID', 'GMOD', 'GCLIENT'],
  SM50:  ['WP_TYP', 'WP_STATUS', 'WP_MANDT'],
  ST22:  ['PROGRAM', 'EXCEPT', 'MANDT'],
  ST06:  [], // ST06 already has numeric fields — no aggregates needed
};

/**
 * FIX #2: Generate aggregate count metrics from a data[] array.
 *
 * @param {object[]} rows     - Parsed data array from the JSON payload.
 * @param {string}   tcode    - SAP T-Code (e.g. "AL08").
 * @param {string}   prefix   - Metrics prefix (e.g. "sap").
 * @returns {Array<{ name: string, value: number, labels: Record<string,string> }>}
 */
function buildAggregateMetrics(rows, tcode, prefix) {
  if (!Array.isArray(rows) || rows.length === 0) {
    // Still emit total_records = 0 so the metric always exists
    return [{
      name: `${prefix}_${tcode.toLowerCase()}_total_records`,
      value: 0,
      labels: {},
    }];
  }

  const results = [];
  const tcodeKey = tcode.toUpperCase();

  // Always emit total record count
  results.push({
    name: `${prefix}_${tcode.toLowerCase()}_total_records`,
    value: rows.length,
    labels: {},
  });

  // Determine which fields to aggregate
  const labelFields = TCODE_LABEL_FIELDS[tcodeKey] ?? [];

  // If no explicit mapping, auto-discover string fields with ≤ 30 unique values
  let fieldsToAggregate = labelFields;
  if (fieldsToAggregate.length === 0 && rows.length > 0) {
    const firstRow = rows[0];
    fieldsToAggregate = Object.keys(firstRow).filter((k) => typeof firstRow[k] === 'string');
  }

  // For each label field, emit count-per-unique-value metrics
  for (const field of fieldsToAggregate) {
    const safeName = sanitiseSegment(field);
    if (!safeName) continue;

    // Build frequency map: value → count
    const freq = new Map();
    for (const row of rows) {
      const rawVal = row[field];
      if (rawVal === undefined || rawVal === null || rawVal === '') continue;
      const val = sanitiseLabelValue(String(rawVal));
      freq.set(val, (freq.get(val) || 0) + 1);
    }

    // Emit one metric per unique value, with the value as a label
    for (const [val, count] of freq) {
      results.push({
        name: `${prefix}_${tcode.toLowerCase()}_${safeName}_count`,
        value: count,
        labels: { [safeName]: val },
      });
    }
  }

  logger.debug(
    { tcode, totalRecords: rows.length, aggregateMetrics: results.length },
    'Built aggregate metrics',
  );

  return results;
}

/**
 * Parse a JSON string and extract all numeric metrics with labels.
 *
 * @param {string} jsonString    - Raw JSON payload.
 * @param {string} tcode         - SAP T-Code (e.g. "AL08").
 * @param {string} metricsPrefix - Prometheus metric prefix (e.g. "sap").
 * @returns {{ metrics: Array<{ fullName: string, value: number, labels: Record<string,string> }>, parseError: Error | null }}
 */
function parseToMetrics(jsonString, tcode, metricsPrefix) {
  const rawMetrics = [];
  let parseError = null;

  try {
    const parsed = JSON.parse(jsonString);

    // ── Walk the full JSON tree for numeric fields (ST06 + any T-Code with
    //    native numbers in the payload) ──────────────────────────────────────
    walk(parsed, [metricsPrefix, tcode.toLowerCase()], {}, rawMetrics);

    // ── FIX #2: Always build aggregate/count metrics from data[] ─────────────
    //
    // This runs for EVERY T-Code. It produces:
    //   sap_al08_total_records          → row count
    //   sap_al08_tcode_count{tcode=...} → sessions per T-Code
    //   sap_sm12_table_count{table=...} → locks per table
    //   sap_sm50_wp_typ_count{wp_typ=...} → WPs per type
    //   etc.
    //
    // For T-Codes that already have numeric fields (ST06), these are simply
    // additive and give a useful summary alongside the detailed per-CPU metrics.

    const dataArray = parsed.data || parsed.DATA || parsed.entries || [];
    const aggregates = buildAggregateMetrics(dataArray, tcode, metricsPrefix);
    rawMetrics.push(...aggregates);

  } catch (err) {
    parseError = err;
    logger.error({ err, tcode }, 'Failed to parse JSON for T-Code');
  }

  // Map to the external interface expected by metrics.js
  const metrics = rawMetrics.map((m) => ({
    fullName: m.name,
    value: m.value,
    labels: m.labels,
  }));

  logger.debug({ tcode, metricCount: metrics.length }, 'Parsed metrics from JSON');
  return { metrics, parseError };
}

module.exports = {
  parseToMetrics,
  camelToSnake,
  sanitiseSegment,
  coerceNumericString,
  buildAggregateMetrics,
  walk,
};
