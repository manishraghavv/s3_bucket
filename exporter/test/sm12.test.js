'use strict';

/**
 * SM12 collector verification tests.
 *
 * Exercises parseToMetrics() directly with the SM12 source structure — no S3,
 * no metrics registry needed. Covers:
 *   - the 17 scalar aggregate families (unchanged semantics)
 *   - sap_sm12_lock_info: one series per lock entry with ALL 17 source fields
 *     as raw snake_case labels
 *   - lock identity: distinct records (TRDIR/ZEXPORT_MONITOR vs
 *     TRDIR/ZPRG_TEMP2, different users, BGRFC entries) never collapse
 *   - raw value preservation (numeric GUSE/GTDATE stay "0"/"20260904",
 *     padded GTHOST keeps its dots, empty strings stay "")
 *   - 128-char label cap for long values (LOCK_ARG / GUSRVB / GTHOST)
 *   - legacy field fallbacks (GMOD / USER_ID-era payloads)
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'warn';

const { parseToMetrics } = require('../src/json-parser');

/** The 17 SM12 lock-entry source fields, as their lock_info label names. */
const LOCK_INFO_LABELS = [
  'table',
  'lock_arg',
  'user_id',
  'gmode',
  'gusr',
  'gusrvb',
  'guse',
  'gusevb',
  'gobj',
  'gclient',
  'guname',
  'gthost',
  'gtwp',
  'gtsysnr',
  'gtdate',
  'gttime',
  'gtmark',
];

// Exact new-format record (all 17 fields present).
const EXACT_SAMPLE = {
  monitor_type: 'SM12',
  data: [
    {
      TABLE: 'SPBGM_FUNCTION_INDICATOR',
      LOCK_ARG: 'TASK_SERVICE ...',
      USER_ID: '',
      GMODE: 'E',
      GUSR: '',
      GUSRVB: '...',
      GUSE: 0,
      GUSEVB: 1,
      GOBJ: 'E_PBGM_LOCK',
      GCLIENT: '000',
      GUNAME: 'SAP_WSRT',
      GTHOST: 'SAPIDES.........................',
      GTWP: 4,
      GTSYSNR: 0,
      GTDATE: 20260904,
      GTTIME: 104637,
      GTMARK: '',
    },
  ],
};

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function infoRows(metrics) {
  return metrics.filter((m) => m.fullName === 'sap_sm12_lock_info');
}

/** Canonical identity of one lock_info label set (all 17 labels sorted). */
function labelKey(labels) {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('|');
}

