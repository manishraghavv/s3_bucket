'use strict';

/**
 * SM20 collector verification tests.
 *
 * Uses the REAL SM20 JSON file downloaded from S3
 * (test/fixtures/sm20.json — 2666 records, monitor_type "SM20") as the
 * authoritative fixture. The real schema has exactly 5 fields:
 *   SENDER_ID, USER, TERMINAL, TCODE, CLIENT
 * (no EVENT/SEVERITY/MESSAGE/PROGRAM — the legacy classifier fields are
 * simply absent in the real payload and stay zero/absent, preserved as-is).
 *
 * Covers:
 *   - monitor_type + total_events (== data.length == 2666)
 *   - event_info with ALL 5 source fields as labels, 1:1 mapping
 *   - raw value / empty-string / leading-zero ("000", "811") preservation
 *   - numeric-0-presence semantics (synthetic) and no-trim whitespace (synthetic)
 *   - *_present / *_distinct semantics for all 5 fields
 *   - per-value count metrics (legacy user/terminal/tcode + new sender/client)
 *   - duplicate records counted at collector level (heavy duplicates in real data)
 *   - legacy SM20 metrics preserved byte-for-byte
 *   - PROGRAMMATIC 1:1 field coverage (Source fields vs Info labels)
 *   - REAL-FILE schema check: union of row keys, per-row missing/extra keys
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics, collectSM20 } = require('../src/json-parser');

const REAL = require('./fixtures/sm20.json');
const REAL_ROWS = REAL.data || [];

// Authoritative source fields and their expected snake_case labels (1:1).
const FIELD_MAP = {
  SENDER_ID: 'sender_id',
  USER: 'user',
  TERMINAL: 'terminal',
  TCODE: 'tcode',
  CLIENT: 'client',
};
const SOURCE_FIELDS = Object.keys(FIELD_MAP);
const INFO_LABELS = Object.values(FIELD_MAP);

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'SM20', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

// Independent raw-value helpers mirroring the documented semantics.
const nonEmptyRaw = (rows, f) => rows.filter((r) => String(r[f] ?? '') !== '').length;
const distinctRaw = (rows, f) => new Set(rows.map((r) => String(r[f] ?? '')).filter((v) => v !== '')).size;

describe('SM20 collector (real fixture)', () => {
  test('fixture sanity: monitor_type SM20, 2666 records, 5 keys, no stray rows', () => {
    expect(REAL.monitor_type).toBe('SM20');
    expect(REAL_ROWS.length).toBe(2666);
    const union = [...new Set(REAL_ROWS.flatMap((r) => Object.keys(r)))].sort();
    expect(union).toEqual([...SOURCE_FIELDS].sort());
    const missingRows = REAL_ROWS.filter((r) => SOURCE_FIELDS.some((f) => !(f in r))).length;
    const extraRows = REAL_ROWS.filter((r) => Object.keys(r).some((k) => !SOURCE_FIELDS.includes(k))).length;
    console.log('── SM20 real-file schema check ──');
    console.log(`Real records: ${REAL_ROWS.length}`);
    console.log(`Unique source keys: ${union.length}`);
    console.log(`Rows with missing expected keys: ${missingRows}`);
    console.log(`Rows with unexpected keys: ${extraRows}`);
    expect(missingRows).toBe(0);
    expect(extraRows).toBe(0);
  });

  test('monitor_type is emitted with the exact value', () => {
    const metrics = parse(REAL);
    const mt = find(metrics, 'sap_sm20_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('SM20');
    expect(mt.value).toBe(1);
  });

  test('total_events equals data.length (2666), duplicates counted', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_sm20_total_events').value).toBe(2666);
    expect(find(metrics, 'sap_sm20_total_events').value).toBe(REAL_ROWS.length);
  });

  test('event_info carries the 5 expected snake_case labels + event_key', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm20_event_info');
    expect(infos.length).toBe(2666); // one series per record at collector level
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      expect(Object.keys(info.labels).sort()).toEqual([...INFO_LABELS, 'event_key'].sort());
      expect(info.value).toBe(1);
      expect(info.labels.event_key).toBe(
        [
          info.labels.sender_id,
          info.labels.client,
          info.labels.user,
          info.labels.tcode,
          info.labels.terminal,
          String(i),
        ].join('|').substring(0, 110),
      );
    }

    // All 2666 records must have distinct event_keys so prom-client never collapses them
    const uniqueKeys = new Set(infos.map((m) => m.labels.event_key));
    expect(uniqueKeys.size).toBe(2666);
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra source labels', () => {
    const metrics = parse(REAL);
    const sourceFields = Object.keys(REAL_ROWS[0]); // derived from the actual JSON
    const mapped = sourceFields.map((f) => FIELD_MAP[f]);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm20_event_info');
    const infoLabels = Object.keys(infos[0].labels);
    const sourceLabels = infoLabels.filter((l) => l !== 'event_key');

    const missing = mapped.filter((l) => !sourceLabels.includes(l));
    const extra = sourceLabels.filter((l) => !mapped.includes(l));

    console.log('── SM20 field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${sourceFields.length}`);
    console.log(`Info source labels: ${sourceLabels.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra labels: ${JSON.stringify(extra)}`);
    console.log(`Field coverage: ${sourceLabels.length}/${sourceFields.length}`);

    expect(sourceFields.length).toBe(5);
    expect(sourceLabels.length).toBe(5);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('raw values and empty strings preserved on event_info', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm20_event_info');

    // Every real record: sender_id = SAPIDES_JCI_00, client codes raw.
    expect(infos.every((m) => m.labels.sender_id === 'SAPIDES_JCI_00')).toBe(true);
    expect(infos.some((m) => m.labels.client === '000')).toBe(true);
    expect(infos.some((m) => m.labels.client === '811')).toBe(true);
    expect(infos.some((m) => m.labels.client === '800')).toBe(true);

    // Empty-string counts in the real file are observable on info labels.
    expect(infos.filter((m) => m.labels.user === '').length).toBe(7);
    expect(infos.filter((m) => m.labels.terminal === '').length).toBe(1019);
    expect(infos.filter((m) => m.labels.tcode === '').length).toBe(2061);
    expect(infos.filter((m) => m.labels.client === '').length).toBe(4);
    // Every info series carries all 5 source labels + event_key even when empty.
    expect(infos.every((m) => Object.keys(m.labels).length === 6)).toBe(true);
  });

  test('_present semantics: "" absent, non-empty present (real counts)', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_sm20_sender_id_present').value).toBe(2666);
    expect(find(metrics, 'sap_sm20_user_present').value).toBe(2659);
    expect(find(metrics, 'sap_sm20_terminal_present').value).toBe(1647);
    expect(find(metrics, 'sap_sm20_tcode_present').value).toBe(605);
    expect(find(metrics, 'sap_sm20_client_present').value).toBe(2662);
    // Programmatic cross-check for all 5 fields.
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      expect(find(metrics, `sap_sm20_${label}_present`).value).toBe(nonEmptyRaw(REAL_ROWS, src));
    }
  });

  test('_distinct semantics: distinct non-empty raw values only', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_sm20_sender_id_distinct').value).toBe(1);
    expect(find(metrics, 'sap_sm20_user_distinct').value).toBe(10);
    expect(find(metrics, 'sap_sm20_terminal_distinct').value).toBe(5);
    expect(find(metrics, 'sap_sm20_tcode_distinct').value).toBe(8);
    expect(find(metrics, 'sap_sm20_client_distinct').value).toBe(3);
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      expect(find(metrics, `sap_sm20_${label}_distinct`).value).toBe(distinctRaw(REAL_ROWS, src));
    }
  });

  test('per-value count metrics count occurrences in source records', () => {
    const metrics = parse(REAL);
    const count = (name, label, value) => find(metrics, `sap_sm20_${name}`, (m) => m.labels[label] === value).value;

    // legacy user/terminal/tcode counts (labels user/terminal/tcode)
    expect(count('user_count', 'user', 'AJAY')).toBe(997);
    expect(count('user_count', 'user', 'SAPSYS')).toBe(605);
    expect(count('user_count', 'user', 'DDIC')).toBe(375);
    expect(count('terminal_count', 'terminal', 'SAPIDES.')).toBe(1144);
    expect(count('terminal_count', 'terminal', 'wspl-ane')).toBe(363);
    expect(count('tcode_count', 'tcode', 'S000')).toBe(407);
    expect(count('tcode_count', 'tcode', 'SE38')).toBe(110);

    // new sender_id / client counts
    expect(count('sender_id_count', 'sender_id', 'SAPIDES_JCI_00')).toBe(2666);
    expect(count('client_count', 'client', '000')).toBe(1132);
    expect(count('client_count', 'client', '811')).toBe(1097);
    expect(count('client_count', 'client', '800')).toBe(433);

    // sums equal present counts (no blank labels, no lost records)
    const sum = (name, label) => metrics.filter((m) => m.fullName === name).reduce((s, m) => s + m.value, 0);
    expect(sum('sap_sm20_user_count', 'user')).toBe(2659);
    expect(sum('sap_sm20_terminal_count', 'terminal')).toBe(1647);
    expect(sum('sap_sm20_tcode_count', 'tcode')).toBe(605);
    expect(sum('sap_sm20_sender_id_count', 'sender_id')).toBe(2666);
    expect(sum('sap_sm20_client_count', 'client')).toBe(2662);
    // no count series may carry a blank label
    for (const m of metrics.filter((mm) => /_count$/.test(mm.fullName))) {
      expect(Object.values(m.labels).every((v) => v !== '')).toBe(true);
    }
  });

  test('numeric 0 counts as PRESENT and survives on the info metric', () => {
    const payload = {
      monitor_type: 'SM20',
      data: [
        { SENDER_ID: 'SAPIDES_JCI_00', USER: 0, TERMINAL: 0, TCODE: 0, CLIENT: 0 },
      ],
    };
    const metrics = parse(payload);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm20_event_info');
    expect(infos[0].labels.user).toBe('0');
    expect(infos[0].labels.terminal).toBe('0');
    expect(infos[0].labels.tcode).toBe('0');
    expect(infos[0].labels.client).toBe('0');
    // 0 is PRESENT, never treated as missing
    expect(find(metrics, 'sap_sm20_user_present').value).toBe(1);
    expect(find(metrics, 'sap_sm20_terminal_present').value).toBe(1);
    expect(find(metrics, 'sap_sm20_tcode_present').value).toBe(1);
    expect(find(metrics, 'sap_sm20_client_present').value).toBe(1);
    expect(find(metrics, 'sap_sm20_user_distinct').value).toBe(1);
  });

  test('raw values are never trimmed (synthetic whitespace preservation)', () => {
    const payload = {
      monitor_type: 'SM20',
      data: [
        { SENDER_ID: '  SAPIDES  ', USER: '  AJAY  ', TERMINAL: '  T1  ', TCODE: '  S000  ', CLIENT: '  000  ' },
      ],
    };
    const metrics = parse(payload);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm20_event_info');
    expect(infos[0].labels.sender_id).toBe('  SAPIDES  ');
    expect(infos[0].labels.user).toBe('  AJAY  ');
    expect(infos[0].labels.client).toBe('  000  ');
    // whitespace-only-padded values are non-empty → PRESENT (no trim before testing)
    expect(find(metrics, 'sap_sm20_user_present').value).toBe(1);
  });

  test('duplicate records: total_events and info metrics never collapse at collector level', () => {
    const dup = { ...REAL_ROWS[0] }; // fully-empty record (real file starts with 7+ of these)
    const payload = { monitor_type: 'SM20', data: [dup, { ...dup }, { ...dup }] };
    const metrics = parse(payload);
    expect(find(metrics, 'sap_sm20_total_events').value).toBe(3);
    expect(metrics.filter((m) => m.fullName === 'sap_sm20_event_info').length).toBe(3);
    // count metrics count all 3 occurrences of each label value
    expect(find(metrics, 'sap_sm20_user_count', (m) => m.labels.user === '')).toBeUndefined(); // no blank label
    expect(metrics.filter((m) => m.fullName === 'sap_sm20_event_info' && m.labels.user === '').length).toBe(3);
  });

  test('collector record count equals source record count at parse level', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_sm20_event_info');
    expect(infos.length).toBe(REAL_ROWS.length); // 2666 logical info records
    expect(find(metrics, 'sap_sm20_total_events').value).toBe(infos.length);
  });

  test('legacy SM20 metrics are preserved (names + semantics)', () => {
    const metrics = parse(REAL);
    const present = (name) => expect(metrics.some((m) => m.fullName === name)).toBe(true);
    present('sap_sm20_total_events');
    present('sap_sm20_critical_events');
    present('sap_sm20_severe_events');
    present('sap_sm20_other_events');
    present('sap_sm20_user_count');
    present('sap_sm20_terminal_count');
    present('sap_sm20_tcode_count');

    // Real payload has no EVENT/SEVERITY/MESSAGE/PROGRAM keys → the legacy
    // classifier metrics stay zero/absent exactly as before.
    expect(find(metrics, 'sap_sm20_critical_events').value).toBe(0);
    expect(find(metrics, 'sap_sm20_severe_events').value).toBe(0);
    expect(find(metrics, 'sap_sm20_other_events').value).toBe(2666);
    expect(metrics.some((m) => m.fullName === 'sap_sm20_successful_logons')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm20_failed_logons')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm20_rfc_logons')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm20_rfc_calls')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm20_program_count')).toBe(false);
  });

  test('empty data array: no crash, monitor_type still emitted', () => {
    const metrics = parse({ monitor_type: 'SM20', data: [] });
    expect(metrics.some((m) => m.fullName === 'sap_sm20_total_events')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_sm20_monitor_type_count')).toBe(true);
  });

  test('parseToMetrics dispatch and exported collector', () => {
    expect(typeof collectSM20).toBe('function');
    const metrics = parse(REAL);
    expect(metrics.length).toBeGreaterThan(0);
    for (const info of metrics.filter((m) => m.fullName === 'sap_sm20_event_info')) {
      expect(Object.keys(info.labels).length).toBe(6);
    }
  });
});