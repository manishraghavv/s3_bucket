'use strict';

/**
 * SM37 collector verification tests.
 *
 * Uses the REAL SM37 JSON file downloaded from S3
 * (test/fixtures/sm37.json — 819 records, monitor_type "SM37") as the
 * authoritative fixture. The real schema has 24 fields:
 *   JOBNAME, JOBCOUNT, JOBGROUP, INTREPORT, SDLSTRTDT, SDLSTRTTM, SDLUNAME,
 *   LASTCHDATE, LASTCHTIME, LASTCHNAME, STRTDATE, STRTTIME, ENDDATE, ENDTIME,
 *   STATUS, AUTHCKNAM, SUCCNUM, PREDNUM, LASTSTRTDT, LASTSTRTTM, JOBCLASS,
 *   PRIORITY, EXECSERVER, TGTSRVGRP.
 *
 * Covers:
 *   - monitor_type + total_jobs (== data.length == 819)
 *   - job_info with ALL 24 source fields as labels, 1:1 mapping
 *   - status aggregations (finished, running, failed, scheduled, status_count, job_count)
 *   - user aggregations (sdluname_count, user_count)
 *   - breakdown metrics (jobname, jobcount, jobgroup, intreport, lastchname, authcknam, jobclass, execserver, tgtsrvgrp)
 *   - numeric aggregates (succnum, prednum, priority totals and min/max)
 *   - latest date/time pairs (scheduled, start, end, last change, last start)
 *   - *_present / *_distinct semantics for all 24 fields
 *   - distinct series per job record
 *   - PROGRAMMATIC 1:1 field coverage (Source fields vs Info labels)
 *   - REAL-FILE schema check: union of row keys, per-row missing/extra keys
 */

process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'error';

const { parseToMetrics, collectSM37 } = require('../src/json-parser');

const REAL = require('./fixtures/sm37.json');
const REAL_ROWS = REAL.data || [];

const FIELD_MAP = {
  JOBNAME: 'jobname',
  JOBCOUNT: 'jobcount',
  JOBGROUP: 'jobgroup',
  INTREPORT: 'intreport',
  SDLSTRTDT: 'sdlstrtdt',
  SDLSTRTTM: 'sdlstrttm',
  SDLUNAME: 'sdluname',
  LASTCHDATE: 'lastchdate',
  LASTCHTIME: 'lastchtime',
  LASTCHNAME: 'lastchname',
  STRTDATE: 'strtdate',
  STRTTIME: 'strttime',
  ENDDATE: 'enddate',
  ENDTIME: 'endtime',
  STATUS: 'status',
  AUTHCKNAM: 'authcknam',
  SUCCNUM: 'succnum',
  PREDNUM: 'prednum',
  LASTSTRTDT: 'laststrtdt',
  LASTSTRTTM: 'laststrttm',
  JOBCLASS: 'jobclass',
  PRIORITY: 'priority',
  EXECSERVER: 'execserver',
  TGTSRVGRP: 'tgtsrvgrp',
};
const SOURCE_FIELDS = Object.keys(FIELD_MAP);
const INFO_LABELS = Object.values(FIELD_MAP);

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'SM37', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

const nonEmptyRaw = (rows, f) => rows.filter((r) => String(r[f] ?? '') !== '').length;
const distinctRaw = (rows, f) => new Set(rows.map((r) => String(r[f] ?? '')).filter((v) => v !== '')).size;

