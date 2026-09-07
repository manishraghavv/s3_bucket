'use strict';

/**
 * ST22 collector verification tests — ZERO FIELD LOSS.
 *
 * Uses the REAL ST22 JSON file downloaded from S3
 * (test/fixtures/st22.json — 8 records, monitor_type "ST22") as the
 * authoritative fixture. The real schema has exactly 13 fields per record:
 *   sydate, sytime, syhost, syuser, dumpid, programname, includename,
 *   linenumber, errorAnalysis, shortText, include, lineno, program
 *
 * Covers:
 *   - full-object dispatch via parseToMetrics + exported collectST22
 *   - monitor_type_count + scalar aggregate families (total_dumps,
 *     line aggregates, latest date/time, present/distinct)
 *   - dump_info: one collector-level series per dump record with the exact
 *     13 snake_case source labels (1:1, no loss, no extras) + the derived
 *     dump_key identity label
 *   - raw-value preservation: linenumber "34" (string) vs lineno 34 (JSON
 *     number), multi-line errorAnalysis text, empty string fields
 *   - PROGRAMMATIC 1:1 field coverage (source JSON keys vs info labels)
 *   - IDENTITY: identical dumpid at different sytime stay distinct dump_keys;
 *     different dump IDs stay distinct; no dumpid-only collapse
 *   - empty / optional values do not crash parsing
 *   - scalar ST22 aggregates still fold correctly (additive change)
 *   - duplicate series from a second source carry the same deterministic
 *     dump_key (no incorrect logical split of one dump)
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics, collectST22 } = require('../src/json-parser');

const REAL = require('./fixtures/st22.json');
const REAL_ROWS = REAL.data || [];

// Authoritative source fields and their expected snake_case labels (1:1),
// in source order — derived from the actual JSON payload. dump_key is the one
// additional identity label the collector derives (not a source field).
const FIELD_MAP = {
  sydate: 'sydate',
  sytime: 'sytime',
  syhost: 'syhost',
  syuser: 'syuser',
  dumpid: 'dumpid',
  programname: 'programname',
  includename: 'includename',
  linenumber: 'linenumber',
  errorAnalysis: 'error_analysis',
  shortText: 'short_text',
  include: 'include',
  lineno: 'lineno',
  program: 'program',
};
const SOURCE_FIELDS = Object.keys(FIELD_MAP); // 13 lowercase source keys
const INFO_LABELS = Object.values(FIELD_MAP); // 13 snake_case labels

// Expected deterministic dump_key = raw sydate|sytime|dumpid|programname|linenumber.
function expectedDumpKey(r) {
  return [r.sydate, r.sytime, r.dumpid, r.programname, r.linenumber]
    .map((v) => (v === undefined || v === null ? '' : String(v)))
    .join('|')
    .substring(0, 110);
}

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'ST22', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

describe('ST22 collector (real fixture)', () => {
  test('fixture sanity: monitor_type ST22, 8 records, every row has the same 13 keys', () => {
    expect(REAL.monitor_type).toBe('ST22');
    expect(REAL_ROWS.length).toBe(8);

    const union = [...new Set(REAL_ROWS.flatMap((r) => Object.keys(r)))].sort();
    expect(union).toEqual([...SOURCE_FIELDS].sort());
    expect(union.length).toBe(13);

    // Every row must carry exactly the same expected key set — no missing,
    // no unexpected keys, in any row.
    const expected = [...SOURCE_FIELDS].sort();
    const rowsMissing = REAL_ROWS.filter((r) => expected.some((k) => !(k in r)));
    const rowsExtra = REAL_ROWS.filter((r) => Object.keys(r).some((k) => !expected.includes(k)));

    console.log('── ST22 real-file schema check ──');
    console.log(`Real records: ${REAL_ROWS.length}`);
    console.log(`Unique source keys: ${union.length}`);
    console.log(`Rows with missing expected keys: ${rowsMissing.length}`);
    console.log(`Rows with unexpected keys: ${rowsExtra.length}`);
    expect(rowsMissing.length).toBe(0);
    expect(rowsExtra.length).toBe(0);

    for (const r of REAL_ROWS) {
      expect(Object.keys(r).length).toBe(13);
    }
  });

  test('full-object dispatch: parseToMetrics handles ST22 and collectST22 is exported', () => {
    expect(typeof collectST22).toBe('function');
    const { metrics, parseError } = parseToMetrics(JSON.stringify(REAL), 'ST22', 'sap');
    expect(parseError).toBeNull();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.some((m) => m.fullName === 'sap_st22_dump_info')).toBe(true);
  });

  test('monitor_type is emitted with the exact value', () => {
    const metrics = parse(REAL);
    const mt = find(metrics, 'sap_st22_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('ST22');
    expect(mt.value).toBe(1);
  });

  test('scalar aggregate families still fold correctly (additive change)', () => {
    const metrics = parse(REAL);
    expect(find(metrics, 'sap_st22_total_dumps').value).toBe(8);

    // today_dumps uses the exporter system date, computed the same way.
    const now = new Date();
    const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const expectedToday = REAL_ROWS.filter(
      (r) => String(r.sydate) === todayStr || String(r.sydate).startsWith(todayStr),
    ).length;
    expect(find(metrics, 'sap_st22_today_dumps').value).toBe(expectedToday);

    // Line aggregates over the raw string / raw numeric line fields.
    const sumNum = (f) =>
      REAL_ROWS.reduce((a, r) => a + (r[f] === undefined || r[f] === null ? 0 : Number(r[f])), 0);
    expect(find(metrics, 'sap_st22_line_number_total').value).toBe(sumNum('linenumber'));
    expect(find(metrics, 'sap_st22_line_no_total').value).toBe(sumNum('lineno'));

    // Latest pair: newest combined YYYYMMDDHHMMSS wins (20260903 135107).
    expect(find(metrics, 'sap_st22_latest_date').value).toBe(20260903);
    expect(find(metrics, 'sap_st22_latest_time').value).toBe(135107);

    // dumpid frequency family — CALL_FUNCTION_CONFLICT_TYPE appears 3 times.
    const byId = new Map();
    for (const r of REAL_ROWS) byId.set(r.dumpid, (byId.get(r.dumpid) || 0) + 1);
    for (const [id, cnt] of byId) {
      const m = find(metrics, 'sap_st22_dump_id_count', (x) => x.labels.dump_id === id);
      expect(m).toBeDefined();
      expect(m.value).toBe(cnt);
    }

    // Free-text presence/distinct scalars — distinct counts unique raw
    // values (identical dump texts shared by same-type dumps count once).
    const distinctOf = (f) =>
      new Set(REAL_ROWS.map((r) => String(r[f])).filter((v) => v !== '')).size;
    expect(find(metrics, 'sap_st22_error_analysis_present').value).toBe(8);
    expect(find(metrics, 'sap_st22_short_text_present').value).toBe(8);
    expect(find(metrics, 'sap_st22_error_analysis_distinct').value).toBe(
      distinctOf('errorAnalysis'),
    );
    expect(find(metrics, 'sap_st22_short_text_distinct').value).toBe(distinctOf('shortText'));
  });

  test('dump_info: one collector-level series per record, value 1, 13 source + dump_key', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    expect(infos.length).toBe(8); // every source record → one info metric
    for (const info of infos) {
      expect(info.value).toBe(1);
      expect(Object.keys(info.labels).length).toBe(14); // 13 source + dump_key
      expect([...INFO_LABELS, 'dump_key'].sort()).toEqual(
        Object.keys(info.labels).sort(),
      );
    }
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra source labels', () => {
    const metrics = parse(REAL);
    const sourceFields = Object.keys(REAL_ROWS[0]); // authoritative 13 keys
    const mapped = sourceFields.map((f) => FIELD_MAP[f]);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    const infoLabels = Object.keys(infos[0].labels);
    const sourceLabels = infoLabels.filter((l) => l !== 'dump_key');

    const missing = mapped.filter((l) => !sourceLabels.includes(l));
    const extra = sourceLabels.filter((l) => !mapped.includes(l));

    console.log('── ST22 field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${sourceFields.length}`);
    console.log(`Info source labels: ${sourceLabels.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra source labels: ${JSON.stringify(extra)}`);
    expect(sourceFields.length).toBe(13);
    expect(sourceLabels.length).toBe(13);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('first real record is represented exactly (raw 1:1 values + dump_key)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    const first = infos[0]; // source order preserved → first data record
    const r0 = REAL_ROWS[0];

    expect(first.labels.sydate).toBe('20260903');
    expect(first.labels.sytime).toBe('122744');
    expect(first.labels.syhost).toBe('SAPIDES_JCI_00');
    expect(first.labels.syuser).toBe('AJAY');
    expect(first.labels.dumpid).toBe('CALL_FUNCTION_CONFLICT_LENG');
    expect(first.labels.programname).toBe('ZPRG_TEMP2');
    expect(first.labels.includename).toBe('ZPRG_TEMP2');
    expect(first.labels.linenumber).toBe('34'); // raw string stays string
    expect(first.labels.short_text).toBe(r0.shortText);
    expect(first.labels.include).toBe('ZPRG_TEMP2');
    expect(first.labels.lineno).toBe('34'); // JSON number 34 → "34"
    expect(first.labels.program).toBe('ZPRG_TEMP2');
    expect(first.labels.error_analysis).toContain('The call to function module');
    expect(first.labels.dump_key).toBe(expectedDumpKey(r0));
  });

  test('identical dumpid at different sytime stay distinct series (no collapse)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    const sameId = infos.filter((i) => i.labels.dumpid === 'CALL_FUNCTION_CONFLICT_TYPE');
    expect(sameId.length).toBe(3); // 012128 / 013122 / 013246 occurrences

    // Times differ AND dump_keys differ — dumpid alone is never the identity.
    const times = sameId.map((i) => i.labels.sytime).sort();
    expect(times).toEqual(['012128', '013122', '013246']);
    const keys = sameId.map((i) => i.labels.dump_key);
    expect(new Set(keys).size).toBe(3);
  });

  test('every dump record has a unique deterministic dump_key (different IDs stay distinct)', () => {
    const metrics = parse(REAL);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    const keys = infos.map((i) => i.labels.dump_key);
    expect(new Set(keys).size).toBe(8);

    // Deterministic: derived purely from source fields, same every scrape.
    for (let i = 0; i < infos.length; i++) {
      expect(infos[i].labels.dump_key).toBe(expectedDumpKey(REAL_ROWS[i]));
    }
  });

  test('empty / optional values do not crash parsing and keep all labels present', () => {
    const payload = {
      monitor_type: 'ST22',
      data: [
        {
          sydate: '20260903',
          sytime: '091500',
          dumpid: 'GETWA_NOT_ASSIGNED',
          // syhost / syuser / programname / includename / linenumber /
          // errorAnalysis / shortText / include / lineno / program are absent.
        },
        { sydate: '', sytime: '', syhost: '', syuser: '', dumpid: '' },
      ],
    };
    const metrics = parse(payload);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    expect(infos.length).toBe(2);

    const first = infos[0].labels;
    expect(first.syhost).toBe('');
    expect(first.syuser).toBe('');
    expect(first.programname).toBe('');
    expect(first.linenumber).toBe('');
    expect(first.error_analysis).toBe('');
    expect(first.short_text).toBe('');
    expect(first.include).toBe('');
    expect(first.lineno).toBe('');
    expect(first.program).toBe('');
    expect(first.dump_key).toBe('20260903|091500|GETWA_NOT_ASSIGNED||');

    const second = infos[1].labels;
    expect(Object.keys(second).length).toBe(14);
    expect(second.dump_key).toBe('||||');

    // Aggregates still parse (empty strings are never coerced to numbers).
    expect(find(metrics, 'sap_st22_total_dumps').value).toBe(2);
    expect(find(metrics, 'sap_st22_line_number_total').value).toBe(0);
  });

  test('duplicate series from a second source keep one deterministic identity', () => {
    // Two payloads/scrapes reporting the SAME dump must not produce two
    // logically distinct dumps: collector emits one info entry per record and
    // every entry of the same dump carries the identical dump_key + labels.
    const one = REAL_ROWS[0];
    const payload = { monitor_type: 'ST22', data: [one, one] };
    const metrics = parse(payload);
    const infos = metrics.filter((m) => m.fullName === 'sap_st22_dump_info');
    expect(infos.length).toBe(2); // collector level: no dedupe
    expect(infos[0].labels.dump_key).toBe(infos[1].labels.dump_key);
    expect(infos[0].labels).toEqual(infos[1].labels); // identical → same series downstream
  });

  test('empty data array emits only monitor_type_count (no phantom families)', () => {
    const { metrics, parseError } = parseToMetrics(
      JSON.stringify({ monitor_type: 'ST22', data: [] }),
      'ST22',
      'sap',
    );
    expect(parseError).toBeNull();
    expect(metrics).toEqual([
      expect.objectContaining({
        fullName: 'sap_st22_monitor_type_count',
        value: 1,
        labels: { monitor_type: 'ST22' },
      }),
    ]);
  });
});