describe('SM12 collector', () => {
  test('aggregate families are emitted unchanged for the exact sample', () => {
    const { metrics, parseError } = parseToMetrics(JSON.stringify(EXACT_SAMPLE), 'SM12', 'sap');
    expect(parseError).toBeNull();

    // The 17 scalar aggregate families — semantics preserved.
    expect(find(metrics, 'sap_sm12_total_locks').value).toBe(1);
    expect(find(metrics, 'sap_sm12_exclusive_locks').value).toBe(1);
    expect(find(metrics, 'sap_sm12_shared_locks').value).toBe(0);
    expect(find(metrics, 'sap_sm12_other_locks').value).toBe(0);
    expect(find(metrics, 'sap_sm12_locked_tables').value).toBe(1);
    expect(find(metrics, 'sap_sm12_unique_users').value).toBe(1);
    expect(find(metrics, 'sap_sm12_guse_total').value).toBe(0);
    expect(find(metrics, 'sap_sm12_gusevb_total').value).toBe(1);
    expect(find(metrics, 'sap_sm12_gtwp_total').value).toBe(4);
    expect(find(metrics, 'sap_sm12_gtsysnr_total').value).toBe(0);
    expect(find(metrics, 'sap_sm12_lock_arg_present').value).toBe(1);
    expect(find(metrics, 'sap_sm12_lock_arg_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm12_user_id_present').value).toBe(0);
    expect(find(metrics, 'sap_sm12_gusr_present').value).toBe(0);
    expect(find(metrics, 'sap_sm12_gusrvb_present').value).toBe(1);
    expect(find(metrics, 'sap_sm12_gusrvb_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm12_gtmark_present').value).toBe(0);
  });

  test('lock_info carries all 17 source fields with exact raw values', () => {
    const { metrics } = parseToMetrics(JSON.stringify(EXACT_SAMPLE), 'SM12', 'sap');
    const rows = infoRows(metrics);
    expect(rows.length).toBe(1);
    const info = rows[0];
    expect(info.value).toBe(1);

    // 1:1 label ↔ source-field coverage
    expect(Object.keys(info.labels).sort()).toEqual([...LOCK_INFO_LABELS].sort());

    expect(info.labels.table).toBe('SPBGM_FUNCTION_INDICATOR');
    expect(info.labels.lock_arg).toBe('TASK_SERVICE ...');
    expect(info.labels.user_id).toBe(''); // empty string preserved, not dropped
    expect(info.labels.gmode).toBe('E');
    expect(info.labels.gusr).toBe('');
    expect(info.labels.gusrvb).toBe('...');
    expect(info.labels.guse).toBe('0'); // numeric 0 preserved as "0"
    expect(info.labels.gusevb).toBe('1');
    expect(info.labels.gobj).toBe('E_PBGM_LOCK');
    expect(info.labels.gclient).toBe('000');
    expect(info.labels.guname).toBe('SAP_WSRT');
    expect(info.labels.gthost).toBe('SAPIDES.........................'); // raw, padded
    expect(info.labels.gtwp).toBe('4');
    expect(info.labels.gtsysnr).toBe('0');
    expect(info.labels.gtdate).toBe('20260904'); // numeric date kept as-is
    expect(info.labels.gttime).toBe('104637');
    expect(info.labels.gtmark).toBe('');
  });

  test('distinct lock records never collapse into one series', () => {
    const base = {
      USER_ID: '',
      GUSR: '',
      GUSRVB: '',
      GUSE: 0,
      GUSEVB: 1,
      GOBJ: 'E_TABLE_LOCK',
      GCLIENT: '000',
      GTHOST: 'SAPIDES_JCI_00',
      GTWP: 4,
      GTSYSNR: 0,
      GTDATE: 20260904,
      GTTIME: 104637,
      GTMARK: '',
    };
    const payload = {
      monitor_type: 'SM12',
      data: [
        // Same table + same user, different lock arguments — must stay separate.
        { ...base, TABLE: 'TRDIR', LOCK_ARG: 'ZEXPORT_MONITOR', GMODE: 'E', GUNAME: 'AJAY' },
        { ...base, TABLE: 'TRDIR', LOCK_ARG: 'ZEMP_LIST_REPORT', GMODE: 'E', GUNAME: 'AJAY' },
        { ...base, TABLE: 'TRDIR', LOCK_ARG: 'ZPRG_TEMP2', GMODE: 'E', GUNAME: 'AJAY' },
        // Different table, different lock object.
        { ...base, TABLE: 'SEOCLSENQ', LOCK_ARG: 'ZCL_TCODES====================MGET', GMODE: 'E', GUNAME: 'AJAY', GOBJ: 'E_SEOCLSENQ' },
        // Different owning user (BGRFC inbound registration — shared mode).
        { ...base, TABLE: 'BGRFC_O_SERVER_REGISTRATION', LOCK_ARG: 'SERVER_O', GMODE: 'S', GUNAME: 'ARIBA_ADDON' },
        // BGRFC outbound registration — other mode.
        { ...base, TABLE: 'BGRFC_I_SERVER_REGISTRATION', LOCK_ARG: 'SERVER_I', GMODE: 'O', GUNAME: 'ARIBA_ADDON' },
      ],
    };
    const { metrics } = parseToMetrics(JSON.stringify(payload), 'SM12', 'sap');
    const rows = infoRows(metrics);
    expect(rows.length).toBe(6);
    expect(rows.every((r) => r.value === 1)).toBe(true);

    // Every row has a unique natural-key label set — nothing collapsed.
    const identities = new Set(rows.map((r) => labelKey(r.labels)));
    expect(identities.size).toBe(6);

    // The critical pair from the requirement: TRDIR / ZEXPORT_MONITOR / AJAY
    // and TRDIR / ZPRG_TEMP2 / AJAY are both present as separate series.
    const byArg = (arg) => rows.find((r) => r.labels.table === 'TRDIR' && r.labels.lock_arg === arg);
    expect(byArg('ZEXPORT_MONITOR').labels.guname).toBe('AJAY');
    expect(byArg('ZPRG_TEMP2').labels.guname).toBe('AJAY');
    expect(labelKey(byArg('ZEXPORT_MONITOR').labels)).not.toBe(
      labelKey(byArg('ZPRG_TEMP2').labels),
    );

    // Aggregates over the six rows stay consistent.
    expect(find(metrics, 'sap_sm12_total_locks').value).toBe(6);
    expect(find(metrics, 'sap_sm12_exclusive_locks').value).toBe(4);
    expect(find(metrics, 'sap_sm12_shared_locks').value).toBe(1);
    expect(find(metrics, 'sap_sm12_other_locks').value).toBe(1);
    expect(find(metrics, 'sap_sm12_locked_tables').value).toBe(4);
    expect(find(metrics, 'sap_sm12_unique_users').value).toBe(2);
    expect(find(metrics, 'sap_sm12_lock_arg_distinct').value).toBe(6);
    expect(find(metrics, 'sap_sm12_gusevb_total').value).toBe(6);
    expect(find(metrics, 'sap_sm12_gtwp_total').value).toBe(24);
  });

  test('legacy GMOD / USER_ID-era payload still maps (mode "8" → other bucket)', () => {
    const payload = {
      monitor_type: 'SM12',
      data: [
        { TABLE: 'TRDIR', LOCK_ARG: 'ZEXPORT_MONITOR', USER_ID: 'AJAY', GMOD: '8', GCLIENT: 'X' },
      ],
    };
    const { metrics } = parseToMetrics(JSON.stringify(payload), 'SM12', 'sap');
    expect(find(metrics, 'sap_sm12_total_locks').value).toBe(1);
    expect(find(metrics, 'sap_sm12_exclusive_locks').value).toBe(0);
    expect(find(metrics, 'sap_sm12_shared_locks').value).toBe(0);
    expect(find(metrics, 'sap_sm12_other_locks').value).toBe(1);
    expect(find(metrics, 'sap_sm12_unique_users').value).toBe(1);

    const info = infoRows(metrics)[0];
    // GMOD feeds the gmode label; USER_ID feeds guname (owner fallback) AND
    // user_id — nothing is invented, each field is mapped through its key list.
    expect(info.labels.table).toBe('TRDIR');
    expect(info.labels.gmode).toBe('8');
    expect(info.labels.guname).toBe('AJAY');
    expect(info.labels.user_id).toBe('AJAY');
    expect(info.labels.gclient).toBe('X');
    expect(info.labels.lock_arg).toBe('ZEXPORT_MONITOR');
  });

  test('values longer than 128 chars are truncated to the label cap', () => {
    const longArg = 'A'.repeat(200);
    const payload = {
      monitor_type: 'SM12',
      data: [{ TABLE: 'TRDIR', LOCK_ARG: longArg, GMODE: 'E', GUNAME: 'AJAY' }],
    };
    const { metrics } = parseToMetrics(JSON.stringify(payload), 'SM12', 'sap');
    const info = infoRows(metrics)[0];
    expect(info.labels.lock_arg.length).toBe(128);
    expect(info.labels.lock_arg).toBe('A'.repeat(128));
  });

  test('empty data array produces no metrics (and no parse error)', () => {
    const { metrics, parseError } = parseToMetrics(
      JSON.stringify({ monitor_type: 'SM12', data: [] }),
      'SM12',
      'sap',
    );
    expect(parseError).toBeNull();
    expect(metrics.length).toBe(0);
  });
});