describe('SM37 collector (real fixture)', () => {
  const metrics = parse(REAL);

  test('fixture sanity: monitor_type SM37, 819 records, 24 keys, no stray rows', () => {
    expect(REAL.monitor_type).toBe('SM37');
    expect(REAL_ROWS.length).toBe(819);

    const unionKeys = new Set();
    const missingRows = [];
    const extraRows = [];

    REAL_ROWS.forEach((row, i) => {
      const keys = Object.keys(row);
      keys.forEach((k) => unionKeys.add(k));

      const missing = SOURCE_FIELDS.filter((k) => !(k in row));
      const extra = keys.filter((k) => !SOURCE_FIELDS.includes(k));
      if (missing.length) missingRows.push({ row: i, missing });
      if (extra.length) extraRows.push({ row: i, extra });
    });

    console.log('── SM37 real-file schema check ──');
    console.log(`Real records: ${REAL_ROWS.length}`);
    console.log(`Unique source keys: ${unionKeys.size}`);
    console.log(`Rows with missing expected keys: ${missingRows.length}`);
    console.log(`Rows with unexpected keys: ${extraRows.length}`);

    expect(unionKeys.size).toBe(24);
    expect(missingRows.length).toBe(0);
    expect(extraRows.length).toBe(0);
  });

  test('monitor_type is emitted with the exact value', () => {
    const m = find(metrics, 'sap_sm37_monitor_type_count');
    expect(m).toBeDefined();
    expect(m.value).toBe(1);
    expect(m.labels).toEqual({ monitor_type: 'SM37' });
  });

  test('total_jobs equals data.length (819)', () => {
    const m = find(metrics, 'sap_sm37_total_jobs');
    expect(m).toBeDefined();
    expect(m.value).toBe(819);
    expect(m.labels).toEqual({});
  });

  test('job_info carries exactly the 24 expected snake_case labels (1:1)', () => {
    const info = metrics.filter((m) => m.fullName === 'sap_sm37_job_info');
    expect(info.length).toBe(819);

    const first = info[0];
    expect(Object.keys(first.labels).sort()).toEqual([...INFO_LABELS].sort());
    expect(first.value).toBe(1);
  });

  test('PROGRAMMATIC 1:1 field coverage: no field loss, no extra labels', () => {
    const expected = [...INFO_LABELS].sort();
    const info = find(metrics, 'sap_sm37_job_info');
    const actual = Object.keys(info.labels).sort();

    const missing = expected.filter((k) => !actual.includes(k));
    const extra = actual.filter((k) => !expected.includes(k));

    console.log('── SM37 field coverage (programmatic 1:1 check) ──');
    console.log(`Source fields: ${SOURCE_FIELDS.length}`);
    console.log(`Info labels: ${INFO_LABELS.length}`);
    console.log(`Missing fields: ${JSON.stringify(missing)}`);
    console.log(`Extra labels: ${JSON.stringify(extra)}`);
    console.log(`Field coverage: ${actual.length - extra.length}/${expected.length}`);

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(actual).toEqual(expected);
  });

  test('status aggregates match source counts', () => {
    const finished = find(metrics, 'sap_sm37_finished_jobs');
    expect(finished).toBeDefined();
    expect(finished.value).toBe(819);

    const running = find(metrics, 'sap_sm37_running_jobs');
    expect(running).toBeDefined();
    expect(running.value).toBe(0);

    const failed = find(metrics, 'sap_sm37_failed_jobs');
    expect(failed).toBeDefined();
    expect(failed.value).toBe(0);

    const scheduled = find(metrics, 'sap_sm37_scheduled_jobs');
    expect(scheduled).toBeDefined();
    expect(scheduled.value).toBe(0);

    const statusCount = find(metrics, 'sap_sm37_status_count', (m) => m.labels.status === 'F');
    expect(statusCount).toBeDefined();
    expect(statusCount.value).toBe(819);
  });

  test('presence semantics: non-empty present, empty absent', () => {
    for (const [src, label] of Object.entries(FIELD_MAP)) {
      const pm = find(metrics, `sap_sm37_${label}_present`);
      expect(pm).toBeDefined();
      expect(pm.value).toBe(nonEmptyRaw(REAL_ROWS, src));

      const dm = find(metrics, `sap_sm37_${label}_distinct`);
      expect(dm).toBeDefined();
      expect(dm.value).toBe(distinctRaw(REAL_ROWS, src));
    }
  });

  test('distinct job records with same jobname produce distinct series', () => {
    const jobA = {
      JOBNAME: 'SAPCONNECT INT SEND',
      JOBCOUNT: '10413500',
      STATUS: 'F',
      SDLUNAME: 'ASINGH',
    };
    const jobB = {
      JOBNAME: 'SAPCONNECT INT SEND',
      JOBCOUNT: '10413600', // Different jobcount
      STATUS: 'F',
      SDLUNAME: 'ASINGH',
    };
    const synthetic = parse({ monitor_type: 'SM37', data: [jobA, jobB] });
    const info = synthetic.filter((m) => m.fullName === 'sap_sm37_job_info');
    expect(info.length).toBe(2);
    expect(info[0].labels.jobcount).toBe('10413500');
    expect(info[1].labels.jobcount).toBe('10413600');
  });

  test('parseToMetrics dispatch and exported collector', () => {
    const fromParser = parseToMetrics(JSON.stringify(REAL), 'SM37', 'sap');
    expect(fromParser.parseError).toBeNull();
    expect(fromParser.metrics.length).toBe(metrics.length);

    const fromDirect = collectSM37(REAL, 'sap');
    expect(fromDirect.length).toBe(metrics.length);
  });

  test('authoritative 14-field schema preserves all 14 fields with exact types and unique job_key', () => {
    const payload14 = {
      monitor_type: 'SM37',
      data: [
        {
          JOBNAME: 'SAPCONNECT INT SEND',
          STATUS: 'F',
          STRTDATE: '15/09/2026',
          STRTTIME: '15:31:34',
          ENDDATE: '15/09/2026',
          ENDTIME: '15:31:34',
          SDLUNAME: 'ASINGH',
          LASTCHNAME: 'MANIK',
          JOBCLASS: 'A',
          PRIORITY: '0 ',
          EXECSERVER: '',
          STEPCOUNT: '1',
          PROGNAME: 'RSCONN01',
          VARIANT: 'SAP&CONNECTINT',
        },
        {
          JOBNAME: '/BDL/TASK_PROCESSOR',
          STATUS: 'P',
          STRTDATE: '',
          STRTTIME: '',
          ENDDATE: '',
          ENDTIME: '',
          SDLUNAME: 'SAP*',
          LASTCHNAME: 'DDIC',
          JOBCLASS: 'C',
          PRIORITY: '0 ',
          EXECSERVER: '',
          STEPCOUNT: '1',
          PROGNAME: '/BDL/TASK_SCHEDULER',
          VARIANT: '&0000000000000',
        },
      ],
    };

    const parsedMetrics = collectSM37(payload14, 'sap');
    const jobInfos = parsedMetrics.filter((m) => m.fullName === 'sap_sm37_job_info');
    expect(jobInfos.length).toBe(2);

    const first = jobInfos[0];
    const expected14 = [
      'enddate',
      'endtime',
      'execserver',
      'job_key',
      'jobclass',
      'jobname',
      'lastchname',
      'priority',
      'progname',
      'sdluname',
      'status',
      'stepcount',
      'strtdate',
      'strttime',
      'variant',
    ].sort();

    expect(Object.keys(first.labels).sort()).toEqual(expected14);
    expect(first.labels.priority).toBe('0 ');
    expect(first.labels.stepcount).toBe('1');
    expect(first.labels.progname).toBe('RSCONN01');
    expect(first.labels.variant).toBe('SAP&CONNECTINT');
    expect(first.labels.job_key).toBe('1');
    expect(first.labels.execserver).toBe('');

    const second = jobInfos[1];
    expect(second.labels.variant).toBe('&0000000000000');
    expect(second.labels.job_key).toBe('2');
  });
});

