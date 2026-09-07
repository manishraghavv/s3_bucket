'use strict';

/**
 * STRUST collector verification tests.
 *
 * Exercises parseToMetrics() directly with the exact STRUST source structure —
 * no S3, no metrics registry needed. Covers:
 *   - monitor_type + total_records (== data.length)
 *   - pse_info with ALL 7 source fields as labels, 1:1 snake_case mapping
 *   - raw value preservation (no trim / no normalization, whitespace kept)
 *   - empty-string preservation (subject="" stays visible, absent in *_present)
 *   - presence / distinct semantics for ALL 7 fields
 *   - duplicate records counted, never collapsed
 *   - per-field count metrics for all 7 fields
 *   - PROGRAMMATIC 1:1 field coverage check (Source fields vs Info labels)
 *   - legacy X.509 certificate metrics preserved (additive, not removed)
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics } = require('../src/json-parser');
const x509 = require('@peculiar/x509');

// The 7 source fields of the STRUST payload — 1:1 with the pse_info labels
// after snake_case mapping (PSE_DESCRIPT → pse_descript, …).
const SOURCE_FIELDS = [
  'PSE_DESCRIPT',
  'SUBJECT',
  'SUBJECT_ALT',
  'ISSUER',
  'VALID_FROM',
  'VALID_TO',
  'CERTIFICATE',
];
const INFO_LABELS = [
  'pse_descript',
  'subject',
  'subject_alt',
  'issuer',
  'valid_from',
  'valid_to',
  'certificate',
];

const emptyRecord = {
  PSE_DESCRIPT: '',
  SUBJECT: '',
  SUBJECT_ALT: '',
  ISSUER: '',
  VALID_FROM: '',
  VALID_TO: '',
  CERTIFICATE: '',
};

// Exact source structure, 16 records:
//   - records 1–2: fully empty (empty strings everywhere)
//   - records 3–4: identical duplicate with every field populated
//   - record 5:    raw-whitespace preservation (SUBJECT keeps spaces)
//   - records 6–16: the real sample PSE_DESCRIPT values, other fields ""
const EXACT_SAMPLE = {
  monitor_type: 'STRUST',
  data: [
    { ...emptyRecord },
    { ...emptyRecord },
    {
      PSE_DESCRIPT: 'SSL Server',
      SUBJECT: 'CN=SAPIDES',
      SUBJECT_ALT: 'DNS:sapides.example.com',
      ISSUER: 'CN=SAP Global CA',
      VALID_FROM: '2024-01-01',
      VALID_TO: '2027-01-01',
      CERTIFICATE: 'MIIBzTCCAXKgAwIBAg...',
    },
    {
      PSE_DESCRIPT: 'SSL Server',
      SUBJECT: 'CN=SAPIDES',
      SUBJECT_ALT: 'DNS:sapides.example.com',
      ISSUER: 'CN=SAP Global CA',
      VALID_FROM: '2024-01-01',
      VALID_TO: '2027-01-01',
      CERTIFICATE: 'MIIBzTCCAXKgAwIBAg...',
    },
    {
      PSE_DESCRIPT: 'SSL Client (Anonymous)',
      SUBJECT: '  CN=Anonymous Client  ',
      SUBJECT_ALT: '',
      ISSUER: 'CN=SAP Global CA',
      VALID_FROM: '2025-06-01',
      VALID_TO: '2028-06-01',
      CERTIFICATE: '',
    },
    { ...emptyRecord, PSE_DESCRIPT: 'SSL Client (Standard)' },
    { ...emptyRecord, PSE_DESCRIPT: 'ERP C4C' },
    { ...emptyRecord, PSE_DESCRIPT: 'Financial Services Network Demo' },
    { ...emptyRecord, PSE_DESCRIPT: 'WSSE Web Service Security Test' },
    { ...emptyRecord, PSE_DESCRIPT: 'Standard' },
    { ...emptyRecord, PSE_DESCRIPT: 'Other System Encryption Certificates' },
    { ...emptyRecord, PSE_DESCRIPT: 'WS Security Keys' },
    { ...emptyRecord, PSE_DESCRIPT: 'Collaboration Integration Library: oAuth Appl.' },
    { ...emptyRecord, PSE_DESCRIPT: 'E-Learning' },
    { ...emptyRecord, PSE_DESCRIPT: 'GTS Signature Check' },
    { ...emptyRecord, PSE_DESCRIPT: 'Logon Ticket' },
  ],
};

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'STRUST', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

describe('STRUST collector', () => {
  test('monitor_type is emitted with the exact value', () => {
    const metrics = parse(EXACT_SAMPLE);
    const mt = find(metrics, 'sap_strust_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('STRUST');
    expect(mt.value).toBe(1);
  });

  test('total_records equals data.length', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_strust_total_records').value).toBe(EXACT_SAMPLE.data.length);
    expect(find(metrics, 'sap_strust_total_records').value).toBe(16);
  });

  test('pse_info carries exactly the 7 expected snake_case labels (1:1 mapping)', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_strust_pse_info');
    expect(infos.length).toBe(EXACT_SAMPLE.data.length);
    for (const info of infos) {
      expect(Object.keys(info.labels).sort()).toEqual([...INFO_LABELS].sort());
      expect(info.value).toBe(1);
    }
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra labels', () => {
    const metrics = parse(EXACT_SAMPLE);
    // Source field names are taken from the actual JSON payload keys.
    const sourceFields = Object.keys(EXACT_SAMPLE.data[0]);
    // Expected snake_case mapping (PSE_DESCRIPT → pse_descript, …).
    const mapped = sourceFields.map((f) => f.toLowerCase());
    const infos = metrics.filter((m) => m.fullName === 'sap_strust_pse_info');
    const infoLabels = Object.keys(infos[0].labels);

    // Programmatic comparison — no manual claims.
    const missing = mapped.filter((l) => !infoLabels.includes(l));
    const extra = infoLabels.filter((l) => !mapped.includes(l));

    // Explicit output required by the spec.
    console.log('── STRUST field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${sourceFields.length}`);
    console.log(`Info labels: ${infoLabels.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra labels: ${JSON.stringify(extra)}`);
    console.log(`Field coverage: ${infoLabels.length}/${sourceFields.length}`);

    expect(sourceFields.length).toBe(7);
    expect(infoLabels.length).toBe(7);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  test('raw values are preserved exactly (no trim, no normalization)', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_strust_pse_info');

    // Record 5 carries raw whitespace in SUBJECT — must survive untouched.
    const rawRec = infos.find((m) => m.labels.pse_descript === 'SSL Client (Anonymous)');
    expect(rawRec.labels.subject).toBe('  CN=Anonymous Client  ');
    expect(rawRec.labels.issuer).toBe('CN=SAP Global CA');
    expect(rawRec.labels.valid_from).toBe('2025-06-01');
    expect(rawRec.labels.valid_to).toBe('2028-06-01');

    // Fully populated record — exact source bytes.
    const fullRec = infos.find((m) => m.labels.subject === 'CN=SAPIDES');
    expect(fullRec.labels.pse_descript).toBe('SSL Server');
    expect(fullRec.labels.subject_alt).toBe('DNS:sapides.example.com');
    expect(fullRec.labels.certificate).toBe('MIIBzTCCAXKgAwIBAg...');
  });

  test('empty strings are preserved in pse_info and counted as ABSENT in _present', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_strust_pse_info');

    // The fully-empty records keep every label as "" — nothing dropped.
    const emptyInfos = infos.filter((m) => m.labels.pse_descript === '');
    expect(emptyInfos.length).toBe(2);
    for (const info of emptyInfos) {
      expect(Object.keys(info.labels)).toHaveLength(7);
      for (const label of INFO_LABELS) {
        expect(info.labels[label]).toBe('');
      }
    }

    // "" counts as absent for *_present but stays visible on the info series.
    expect(find(metrics, 'sap_strust_subject_present').value).toBe(3);
    expect(find(metrics, 'sap_strust_certificate_present').value).toBe(2);
    expect(infos.some((m) => m.labels.subject === '')).toBe(true);
    expect(infos.some((m) => m.labels.certificate === '')).toBe(true);
  });

  test('presence semantics: non-empty raw string present, "" absent', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_strust_pse_descript_present').value).toBe(14);
    expect(find(metrics, 'sap_strust_subject_present').value).toBe(3);
    expect(find(metrics, 'sap_strust_subject_alt_present').value).toBe(2);
    expect(find(metrics, 'sap_strust_issuer_present').value).toBe(3);
    expect(find(metrics, 'sap_strust_valid_from_present').value).toBe(3);
    expect(find(metrics, 'sap_strust_valid_to_present').value).toBe(3);
    expect(find(metrics, 'sap_strust_certificate_present').value).toBe(2);
  });

  test('distinct semantics: distinct raw non-empty values only', () => {
    const metrics = parse(EXACT_SAMPLE);
    // SSL Server appears twice → 13 distinct PSE_DESCRIPT values out of 14 present
    expect(find(metrics, 'sap_strust_pse_descript_distinct').value).toBe(13);
    // CN=SAPIDES ×2 + raw-spaced anonymous ×1 → 2 distinct subjects
    expect(find(metrics, 'sap_strust_subject_distinct').value).toBe(2);
    expect(find(metrics, 'sap_strust_subject_alt_distinct').value).toBe(1);
    expect(find(metrics, 'sap_strust_issuer_distinct').value).toBe(1);
    expect(find(metrics, 'sap_strust_valid_from_distinct').value).toBe(2);
    expect(find(metrics, 'sap_strust_valid_to_distinct').value).toBe(2);
    expect(find(metrics, 'sap_strust_certificate_distinct').value).toBe(1);
  });

  test('all 7 fields have _present and _distinct metrics (14 total)', () => {
    const metrics = parse(EXACT_SAMPLE);
    const names = new Set(metrics.map((m) => m.fullName));
    for (const field of INFO_LABELS) {
      expect(names.has(`sap_strust_${field}_present`)).toBe(true);
      expect(names.has(`sap_strust_${field}_distinct`)).toBe(true);
    }
  });

  test('per-field count metrics count occurrences in source records', () => {
    const metrics = parse(EXACT_SAMPLE);
    const count = (name, labelValue) =>
      find(metrics, `sap_strust_${name}_count`, (m) => m.labels[name] === labelValue).value;

    expect(count('pse_descript', 'SSL Server')).toBe(2); // duplicate preserved
    expect(count('pse_descript', 'Logon Ticket')).toBe(1);
    expect(count('subject', 'CN=SAPIDES')).toBe(2);
    expect(count('subject', '  CN=Anonymous Client  ')).toBe(1); // raw, untrimmed
    expect(count('subject_alt', 'DNS:sapides.example.com')).toBe(2);
    expect(count('issuer', 'CN=SAP Global CA')).toBe(3);
    expect(count('valid_from', '2024-01-01')).toBe(2);
    expect(count('valid_from', '2025-06-01')).toBe(1);
    expect(count('valid_to', '2027-01-01')).toBe(2);
    expect(count('valid_to', '2028-06-01')).toBe(1);
    expect(count('certificate', 'MIIBzTCCAXKgAwIBAg...')).toBe(2);
  });

  test('all 13 real PSE_DESCRIPT sample values appear as count labels', () => {
    const metrics = parse(EXACT_SAMPLE);
    const labelValues = metrics
      .filter((m) => m.fullName === 'sap_strust_pse_descript_count')
      .map((m) => m.labels.pse_descript);
    for (const expected of [
      'SSL Server',
      'SSL Client (Anonymous)',
      'SSL Client (Standard)',
      'ERP C4C',
      'Financial Services Network Demo',
      'WSSE Web Service Security Test',
      'Standard',
      'Other System Encryption Certificates',
      'WS Security Keys',
      'Collaboration Integration Library: oAuth Appl.',
      'E-Learning',
      'GTS Signature Check',
      'Logon Ticket',
    ]) {
      expect(labelValues).toContain(expected);
    }
  });

  test('duplicate records are preserved: counts, info series, total_records', () => {
    const metrics = parse(EXACT_SAMPLE);
    // identical pair (records 3+4): every occurrence counted
    expect(find(metrics, 'sap_strust_pse_descript_count', (m) => m.labels.pse_descript === 'SSL Server').value).toBe(2);
    expect(find(metrics, 'sap_strust_subject_count', (m) => m.labels.subject === 'CN=SAPIDES').value).toBe(2);
    expect(find(metrics, 'sap_strust_certificate_count', (m) => m.labels.certificate === 'MIIBzTCCAXKgAwIBAg...').value).toBe(2);
    // empty pair (records 1+2): total_records counts them, no collapse
    expect(find(metrics, 'sap_strust_total_records').value).toBe(16);
    expect(metrics.filter((m) => m.fullName === 'sap_strust_pse_info').length).toBe(16);
  });

  test('pse_info record count equals source record count (one series per record)', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_strust_pse_info');
    expect(infos.length).toBe(EXACT_SAMPLE.data.length);
    expect(find(metrics, 'sap_strust_total_records').value).toBe(infos.length);
  });

  test('legacy X.509 certificate metrics are preserved (additive)', async () => {
    // Build a real self-signed certificate so the legacy decode path runs.
    const alg = {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      publicExponent: new Uint8Array([1, 0, 1]),
      modulusLength: 2048,
    };
    const keys = await crypto.subtle.generateKey(alg, false, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=Legacy Cert',
      notBefore: new Date('2020/01/01'),
      notAfter: new Date('2020/01/02'), // already expired
      signingAlgorithm: alg,
      keys,
      extensions: [],
    });
    const pem = cert.toString('pem');
    const certB64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

    const payload = {
      monitor_type: 'STRUST',
      data: [
        {
          PSE_DESCRIPT: 'SSL Server',
          SUBJECT: '',
          SUBJECT_ALT: '',
          ISSUER: '',
          VALID_FROM: '',
          VALID_TO: '',
          CERTIFICATE: certB64,
        },
      ],
    };
    const metrics = parse(payload);

    // Legacy metric names + semantics unchanged:
    expect(find(metrics, 'sap_strust_certificate_count').value).toBe(1);
    const expired = find(metrics, 'sap_strust_certificate_expired');
    expect(expired).toBeDefined();
    expect(expired.value).toBe(1); // notAfter in the past
    expect(expired.labels.status).toBe('EXPIRED');
    expect(find(metrics, 'sap_strust_certificate_expiring').value).toBe(0);
    expect(find(metrics, 'sap_strust_certificate_days_remaining')).toBeDefined();

    // New complete-coverage metrics coexist in the same payload:
    expect(find(metrics, 'sap_strust_monitor_type_count').labels.monitor_type).toBe('STRUST');
    expect(find(metrics, 'sap_strust_total_records').value).toBe(1);
    const infos = metrics.filter((m) => m.fullName === 'sap_strust_pse_info');
    expect(infos).toHaveLength(1);
    expect(Object.keys(infos[0].labels).sort()).toEqual([...INFO_LABELS].sort());
    expect(infos[0].labels.pse_descript).toBe('SSL Server');
    // Raw value preserved up to the existing 128-char labelVal cap.
    expect(infos[0].labels.certificate).toBe(certB64.substring(0, 128));
    for (const field of INFO_LABELS) {
      expect(metrics.some((m) => m.fullName === `sap_strust_${field}_present`)).toBe(true);
      expect(metrics.some((m) => m.fullName === `sap_strust_${field}_distinct`)).toBe(true);
    }
  });

  test('empty data array: no crash, monitor_type still emitted', () => {
    const metrics = parse({ monitor_type: 'STRUST', data: [] });
    expect(metrics.some((m) => m.fullName === 'sap_strust_total_records')).toBe(false);
    expect(metrics.some((m) => m.fullName === 'sap_strust_monitor_type_count')).toBe(true);
  });
});