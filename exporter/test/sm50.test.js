'use strict';

/**
 * SM50 collector verification tests — ZERO FIELD LOSS.
 *
 * Uses the REAL SM50 JSON file downloaded from S3
 * (test/fixtures/sm50.json — 21 records, monitor_type "SM50") as the
 * authoritative fixture. The real schema has exactly 23 fields per record:
 *   WP_NO, WP_TYP, WP_PID, WP_ISTATUS, WP_STATUS, WP_WAITING,
 *   WP_INTRESTART, WP_RESTART, WP_DUMPS, WP_CPU, WP_ELTIME, WP_MANDT,
 *   WP_BNAME, WP_REPORT, WP_INTACTION, WP_ACTION, WP_TABLE, WP_SERVER,
 *   WP_WAITINFO, WP_WAITTIME, WP_INDEX, HOLD, FAILURE
 *
 * Covers:
 *   - full-object dispatch via parseToMetrics + exported collectSM50
 *   - monitor_type_count + total_work_processes (== data.length == 21)
 *   - work_process_info: one collector-level series per record with the
 *     exact 23 snake_case labels (1:1, no loss, no extras)
 *   - raw-value preservation: FAILURE "0 " trailing space, empty strings,
 *     numeric 0 (WP_INTACTION=0), numeric 2/4 (WP_ISTATUS), WP_CPU "0:04"
 *   - PROGRAMMATIC 1:1 field coverage (source JSON keys vs info labels)
 *   - REAL-FILE schema check: every row has the same 23 keys, none missing,
 *     none unexpected
 *   - *_present / *_distinct semantics for all 23 fields
 *   - per-value *_count for all 23 fields (no blank-label series)
 *   - numeric aggregates (total/max/min) for the fields that are REAL JSON
 *     numbers (wp_istatus, wp_intrestart, wp_intaction, wp_index) only
 *   - duplicate handling: no deduplication at collector level (identical
 *     full label sets may collapse only at Prometheus exposition level)
 *   - ALL legacy SM50 metrics preserved (names + semantics)
 *   - empty data handling
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics, collectSM50 } = require('../src/json-parser');

const REAL = require('./fixtures/sm50.json');
const REAL_ROWS = REAL.data || [];

// Authoritative source fields and their expected snake_case labels (1:1),
// in source order — derived from the actual JSON payload.
const FIELD_MAP = {
  WP_NO: 'wp_no',
  WP_TYP: 'wp_typ',
  WP_PID: 'wp_pid',
  WP_ISTATUS: 'wp_istatus',
  WP_STATUS: 'wp_status',
  WP_WAITING: 'wp_waiting',
  WP_INTRESTART: 'wp_intrestart',
  WP_RESTART: 'wp_restart',
  WP_DUMPS: 'wp_dumps',
  WP_CPU: 'wp_cpu',
  WP_ELTIME: 'wp_eltime',
  WP_MANDT: 'wp_mandt',
  WP_BNAME: 'wp_bname',
  WP_REPORT: 'wp_report',
  WP_INTACTION: 'wp_intaction',
  WP_ACTION: 'wp_action',
  WP_TABLE: 'wp_table',
  WP_SERVER: 'wp_server',
  WP_WAITINFO: 'wp_waitinfo',
  WP_WAITTIME: 'wp_waittime',
  WP_INDEX: 'wp_index',
  HOLD: 'hold',
  FAILURE: 'failure',
};
const SOURCE_FIELDS = Object.keys(FIELD_MAP);   // 23 uppercase source keys
const INFO_LABELS = Object.values(FIELD_MAP);   // 23 snake_case labels

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'SM50', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

// Independent raw-value helpers mirroring the documented semantics.
// present: raw value stringifies to a non-empty string ("" absent,
// numeric 0 → "0" present, null/missing → "" absent). distinct: count of
// distinct non-empty raw stringified values. No trimming anywhere.
const rawOf = (r, f) => (r[f] === undefined || r[f] === null ? '' : String(r[f]));
const presentRaw = (rows, f) => rows.filter((r) => rawOf(r, f) !== '').length;
const distinctRaw = (rows, f) => new Set(rows.map((r) => rawOf(r, f)).filter((v) => v !== '')).size;
const freqRaw = (rows, f) => {
  const m = new Map();
  for (const r of rows) {
    const v = rawOf(r, f);
    if (v === '') continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return m;
};

describe('SM50 collector (real fixture)', () => {
  test('fixture sanity: monitor_type SM50, 21 records, every row has the same 23 keys', () => {
    expect(REAL.monitor_type).toBe('SM50');
    expect(REAL_ROWS.length).toBe(21);

    const union = [...new Set(REAL_ROWS.flatMap((r) => Object.keys(r)))].sort();
    expect(union).toEqual([...SOURCE_FIELDS].sort());
    expect(union.length).toBe(23);

    // Every row must carry exactly the same expected key set — no missing,
    // no unexpected keys, in any row.
    const expected = [...SOURCE_FIELDS].sort();
    const rowsMissing = REAL_ROWS.filter((r) => expected.some((k) => !(k in r)));
    const rowsExtra = REAL_ROWS.filter((r) => Object.keys(r).some((k) => !expected.includes(k)));

    console.log('── SM50 real-file schema check ──');
    console.log(`Real records: ${REAL_ROWS.length}`);
    console.log(`Unique source keys: ${union.length}`);
    console.log(`Rows with missing expected keys: ${rowsMissing.length}`);
    console.log(`Rows with unexpected keys: ${rowsExtra.length}`);
    expect(rowsMissing.length).toBe(0);
    expect(rowsExtra.length).toBe(0);

    // Every row has exactly 23 keys.
    for (const r of REAL_ROWS) {
      expect(Object.keys(r).length).toBe(23);
    }
  });

  test('full-object dispatch: parseToMetrics handles SM50 and collectSM50 is exported', () => {
    expect(typeof collectSM50).toBe('function');
    const { metrics, parseError } = parseToMetrics(JSON.stringify(REAL), 'SM50', 'sap');
    expect(parseError).toBeNull();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_work_process_info')).toBe(true);
  });

  test('monitor_type is emitted with the exact value', () => {
    const metrics = parse(REAL);
    const mt = find(metrics, 'sap_sm50_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('SM50');
    expect(mt.value).toBe(1);
  });

  test('total_work_processes equals data.length (21); legacy total_wp identical', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_sm50_total_work_processes').value).toBe(21);
    expect(find(metrics, 'sap_sm50_total_work_processes').value).toBe(REAL_ROWS.length);
    expect(find(metrics, 'sap_sm50_total_wp').value).toBe(21);
  });

  test('work_process_info: one collector-level series per record, value 1, 23 labels each', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info');
    expect(infos.length).toBe(21); // every source record → one info metric
    for (const info of infos) {
      expect(info.value).toBe(1);
      expect(Object.keys(info.labels).length).toBe(23);
      expect(Object.keys(info.labels).sort()).toEqual([...INFO_LABELS].sort());
    }
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra labels', () => {
    const metrics = parse(REAL);
    // Source keys derived programmatically from the actual fixture rows.
    const sourceFields = Object.keys(REAL_ROWS[0]); // authoritative 23 keys
    const mapped = sourceFields.map((f) => FIELD_MAP[f]);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info');
    const infoLabels = Object.keys(infos[0].labels);

    const missing = mapped.filter((l) => !infoLabels.includes(l));
    const extra = infoLabels.filter((l) => !mapped.includes(l));

    console.log('── SM50 field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${sourceFields.length}`);
    console.log(`Info labels: ${infoLabels.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra labels: ${JSON.stringify(extra)}`);
    console.log(`Field coverage: ${infoLabels.length}/${sourceFields.length}`);

    expect(sourceFields.length).toBe(23);
    expect(infoLabels.length).toBe(23);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('first real record is represented exactly (raw 1:1 values)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info');
    // Real rows keep source order → first info series = first data record.
    const first = infos[0];

    const expected = {
      wp_no: '0',
      wp_typ: 'DIA',
      wp_pid: '9531',
      wp_istatus: '4',          // JSON number 4 → "4"
      wp_status: 'Running',
      wp_waiting: '',           // empty string preserved
      wp_intrestart: '1',       // JSON number 1 → "1"
      wp_restart: 'Yes',
      wp_dumps: '',
      wp_cpu: '0:04',           // raw duration string, untouched
      wp_eltime: '',
      wp_mandt: '811',
      wp_bname: 'AJAY',
      wp_report: 'SAPLTHFB',
      wp_intaction: '0',        // JSON number 0 → "0" (zero preserved)
      wp_action: '',
      wp_table: '',
      wp_server: '',
      wp_waitinfo: '',
      wp_waittime: '',
      wp_index: '0',            // JSON number 0 → "0"
      hold: '',
      failure: '0 ',            // trailing space NOT trimmed
    };
    expect(Object.keys(first.labels).length).toBe(23);
    for (const [label, value] of Object.entries(expected)) {
      expect(first.labels[label]).toBe(value);
    }
  });

  test('raw values never trimmed; empty strings observable on info labels (whole fixture)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info');

    // FAILURE="0 " keeps its trailing space on EVERY info series.
    expect(infos.every((m) => m.labels.failure === '0 ')).toBe(true);
    // WP_STATUS raw values preserved.
    expect(infos.filter((m) => m.labels.wp_status === 'Running').length).toBe(1);
    expect(infos.filter((m) => m.labels.wp_status === 'Waiting').length).toBe(20);
    // WP_CPU raw duration strings untouched.
    expect(infos.some((m) => m.labels.wp_cpu === '0:04')).toBe(true);
    expect(infos.some((m) => m.labels.wp_cpu === '0:08')).toBe(true);

    // Empty-string fields stay "": wp_waiting "" on all 21, wp_mandt "" on 20.
    expect(infos.filter((m) => m.labels.wp_waiting === '').length).toBe(21);
    expect(infos.filter((m) => m.labels.wp_mandt === '').length).toBe(20);
    expect(infos.filter((m) => m.labels.wp_mandt === '811').length).toBe(1);
    expect(infos.filter((m) => m.labels.hold === '').length).toBe(21);
    // Every info series still carries all 23 labels even when values are empty.
    expect(infos.every((m) => Object.keys(m.labels).length === 23)).toBe(true);
  });

  test('numeric zero preservation: WP_INTACTION=0 is present, kept raw, aggregate 0 emitted', () => {
    const metrics = parse(REAL);
    // Info labels: JSON number 0 stringifies to "0" (never treated as missing).
    const infos = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info');
    expect(infos.every((m) => m.labels.wp_intaction === '0')).toBe(true);
    // Presence: numeric 0 is PRESENT.
    expect(find(metrics, 'sap_sm50_wp_intaction_present').value).toBe(21);
    expect(find(metrics, 'sap_sm50_wp_intaction_distinct').value).toBe(1);
    // Per-value count of "0" counts all 21 occurrences.
    expect(find(metrics, 'sap_sm50_wp_intaction_count', (m) => m.labels.wp_intaction === '0').value).toBe(21);
    // All-zero numeric field still emits total/max/min = 0 (zero not dropped).
    expect(find(metrics, 'sap_sm50_wp_intaction_total').value).toBe(0);
    expect(find(metrics, 'sap_sm50_wp_intaction_max').value).toBe(0);
    expect(find(metrics, 'sap_sm50_wp_intaction_min').value).toBe(0);
  });

  test('raw values are never trimmed (synthetic whitespace preservation)', () => {
    const payload = {
      monitor_type: 'SM50',
      data: [{
        WP_NO: ' 0 ', WP_TYP: 'DIA', WP_PID: ' 9531 ', WP_ISTATUS: 4,
        WP_STATUS: 'Running ', WP_WAITING: ' ', WP_INTRESTART: 1,
        WP_RESTART: ' Yes ', WP_DUMPS: '', WP_CPU: ' 0:04 ', WP_ELTIME: '',
        WP_MANDT: ' 811 ', WP_BNAME: 'AJAY', WP_REPORT: 'SAPLTHFB',
        WP_INTACTION: 0, WP_ACTION: ' ', WP_TABLE: '', WP_SERVER: '',
        WP_WAITINFO: '', WP_WAITTIME: '', WP_INDEX: 0, HOLD: '', FAILURE: '0 ',
      }],
    };
    const metrics = parse(payload);
    const info = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info')[0];
    expect(info.labels.wp_no).toBe(' 0 ');
    expect(info.labels.wp_pid).toBe(' 9531 ');
    expect(info.labels.wp_status).toBe('Running ');
    expect(info.labels.wp_restart).toBe(' Yes ');
    expect(info.labels.wp_cpu).toBe(' 0:04 ');
    expect(info.labels.wp_mandt).toBe(' 811 ');
    expect(info.labels.failure).toBe('0 ');
    // Padding is not trimmed before presence testing either → PRESENT.
    expect(find(metrics, 'sap_sm50_wp_pid_present').value).toBe(1);
    expect(find(metrics, 'sap_sm50_wp_mandt_present').value).toBe(1);
  });

  test('_present semantics for ALL 23 fields cross-checked against the fixture', () => {
    const metrics = parse(REAL);
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      expect(find(metrics, `sap_sm50_${label}_present`).value).toBe(presentRaw(REAL_ROWS, src));
    }
    // Spot-check the values the real fixture produces.
    expect(find(metrics, 'sap_sm50_wp_no_present').value).toBe(21);
    expect(find(metrics, 'sap_sm50_wp_status_present').value).toBe(21);
    expect(find(metrics, 'sap_sm50_wp_cpu_present').value).toBe(21);
    expect(find(metrics, 'sap_sm50_wp_waiting_present').value).toBe(0); // all ""
    expect(find(metrics, 'sap_sm50_wp_eltime_present').value).toBe(0);
    expect(find(metrics, 'sap_sm50_hold_present').value).toBe(0);
    expect(find(metrics, 'sap_sm50_wp_mandt_present').value).toBe(1); // only "811"
    expect(find(metrics, 'sap_sm50_wp_bname_present').value).toBe(1); // only AJAY
    expect(find(metrics, 'sap_sm50_failure_present').value).toBe(21); // "0 " is non-empty
  });

  test('_distinct semantics for ALL 23 fields cross-checked against the fixture', () => {
    const metrics = parse(REAL);
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      expect(find(metrics, `sap_sm50_${label}_distinct`).value).toBe(distinctRaw(REAL_ROWS, src));
    }
    expect(find(metrics, 'sap_sm50_wp_no_distinct').value).toBe(21); // "0".."20"
    expect(find(metrics, 'sap_sm50_wp_typ_distinct').value).toBe(5);  // DIA/UPD/BGD/SPO/UP2
    expect(find(metrics, 'sap_sm50_wp_istatus_distinct').value).toBe(2); // 2, 4
    expect(find(metrics, 'sap_sm50_wp_cpu_distinct').value).toBe(8);  // 0:01..0:08 durations
    expect(find(metrics, 'sap_sm50_failure_distinct').value).toBe(1); // "0 " only
    expect(find(metrics, 'sap_sm50_wp_waiting_distinct').value).toBe(0);
  });

  test('per-value *_count for ALL 23 fields: counts every occurrence, no blank labels', () => {
    const metrics = parse(REAL);
    // Cross-check every field's count map against the raw fixture values.
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      const expected = freqRaw(REAL_ROWS, src);
      const series = metrics.filter((m) => m.fullName === `sap_sm50_${label}_count`);
      expect(series.length).toBe(expected.size); // one series per distinct value
      for (const [val, cnt] of expected) {
        const m = series.find((s) => s.labels[label] === val);
        expect(m).toBeDefined();
        expect(m.value).toBe(cnt);
      }
    }

    // Spot values from the real fixture.
    const count = (name, label, value) => find(metrics, `sap_sm50_${name}`, (m) => m.labels[label] === value).value;
    expect(count('wp_status_count', 'wp_status', 'Running')).toBe(1);
    expect(count('wp_status_count', 'wp_status', 'Waiting')).toBe(20);
    expect(count('wp_typ_count', 'wp_typ', 'DIA')).toBe(10);
    expect(count('wp_typ_count', 'wp_typ', 'BGD')).toBe(6);
    expect(count('wp_typ_count', 'wp_typ', 'SPO')).toBe(3);
    expect(count('wp_typ_count', 'wp_typ', 'UP2')).toBe(1);
    expect(count('wp_mandt_count', 'wp_mandt', '811')).toBe(1);
    expect(count('wp_bname_count', 'wp_bname', 'AJAY')).toBe(1);
    expect(count('wp_report_count', 'wp_report', 'SAPLTHFB')).toBe(1);
    // FAILURE count label keeps the raw "0 " value (no trim) and counts 21 rows.
    expect(count('failure_count', 'failure', '0 ')).toBe(21);

    // No count series may carry a blank label value.
    for (const m of metrics.filter((mm) => /_count$/.test(mm.fullName))) {
      expect(Object.values(m.labels).every((v) => v !== '')).toBe(true);
    }

    // Sum of each field's count series == its _present count (nothing lost).
    for (const [, label] of Object.entries(FIELD_MAP)) {
      const sum = metrics
        .filter((m) => m.fullName === `sap_sm50_${label}_count`)
        .reduce((s, m) => s + m.value, 0);
      expect(sum).toBe(find(metrics, `sap_sm50_${label}_present`).value);
    }
  });

  test('numeric aggregates exist ONLY for real JSON-number fields, with correct totals', () => {
    const metrics = parse(REAL);

    // Genuinely numeric fields in this payload: wp_istatus, wp_intrestart,
    // wp_intaction, wp_index. Aggregates preserve exact 0/positive values.
    expect(find(metrics, 'sap_sm50_wp_istatus_total').value).toBe(44);  // 4 + 20×2
    expect(find(metrics, 'sap_sm50_wp_istatus_max').value).toBe(4);
    expect(find(metrics, 'sap_sm50_wp_istatus_min').value).toBe(2);
    expect(find(metrics, 'sap_sm50_wp_intrestart_total').value).toBe(21);
    expect(find(metrics, 'sap_sm50_wp_intrestart_max').value).toBe(1);
    expect(find(metrics, 'sap_sm50_wp_intrestart_min').value).toBe(1);
    expect(find(metrics, 'sap_sm50_wp_index_total').value).toBe(210);  // 0+…+20
    expect(find(metrics, 'sap_sm50_wp_index_max').value).toBe(20);
    expect(find(metrics, 'sap_sm50_wp_index_min').value).toBe(0);

    // String fields that merely LOOK numeric must NOT get numeric aggregates:
    // wp_no ("0"), wp_pid ("9531"), wp_cpu ("0:04") are strings in the JSON.
    expect(metrics.some((m) => m.fullName === 'sap_sm50_wp_no_total')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_wp_pid_total')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_wp_cpu_total')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_wp_mandt_total')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_failure_total')).toBe(false);
  });

  test('duplicate handling: identical rows are never deduplicated at collector level', () => {
    const dup = { ...REAL_ROWS[0] };
    const payload = { monitor_type: 'SM50', data: [dup, { ...dup }, { ...dup }] };
    const metrics = parse(payload);
    // total_work_processes counts every source row.
    expect(find(metrics, 'sap_sm50_total_work_processes').value).toBe(3);
    // One collector-level info metric per row (3 identical series here).
    expect(metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info').length).toBe(3);
    // count metrics count every occurrence of the value.
    expect(find(metrics, 'sap_sm50_wp_no_count', (m) => m.labels.wp_no === '0').value).toBe(3);
    expect(find(metrics, 'sap_sm50_failure_count', (m) => m.labels.failure === '0 ').value).toBe(3);
    expect(find(metrics, 'sap_sm50_wp_intaction_count', (m) => m.labels.wp_intaction === '0').value).toBe(3);
    // present counts scale with duplicates too.
    expect(find(metrics, 'sap_sm50_wp_mandt_present').value).toBe(3);
    expect(find(metrics, 'sap_sm50_wp_mandt_distinct').value).toBe(1); // still one value
    // NOTE: identical full label sets may collapse only at Prometheus
    // exposition level — never in the collector output.
  });

  test('legacy SM50 metrics are preserved (names + semantics)', () => {
    const metrics = parse(REAL);
    const present = (name) => expect(metrics.some((m) => m.fullName === name)).toBe(true);
    present('sap_sm50_total_wp');
    present('sap_sm50_running_wp');
    present('sap_sm50_waiting_wp');
    present('sap_sm50_finished_wp');
    present('sap_sm50_stopped_wp');
    present('sap_sm50_dialog_wp');
    present('sap_sm50_background_wp');
    present('sap_sm50_update_wp');
    present('sap_sm50_spool_wp');
    present('sap_sm50_enqueue_wp');
    present('sap_sm50_status_count');
    present('sap_sm50_type_count');
    present('sap_sm50_user_count');
    present('sap_sm50_cpu_seconds');

    // Semantics against the real 21-record fixture.
    expect(find(metrics, 'sap_sm50_running_wp').value).toBe(1);   // WP_NO 0 only
    expect(find(metrics, 'sap_sm50_waiting_wp').value).toBe(20);
    expect(find(metrics, 'sap_sm50_finished_wp').value).toBe(0);
    expect(find(metrics, 'sap_sm50_stopped_wp').value).toBe(0);
    expect(find(metrics, 'sap_sm50_dialog_wp').value).toBe(10);   // DIA ×10
    expect(find(metrics, 'sap_sm50_background_wp').value).toBe(0); // legacy checks BTC only
    expect(find(metrics, 'sap_sm50_update_wp').value).toBe(1);    // UPD ×1
    expect(find(metrics, 'sap_sm50_spool_wp').value).toBe(3);     // SPO ×3
    expect(find(metrics, 'sap_sm50_enqueue_wp').value).toBe(0);   // ENQ absent

    // status/type per-value counts (same labels as legacy).
    expect(find(metrics, 'sap_sm50_status_count', (m) => m.labels.status === 'Running').value).toBe(1);
    expect(find(metrics, 'sap_sm50_status_count', (m) => m.labels.status === 'Waiting').value).toBe(20);
    expect(find(metrics, 'sap_sm50_type_count', (m) => m.labels.type === 'DIA').value).toBe(10);
    expect(find(metrics, 'sap_sm50_type_count', (m) => m.labels.type === 'UPD').value).toBe(1);
    expect(find(metrics, 'sap_sm50_user_count', (m) => m.labels.user === 'AJAY').value).toBe(1);

    // cpu_seconds{type} — legacy semantics: emitted only for DIA/BTC/UPD/
    // SPO/ENQ types present in the data. WP_CPU is a "0:04" duration string
    // so the legacy parseFloat sum is 0 — semantics unchanged.
    expect(find(metrics, 'sap_sm50_cpu_seconds', (m) => m.labels.type === 'DIA').value).toBe(0);
    expect(find(metrics, 'sap_sm50_cpu_seconds', (m) => m.labels.type === 'UPD').value).toBe(0);
    expect(find(metrics, 'sap_sm50_cpu_seconds', (m) => m.labels.type === 'SPO').value).toBe(0);
    expect(find(metrics, 'sap_sm50_cpu_seconds', (m) => m.labels.type === 'BTC')).toBeUndefined();
    expect(find(metrics, 'sap_sm50_cpu_seconds', (m) => m.labels.type === 'BGD')).toBeUndefined();

    // client_count reads WP_CLIENT (absent in real payload) → no series.
    expect(metrics.some((m) => m.fullName === 'sap_sm50_client_count')).toBe(false);
  });

  test('empty data array: no crash, monitor_type still emitted, no totals/info', () => {
    const metrics = parse({ monitor_type: 'SM50', data: [] });
    expect(metrics.some((m) => m.fullName === 'sap_sm50_monitor_type_count')).toBe(true);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_total_work_processes')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_work_process_info')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm50_total_wp')).toBe(false);
  });

  test('collector record count equals source record count at parse level', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm50_work_process_info');
    expect(infos.length).toBe(REAL_ROWS.length); // 21 logical info records
    expect(find(metrics, 'sap_sm50_total_work_processes').value).toBe(infos.length);
  });
});
