'use strict';

/**
 * SLICENSE collector verification tests.
 *
 * Exercises parseToMetrics() directly with the exact SLICENSE source structure —
 * no S3, no metrics registry needed. Covers:
 *   - monitor_type + total_licenses (== data.length)
 *   - license_info with ALL 8 source fields as labels, 1:1 snake_case mapping
 *   - raw value preservation: identifiers keep leading zeroes, dates stay raw
 *     strings, values are never trimmed or converted to numbers
 *   - empty description preservation ("" stays visible, absent in *_present)
 *   - presence / distinct semantics for ALL 8 fields
 *   - duplicate records counted at collector level, never collapsed
 *   - per-field count metrics for all 8 fields
 *   - PROGRAMMATIC 1:1 field coverage check (Source fields vs Info labels)
 *   - dispatch through parseToMetrics
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics, collectSLICENSE } = require('../src/json-parser');

// The 8 source fields of the SLICENSE payload and their expected snake_case
// label names (camelCase → snake_case only, nothing renamed beyond that).
const FIELD_MAP = {
  product: 'product',
  description: 'description',
  hardwareKey: 'hardware_key',
  installationNo: 'installation_no',
  systemNo: 'system_no',
  validFrom: 'valid_from',
  validTo: 'valid_to',
  status: 'status',
};
const SOURCE_FIELDS = Object.keys(FIELD_MAP);
const INFO_LABELS = Object.values(FIELD_MAP);

// Exact source structure given in the spec — 2 records.
const EXACT_SAMPLE = {
  monitor_type: 'SLICENSE',
  data: [
    {
      product: 'NetWeaver_SYB',
      description: '',
      hardwareKey: 'O0141061857',
      installationNo: '0020697942',
      systemNo: '000000000850791997',
      validFrom: '20231228',
      validTo: '99991231',
      status: 'Valid',
    },
    {
      product: 'Maintenance_SYB',
      description: '',
      hardwareKey: 'O0141061857',
      installationNo: '0020697942',
      systemNo: '000000000850791997',
      validFrom: '20231228',
      validTo: '20240329',
      status: 'Expired',
    },
  ],
};

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'SLICENSE', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

describe('SLICENSE collector', () => {
  test('collectSLICENSE is exported and dispatch works through parseToMetrics', () => {
    expect(typeof collectSLICENSE).toBe('function');
    const metrics = parse(EXACT_SAMPLE);
    expect(metrics.length).toBeGreaterThan(0);
    expect(parseErrorSafe(EXACT_SAMPLE)).toBe(true);
  });

  test('monitor_type is emitted with the exact value', () => {
    const metrics = parse(EXACT_SAMPLE);
    const mt = find(metrics, 'sap_slicense_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('SLICENSE');
    expect(mt.value).toBe(1);
  });

  test('total_licenses equals data.length (2 for the sample), no dedup', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_slicense_total_licenses').value).toBe(2);
    expect(find(metrics, 'sap_slicense_total_licenses').value).toBe(EXACT_SAMPLE.data.length);
  });

  test('license_info carries exactly the 8 expected snake_case labels (1:1 mapping)', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_slicense_license_info');
    expect(infos.length).toBe(2);
    for (const info of infos) {
      expect(Object.keys(info.labels).sort()).toEqual([...INFO_LABELS].sort());
      expect(info.value).toBe(1);
    }
  });

  test('raw identifier / leading-zero / date / status values preserved exactly', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_slicense_license_info');

    // First record — exact raw values from the spec.
    const first = infos.find((m) => m.labels.product === 'NetWeaver_SYB');
    expect(first).toBeDefined();
    expect(first.labels.product).toBe('NetWeaver_SYB');
    expect(first.labels.description).toBe(''); // empty string preserved
    expect(first.labels.hardware_key).toBe('O0141061857');
    expect(first.labels.installation_no).toBe('0020697942'); // leading zero intact
    expect(first.labels.system_no).toBe('000000000850791997'); // string, leading zeroes intact
    expect(first.labels.valid_from).toBe('20231228'); // raw date string
    expect(first.labels.valid_to).toBe('99991231'); // raw date string
    expect(first.labels.status).toBe('Valid');

    // Second record — exact raw values from the spec.
    const second = infos.find((m) => m.labels.product === 'Maintenance_SYB');
    expect(second).toBeDefined();
    expect(second.labels.description).toBe('');
    expect(second.labels.hardware_key).toBe('O0141061857');
    expect(second.labels.installation_no).toBe('0020697942');
    expect(second.labels.system_no).toBe('000000000850791997');
    expect(second.labels.valid_from).toBe('20231228');
    expect(second.labels.valid_to).toBe('20240329');
    expect(second.labels.status).toBe('Expired');
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra labels', () => {
    const metrics = parse(EXACT_SAMPLE);
    // Source field set is derived from the actual payload JSON keys.
    const sourceFields = Object.keys(EXACT_SAMPLE.data[0]);
    // Expected snake_case mapping (camelCase → snake_case only).
    const mapped = sourceFields.map((f) => FIELD_MAP[f]);
    const infos = metrics.filter((m) => m.fullName === 'sap_slicense_license_info');
    const infoLabels = Object.keys(infos[0].labels);

    // Programmatic comparison — no manual claims.
    const missing = mapped.filter((l) => !infoLabels.includes(l));
    const extra = infoLabels.filter((l) => !mapped.includes(l));

    // Explicit output required by the spec.
    console.log('── SLICENSE field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${sourceFields.length}`);
    console.log(`Info labels: ${infoLabels.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra labels: ${JSON.stringify(extra)}`);
    console.log(`Field coverage: ${infoLabels.length}/${sourceFields.length}`);

    expect(sourceFields.length).toBe(8);
    expect(infoLabels.length).toBe(8);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('all 8 per-field count metrics count occurrences in source records', () => {
    const metrics = parse(EXACT_SAMPLE);
    const count = (name, labelValue) =>
      find(metrics, `sap_slicense_${name}_count`, (m) => m.labels[name] === labelValue).value;

    expect(count('product', 'NetWeaver_SYB')).toBe(1);
    expect(count('product', 'Maintenance_SYB')).toBe(1);
    expect(count('hardware_key', 'O0141061857')).toBe(2);
    expect(count('installation_no', '0020697942')).toBe(2);
    expect(count('system_no', '000000000850791997')).toBe(2);
    expect(count('valid_from', '20231228')).toBe(2);
    expect(count('valid_to', '99991231')).toBe(1);
    expect(count('valid_to', '20240329')).toBe(1);
    expect(count('status', 'Valid')).toBe(1);
    expect(count('status', 'Expired')).toBe(1);

    // description is "" in both records → no blank-label series emitted.
    expect(metrics.some((m) => m.fullName === 'sap_slicense_description_count')).toBe(false);
  });

  test('all 8 fields have _present metrics with correct semantics', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_slicense_product_present').value).toBe(2);
    expect(find(metrics, 'sap_slicense_description_present').value).toBe(0); // "" = absent
    expect(find(metrics, 'sap_slicense_hardware_key_present').value).toBe(2);
    expect(find(metrics, 'sap_slicense_installation_no_present').value).toBe(2);
    expect(find(metrics, 'sap_slicense_system_no_present').value).toBe(2);
    expect(find(metrics, 'sap_slicense_valid_from_present').value).toBe(2);
    expect(find(metrics, 'sap_slicense_valid_to_present').value).toBe(2);
    expect(find(metrics, 'sap_slicense_status_present').value).toBe(2);
  });

  test('all 8 fields have _distinct metrics with correct semantics', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_slicense_product_distinct').value).toBe(2);
    expect(find(metrics, 'sap_slicense_description_distinct').value).toBe(0); // "" never distinct
    expect(find(metrics, 'sap_slicense_hardware_key_distinct').value).toBe(1);
    expect(find(metrics, 'sap_slicense_installation_no_distinct').value).toBe(1);
    expect(find(metrics, 'sap_slicense_system_no_distinct').value).toBe(1);
    expect(find(metrics, 'sap_slicense_valid_from_distinct').value).toBe(1);
    expect(find(metrics, 'sap_slicense_valid_to_distinct').value).toBe(2);
    expect(find(metrics, 'sap_slicense_status_distinct').value).toBe(2);
  });

  test('empty description: preserved in license_info, absent in _present/_distinct', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_slicense_license_info');
    expect(infos.every((m) => m.labels.description === '')).toBe(true); // "" visible, not dropped
    expect(find(metrics, 'sap_slicense_description_present').value).toBe(0);
    expect(find(metrics, 'sap_slicense_description_distinct').value).toBe(0);
  });

  test('raw values are never trimmed (whitespace preserved)', () => {
    const padded = {
      ...EXACT_SAMPLE.data[0],
      product: '  Padded Product  ',
      description: '  ',
      status: '  Valid  ',
    };
    const payload = { monitor_type: 'SLICENSE', data: [padded] };
    const metrics = parse(payload);
    const infos = metrics.filter((m) => m.fullName === 'sap_slicense_license_info');
    expect(infos[0].labels.product).toBe('  Padded Product  ');
    expect(infos[0].labels.description).toBe('  '); // whitespace-only is raw-preserved
    expect(infos[0].labels.status).toBe('  Valid  ');
    // whitespace-only counts as PRESENT (no trim before presence check)
    expect(find(metrics, 'sap_slicense_description_present').value).toBe(1);
    expect(find(metrics, 'sap_slicense_description_distinct').value).toBe(1);
  });

  test('duplicate records: total_licenses, counts and info metrics never collapse', () => {
    const dup = { ...EXACT_SAMPLE.data[0] };
    const payload = { monitor_type: 'SLICENSE', data: [dup, { ...dup }, { ...dup }] };
    const metrics = parse(payload);

    expect(find(metrics, 'sap_slicense_total_licenses').value).toBe(3); // not deduplicated
    // At parse/collector level every input record produces its own info metric.
    expect(metrics.filter((m) => m.fullName === 'sap_slicense_license_info').length).toBe(3);
    // Occurrence counts count all 3 copies.
    expect(find(metrics, 'sap_slicense_product_count', (m) => m.labels.product === 'NetWeaver_SYB').value).toBe(3);
    expect(find(metrics, 'sap_slicense_status_count', (m) => m.labels.status === 'Valid').value).toBe(3);
    // Distinct collapses at the value level, not the record level.
    expect(find(metrics, 'sap_slicense_product_distinct').value).toBe(1);
  });

  test('info record count equals source record count at parse/collector level', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_slicense_license_info');
    expect(infos.length).toBe(EXACT_SAMPLE.data.length);
    expect(find(metrics, 'sap_slicense_total_licenses').value).toBe(infos.length);
  });

  test('empty data array: no crash, monitor_type still emitted', () => {
    const metrics = parse({ monitor_type: 'SLICENSE', data: [] });
    expect(metrics.some((m) => m.fullName === 'sap_slicense_total_licenses')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_slicense_monitor_type_count')).toBe(true);
  });
});

function parseErrorSafe(payload) {
  const { parseError } = parseToMetrics(JSON.stringify(payload), 'SLICENSE', 'sap');
  return parseError === null;
}