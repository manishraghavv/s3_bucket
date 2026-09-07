'use strict';

/**
 * SM21 collector verification tests.
 *
 * Uses the REAL SM21 JSON file downloaded from S3
 * (test/fixtures/sm21.json — 271 records, monitor_type "SM21") as the
 * authoritative fixture. Covers:
 *   - monitor_type + total_messages (== data.length == 271)
 *   - message_info with ALL 15 source fields as labels, 1:1 mapping
 *   - raw value preservation: terminal " no TTY" leading space, ERRNO "  1"
 *     spaces, PROCESSID/SEVERITY leading zeroes, date/time raw strings
 *   - empty-string preservation (tcode=""/zuser=""/client=""/terminal=""/
 *     errno="" stay visible on message_info, absent in *_present)
 *   - *_present / *_distinct semantics for all 15 fields
 *   - no blank categorical count labels; no NEW text_count aggregation
 *   - latest ZDATE+ZTIME combined-pair logic
 *   - duplicate records counted at collector level
 *   - legacy SM21 metrics preserved (names + semantics)
 *   - PROGRAMMATIC 1:1 field coverage (Source fields vs Info labels)
 *   - REAL-FILE schema check: union of row keys, per-row missing/extra keys
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics, collectSM21 } = require('../src/json-parser');

const REAL = require('./fixtures/sm21.json');
const REAL_ROWS = REAL.data || [];

// Authoritative source fields and their expected snake_case labels (1:1).
const FIELD_MAP = {
  ZDATE: 'zdate',
  ZTIME: 'ztime',
  INSTANCE: 'instance',
  PROCESSID: 'process_id',
  TERMINAL: 'terminal',
  ZUSER: 'zuser',
  TCODE: 'tcode',
  WP_TYPE: 'wp_type',
  CLIENT: 'client',
  SEVERITY: 'severity',
  MESSAGEID: 'message_id',
  TEXT: 'text',
  DEVCLASS: 'devclass',
  ERRNO: 'errno',
  ERRORNAME: 'error_name',
};
const SOURCE_FIELDS = Object.keys(FIELD_MAP);
const INFO_LABELS = Object.values(FIELD_MAP);

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'SM21', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

// Independent raw-value helpers used to derive expectations from the fixture
// (mirror of the documented semantics: "" absent, no trim).
const nonEmptyRaw = (rows, f) => rows.filter((r) => String(r[f] ?? '') !== '').length;
const distinctRaw = (rows, f) => new Set(rows.map((r) => String(r[f] ?? '')).filter((v) => v !== '')).size;

describe('SM21 collector (real fixture)', () => {
  test('fixture sanity: monitor_type SM21, 271 records, 15 keys, no stray rows', () => {
    expect(REAL.monitor_type).toBe('SM21');
    expect(REAL_ROWS.length).toBe(271);
    const union = [...new Set(REAL_ROWS.flatMap((r) => Object.keys(r)))].sort();
    expect(union).toEqual([...SOURCE_FIELDS].sort());
    for (const row of REAL_ROWS) {
      const missing = SOURCE_FIELDS.filter((f) => !(f in row));
      const extra = Object.keys(row).filter((k) => !SOURCE_FIELDS.includes(k));
      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
    }
    // Explicit real-file schema output required by the spec.
    const missingRows = REAL_ROWS.filter((r) => SOURCE_FIELDS.some((f) => !(f in r))).length;
    const extraRows = REAL_ROWS.filter((r) => Object.keys(r).some((k) => !SOURCE_FIELDS.includes(k))).length;
    console.log('── SM21 real-file schema check ──');
    console.log(`Real records: ${REAL_ROWS.length}`);
    console.log(`Unique source keys: ${union.length}`);
    console.log(`Rows with missing expected keys: ${missingRows}`);
    console.log(`Rows with unexpected keys: ${extraRows}`);
  });

  test('monitor_type is emitted with the exact value', () => {
    const metrics = parse(REAL);
    const mt = find(metrics, 'sap_sm21_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('SM21');
    expect(mt.value).toBe(1);
  });

  test('total_messages equals data.length (271), duplicates counted', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_sm21_total_messages').value).toBe(271);
    expect(find(metrics, 'sap_sm21_total_messages').value).toBe(REAL_ROWS.length);
  });

  test('message_info carries exactly the 15 expected snake_case labels (1:1)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    expect(infos.length).toBe(271); // one series per record at collector level
    for (const info of infos) {
      expect(Object.keys(info.labels).sort()).toEqual([...INFO_LABELS].sort());
      expect(info.value).toBe(1);
    }
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra labels', () => {
    const metrics = parse(REAL);
    const sourceFields = Object.keys(REAL_ROWS[0]); // derived from the actual JSON
    const mapped = sourceFields.map((f) => FIELD_MAP[f]);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    const infoLabels = Object.keys(infos[0].labels);

    const missing = mapped.filter((l) => !infoLabels.includes(l));
    const extra = infoLabels.filter((l) => !mapped.includes(l));

    console.log('── SM21 field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${sourceFields.length}`);
    console.log(`Info labels: ${infoLabels.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra labels: ${JSON.stringify(extra)}`);
    console.log(`Field coverage: ${infoLabels.length}/${sourceFields.length}`);

    expect(sourceFields.length).toBe(15);
    expect(infoLabels.length).toBe(15);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('raw values preserved: terminal " no TTY" leading space, first record exact', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');

    // The spec example is the actual first row of the real file.
    const first = infos[0];
    expect(first.labels.zdate).toBe('20260904');
    expect(first.labels.ztime).toBe('104520');
    expect(first.labels.instance).toBe('SAPIDES_JCI_00');
    expect(first.labels.process_id).toBe('000');
    expect(first.labels.terminal).toBe(' no TTY'); // leading space kept, NOT trimmed
    expect(first.labels.zuser).toBe('jciadm');
    expect(first.labels.tcode).toBe('');
    expect(first.labels.wp_type).toBe('S-A');
    expect(first.labels.client).toBe('000');
    expect(first.labels.severity).toBe('04'); // raw, not "4"
    expect(first.labels.message_id).toBe('E10');
    expect(first.labels.text).toBe('Buffer SCSA Generated with Length 4096');
    expect(first.labels.devclass).toBe('SLOG');
    expect(first.labels.errno).toBe(''); // empty preserved
    expect(first.labels.error_name).toBe('E_UNKNOWN_NO');
  });

  test('PROCESSID leading zeroes preserved in labels (000 / 006 / 020)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    expect(infos.some((m) => m.labels.process_id === '000')).toBe(true);
    expect(infos.some((m) => m.labels.process_id === '006')).toBe(true);
    expect(infos.some((m) => m.labels.process_id === '020')).toBe(true);
    const row = REAL_ROWS.find((r) => r.PROCESSID === '020');
    const info = infos.find((m) => m.labels.process_id === '020');
    expect(info.labels.process_id).toBe(String(row.PROCESSID));
  });

  test('SEVERITY leading zeroes preserved: 01/02/04/08 raw in labels and counts', () => {
    const metrics = parse(REAL);
    const severityValues = metrics
      .filter((m) => m.fullName === 'sap_sm21_severity_count')
      .map((m) => m.labels.severity);
    expect(severityValues).toContain('01');
    expect(severityValues).toContain('02');
    expect(severityValues).toContain('04');
    expect(severityValues).toContain('08');
    expect(severityValues).not.toContain('1'); // never normalized to "1"

    // Exact real counts: 01=215, 02=21, 04=10, 08=25 (sums to 271).
    expect(find(metrics, 'sap_sm21_severity_count', (m) => m.labels.severity === '01').value).toBe(215);
    expect(find(metrics, 'sap_sm21_severity_count', (m) => m.labels.severity === '02').value).toBe(21);
    expect(find(metrics, 'sap_sm21_severity_count', (m) => m.labels.severity === '04').value).toBe(10);
    expect(find(metrics, 'sap_sm21_severity_count', (m) => m.labels.severity === '08').value).toBe(25);
  });

  test('ERRNO raw whitespace preserved: "  1" distinct from "1" and from ""', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    const spaced = infos.find((m) => m.labels.errno === '  1');
    expect(spaced).toBeDefined(); // "  1" survives raw on message_info
    // count metric keeps the raw spaced label (never trimmed, never blank)
    expect(find(metrics, 'sap_sm21_errno_count', (m) => m.labels.errno === '  1').value).toBe(1);
    expect(find(metrics, 'sap_sm21_errno_count', (m) => m.labels.errno === '113').value).toBe(182);
    expect(find(metrics, 'sap_sm21_errno_count', (m) => m.labels.errno === '115').value).toBe(30);
    expect(metrics.filter((m) => m.fullName === 'sap_sm21_errno_count' && m.labels.errno === '').length).toBe(0);
  });

  test('empty strings preserved on message_info (tcode/zuser/client/terminal/errno)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    expect(infos.filter((m) => m.labels.tcode === '').length).toBe(269);
    expect(infos.filter((m) => m.labels.zuser === '').length).toBe(245);
    expect(infos.filter((m) => m.labels.client === '').length).toBe(245);
    expect(infos.filter((m) => m.labels.terminal === '').length).toBe(270);
    expect(infos.filter((m) => m.labels.errno === '').length).toBe(58);
    expect(infos.filter((m) => m.labels.tcode === '').length + infos.filter((m) => m.labels.tcode !== '').length).toBe(271);
  });

  test('_present semantics: "" absent, non-empty present, no trim', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_sm21_zdate_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_ztime_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_instance_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_process_id_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_terminal_present').value).toBe(1); // only " no TTY"
    expect(find(metrics, 'sap_sm21_zuser_present').value).toBe(26);
    expect(find(metrics, 'sap_sm21_tcode_present').value).toBe(2);
    expect(find(metrics, 'sap_sm21_wp_type_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_client_present').value).toBe(26);
    expect(find(metrics, 'sap_sm21_severity_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_message_id_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_text_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_devclass_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_errno_present').value).toBe(213);
    expect(find(metrics, 'sap_sm21_error_name_present').value).toBe(271);

    // Programmatic cross-check against the fixture for all 15 fields.
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      expect(find(metrics, `sap_sm21_${label}_present`).value).toBe(nonEmptyRaw(REAL_ROWS, src));
    }
  });

  test('_distinct semantics: distinct non-empty raw values only', () => {
    const metrics = parse(REAL);
    // Programmatic cross-check against the fixture for all 15 fields.
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      expect(find(metrics, `sap_sm21_${label}_distinct`).value).toBe(distinctRaw(REAL_ROWS, src));
    }
    // Spot values from the real file.
    expect(find(metrics, 'sap_sm21_instance_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm21_zdate_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm21_severity_distinct').value).toBe(4);
    expect(find(metrics, 'sap_sm21_message_id_distinct').value).toBe(15);
    expect(find(metrics, 'sap_sm21_text_distinct').value).toBe(58);
    expect(find(metrics, 'sap_sm21_error_name_distinct').value).toBe(4);
    expect(find(metrics, 'sap_sm21_terminal_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm21_tcode_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm21_client_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm21_errno_distinct').value).toBe(3); // 113, 115, "  1"
    expect(find(metrics, 'sap_sm21_zuser_distinct').value).toBe(3); // SAPSYS, DDIC, jciadm
  });

  test('no blank categorical count labels; count families sum to records', () => {
    const metrics = parse(REAL);
    const countMetrics = metrics.filter((m) => /_count$/.test(m.fullName));
    for (const m of countMetrics) {
      const values = Object.values(m.labels);
      // no label on any count series may be the empty string
      expect(values.every((v) => v !== '')).toBe(true);
    }
    // Categorical count families exist for every count-enabled field
    // (zdate/ztime are numeric-latest gauges, zuser uses legacy user_count,
    // text is covered by the TEXT rule — none of those have *_count series).
    for (const label of ['instance', 'process_id', 'terminal', 'tcode', 'wp_type', 'client', 'severity', 'message_id', 'devclass', 'errno', 'error_name']) {
      const name = `sap_sm21_${label}_count`;
      const series = metrics.filter((m) => m.fullName === name);
      expect(series.length).toBeGreaterThan(0);
      // count series sum == number of records where the field is PRESENT
      // (empty values never get a blank count label, so they are not counted)
      const present = find(metrics, `sap_sm21_${label}_present`);
      expect(series.reduce((s, m) => s + m.value, 0)).toBe(present.value);
    }
    // legacy user_count{user} (ZUSER) also sums to the zuser present count
    const userSeries = metrics.filter((m) => m.fullName === 'sap_sm21_user_count');
    expect(userSeries.reduce((s, m) => s + m.value, 0)).toBe(find(metrics, 'sap_sm21_zuser_present').value);
  });

  test('TEXT represented via info + presence/distinct, NOT via a new text_count', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    expect(infos.every((m) => 'text' in m.labels)).toBe(true); // info carries text
    expect(find(metrics, 'sap_sm21_text_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_text_distinct').value).toBe(58);
    // No per-text aggregation metric may exist under the *_count convention.
    expect(metrics.some((m) => m.fullName === 'sap_sm21_text_count')).toBe(false);
    // The LEGACY message_text_count is preserved (backward compatibility).
    expect(metrics.some((m) => m.fullName === 'sap_sm21_message_text_count')).toBe(true);
  });

  test('latest ZDATE+ZTIME pair comes from the same record (combined score)', () => {
    const metrics = parse(REAL);
    // Real file latest pair: ZDATE 20260904 + ZTIME 121121 (combined max).
    expect(find(metrics, 'sap_sm21_latest_date').value).toBe(20260904);
    expect(find(metrics, 'sap_sm21_latest_time').value).toBe(121121);

    // Independent verification from the fixture: max of ZDATE*1e6+ZTIME.
    let best = null;
    for (const r of REAL_ROWS) {
      const score = Number(r.ZDATE) * 1000000 + Number(r.ZTIME);
      if (best === null || score > best.score) best = { zdate: r.ZDATE, ztime: r.ZTIME, score };
    }
    expect(Number(best.zdate)).toBe(20260904);
    expect(Number(best.ztime)).toBe(121121);

    // Synthetic check: later date with tiny time must beat earlier date with big time.
    const synthetic = {
      monitor_type: 'SM21',
      data: [
        { ZDATE: '20260903', ZTIME: '235959', INSTANCE: 'X', PROCESSID: '000', TERMINAL: '', ZUSER: '', TCODE: '', WP_TYPE: 'IC', CLIENT: '', SEVERITY: '01', MESSAGEID: 'Q0I', TEXT: 'a', DEVCLASS: 'SLOG', ERRNO: '', ERRORNAME: 'E_UNKNOWN_NO' },
        { ZDATE: '20260904', ZTIME: '000001', INSTANCE: 'X', PROCESSID: '000', TERMINAL: '', ZUSER: '', TCODE: '', WP_TYPE: 'IC', CLIENT: '', SEVERITY: '01', MESSAGEID: 'Q0I', TEXT: 'b', DEVCLASS: 'SLOG', ERRNO: '', ERRORNAME: 'E_UNKNOWN_NO' },
      ],
    };
    const sm = parse(synthetic);
    expect(find(sm, 'sap_sm21_latest_date').value).toBe(20260904);
    expect(find(sm, 'sap_sm21_latest_time').value).toBe(1); // 000001 → numeric 1
    // raw strings stay intact on message_info even when the numeric gauge loses the zero
    const info = sm.filter((m) => m.fullName === 'sap_sm21_message_info').find((m) => m.labels.ztime === '000001');
    expect(info.labels.ztime).toBe('000001');
    expect(info.labels.zdate).toBe('20260904');
  });

  test('duplicate records: total_messages and counts never collapse', () => {
    const dup = { ...REAL_ROWS[0] };
    const payload = { monitor_type: 'SM21', data: [dup, { ...dup }, { ...dup }] };
    const metrics = parse(payload);
    expect(find(metrics, 'sap_sm21_total_messages').value).toBe(3);
    expect(metrics.filter((m) => m.fullName === 'sap_sm21_message_info').length).toBe(3);
    expect(find(metrics, 'sap_sm21_severity_count', (m) => m.labels.severity === '04').value).toBe(3);
    expect(find(metrics, 'sap_sm21_instance_count', (m) => m.labels.instance === 'SAPIDES_JCI_00').value).toBe(3);
  });

  test('collector record count equals source record count at parse level', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    expect(infos.length).toBe(REAL_ROWS.length); // 271 logical info records
    expect(find(metrics, 'sap_sm21_total_messages').value).toBe(infos.length);
  });

  test('legacy SM21 metrics are preserved (names + semantics)', () => {
    const metrics = parse(REAL);
    const present = (name) => expect(metrics.some((m) => m.fullName === name)).toBe(true);
    present('sap_sm21_total_messages');
    present('sap_sm21_critical_messages');
    present('sap_sm21_error_messages');
    present('sap_sm21_warning_messages');
    present('sap_sm21_system_messages');
    present('sap_sm21_unique_instances');
    present('sap_sm21_unique_error_types');
    present('sap_sm21_instance_count');
    present('sap_sm21_work_process_count');
    present('sap_sm21_error_number_count');
    present('sap_sm21_error_name_count');
    present('sap_sm21_component_count');
    present('sap_sm21_message_text_count');
    present('sap_sm21_user_count');
    // legacy message_count{severity} sums to 271 (one per record)
    const msgCounts = metrics.filter((m) => m.fullName === 'sap_sm21_message_count');
    expect(msgCounts.reduce((s, m) => s + m.value, 0)).toBe(271);
    // legacy user_count{user} spot values from real data (ZUSER: SAPSYS 22, DDIC 3)
    expect(find(metrics, 'sap_sm21_user_count', (m) => m.labels.user === 'SAPSYS').value).toBe(22);
    expect(find(metrics, 'sap_sm21_user_count', (m) => m.labels.user === 'DDIC').value).toBe(3);
    // critical messages: severities 04 + 08 in the real file
    expect(find(metrics, 'sap_sm21_critical_messages').value).toBe(10 + 25);
  });

  test('ERRNO and ERRORNAME remain separate, independent fields', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm21_message_info');
    // errno="113" pairs with error_name="EHOSTUNREACH"; errno="" with E_UNKNOWN_NO
    expect(infos.some((m) => m.labels.errno === '113' && m.labels.error_name === 'EHOSTUNREACH')).toBe(true);
    expect(infos.some((m) => m.labels.errno === '' && m.labels.error_name === 'E_UNKNOWN_NO')).toBe(true);
    expect(find(metrics, 'sap_sm21_errno_present').value).toBe(213);
    expect(find(metrics, 'sap_sm21_error_name_present').value).toBe(271);
    expect(find(metrics, 'sap_sm21_error_name_count', (m) => m.labels.error_name === 'EHOSTUNREACH').value).toBe(182);
    expect(find(metrics, 'sap_sm21_error_name_count', (m) => m.labels.error_name === 'E_UNKNOWN_NO').value).toBe(58);
  });

  test('parseToMetrics dispatch and exported collector', () => {
    expect(typeof collectSM21).toBe('function');
    const metrics = parse(REAL);
    expect(metrics.length).toBeGreaterThan(0);
    // every emitted info series conforms to the 15-label schema
    for (const info of metrics.filter((m) => m.fullName === 'sap_sm21_message_info')) {
      expect(Object.keys(info.labels).length).toBe(15);
    }
  });
});