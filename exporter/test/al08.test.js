'use strict';

/**
 * AL08 collector verification tests.
 *
 * Exercises parseToMetrics() directly with the exact AL08 source structure —
 * no S3, no metrics registry needed. Covers:
 *   - monitor_type + total_sessions + all legacy metrics
 *   - session_info with ALL 11 source fields as labels (exact values)
 *   - 22 field-validation metrics (present/distinct per field)
 *   - empty-string presence semantics (TCODE="")
 *   - numeric 0 preservation (SESSION_ID/TYPE/STAT/MEMORY)
 *   - duplicate records counted, not collapsed
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'warn';

const { parseToMetrics } = require('../src/json-parser');

const EXACT_SAMPLE = {
  monitor_type: 'AL08',
  data: [
    {
      SESSION_ID: 3,
      CLIENT: '000',
      USERID: 'SAP_WSRT',
      TCODE: '',
      TERMINAL: 'SAPIDES.waddaya.com',
      TIME: '121127',
      SESSION: '  1',
      TYPE: 32,
      STAT: 2,
      SERVER_NAME: 'SAPIDES_JCI_00',
      MEMORY: 4265,
    },
  ],
};

const EXPECTED_LABELS = [
  'session_id',
  'client',
  'userid',
  'tcode',
  'terminal',
  'time',
  'session',
  'type',
  'stat',
  'server_name',
  'memory',
];

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

describe('AL08 collector', () => {
  test('exact sample: monitor_type, total_sessions and all legacy metrics', () => {
    const { metrics, parseError } = parseToMetrics(JSON.stringify(EXACT_SAMPLE), 'AL08', 'sap');
    expect(parseError).toBeNull();
    expect(metrics.length).toBeGreaterThan(0);

    // Top-level monitor_type
    const monitorType = find(metrics, 'sap_al08_monitor_type_count');
    expect(monitorType).toBeDefined();
    expect(monitorType.labels.monitor_type).toBe('AL08');
    expect(monitorType.value).toBe(1);

    // Legacy metrics (names + semantics preserved)
    expect(find(metrics, 'sap_al08_total_sessions').value).toBe(1);
    expect(find(metrics, 'sap_al08_logged_users').value).toBe(1);
    expect(find(metrics, 'sap_al08_client_count', (m) => m.labels.client === '000').value).toBe(1);
    expect(find(metrics, 'sap_al08_user_count', (m) => m.labels.user === 'SAP_WSRT').value).toBe(1);
    expect(find(metrics, 'sap_al08_terminal_count', (m) => m.labels.terminal === 'SAPIDES.waddaya.com').value).toBe(1);
    expect(find(metrics, 'sap_al08_host_count', (m) => m.labels.host === 'SAPIDES_JCI_00').value).toBe(1);
    expect(find(metrics, 'sap_al08_type_count', (m) => m.labels.type === '32').value).toBe(1);
    expect(find(metrics, 'sap_al08_status_count', (m) => m.labels.stat === '2').value).toBe(1);
    // TCODE is empty in the sample → tcode_count emits no blank-label series
    expect(metrics.some((m) => m.fullName === 'sap_al08_tcode_count')).toBe(false);
  });

  test('session_info carries all 11 source fields as labels with exact raw values', () => {
    const { metrics } = parseToMetrics(JSON.stringify(EXACT_SAMPLE), 'AL08', 'sap');
    const info = find(metrics, 'sap_al08_session_info');
    expect(info).toBeDefined();
    expect(info.value).toBe(1);

    // 1:1 label ↔ source-field coverage
    expect(Object.keys(info.labels).sort()).toEqual([...EXPECTED_LABELS].sort());

    expect(info.labels.session_id).toBe('3');
    expect(info.labels.client).toBe('000');
    expect(info.labels.userid).toBe('SAP_WSRT');
    expect(info.labels.tcode).toBe(''); // empty string preserved, not dropped
    expect(info.labels.terminal).toBe('SAPIDES.waddaya.com');
    expect(info.labels.time).toBe('121127');
    expect(info.labels.session).toBe('  1'); // raw value incl. leading spaces
    expect(info.labels.type).toBe('32');
    expect(info.labels.stat).toBe('2');
    expect(info.labels.server_name).toBe('SAPIDES_JCI_00');
    expect(info.labels.memory).toBe('4265');
  });

  test('all 11 fields have _present and _distinct validation metrics (22 total)', () => {
    const { metrics } = parseToMetrics(JSON.stringify(EXACT_SAMPLE), 'AL08', 'sap');
    const names = new Set(metrics.map((m) => m.fullName));
    for (const field of EXPECTED_LABELS) {
      expect(names.has(`sap_al08_${field}_present`)).toBe(true);
      expect(names.has(`sap_al08_${field}_distinct`)).toBe(true);
    }
    const validationCount = metrics.filter((m) => /_present$|_distinct$/.test(m.fullName)).length;
    expect(validationCount).toBe(22);
  });

  test('empty TCODE counts as absent for _present but stays observable in session_info', () => {
    const { metrics } = parseToMetrics(JSON.stringify(EXACT_SAMPLE), 'AL08', 'sap');
    expect(find(metrics, 'sap_al08_tcode_present').value).toBe(0);
    expect(find(metrics, 'sap_al08_tcode_distinct').value).toBe(0);
    expect(find(metrics, 'sap_al08_session_info').labels.tcode).toBe('');
  });

  test('numeric 0 values are preserved and counted as present (not missing)', () => {
    const payload = {
      monitor_type: 'AL08',
      data: [
        {
          SESSION_ID: 0,
          CLIENT: '000',
          USERID: 'ZEROUSER',
          TCODE: 'X',
          TERMINAL: 'term',
          TIME: '000000',
          SESSION: '0',
          TYPE: 0,
          STAT: 0,
          SERVER_NAME: 'srv',
          MEMORY: 0,
        },
      ],
    };
    const { metrics } = parseToMetrics(JSON.stringify(payload), 'AL08', 'sap');
    const info = find(metrics, 'sap_al08_session_info');
    expect(info.labels.session_id).toBe('0');
    expect(info.labels.type).toBe('0');
    expect(info.labels.stat).toBe('0');
    expect(info.labels.memory).toBe('0');

    // 0 is present, not missing
    expect(find(metrics, 'sap_al08_memory_present').value).toBe(1);
    expect(find(metrics, 'sap_al08_type_present').value).toBe(1);
    expect(find(metrics, 'sap_al08_session_id_present').value).toBe(1);
    expect(find(metrics, 'sap_al08_type_distinct').value).toBe(1);
    // 0 appears on the legacy type_count label too
    expect(find(metrics, 'sap_al08_type_count', (m) => m.labels.type === '0').value).toBe(1);
  });

  test('duplicate records are counted, not collapsed', () => {
    const dup = { ...EXACT_SAMPLE.data[0] };
    const payload = { monitor_type: 'AL08', data: [dup, { ...dup }, { ...dup }] };
    const { metrics } = parseToMetrics(JSON.stringify(payload), 'AL08', 'sap');
    expect(find(metrics, 'sap_al08_total_sessions').value).toBe(3);
    expect(metrics.filter((m) => m.fullName === 'sap_al08_session_info').length).toBe(3);
    expect(find(metrics, 'sap_al08_logged_users').value).toBe(1);
    expect(find(metrics, 'sap_al08_session_id_distinct').value).toBe(1);
  });
});