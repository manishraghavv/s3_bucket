'use strict';

/**
 * ST06 collector verification tests.
 *
 * Exercises parseToMetrics() with the authoritative ST06 schema:
 *   top level: monitor_type, host
 *   cpu[]:     numberOfCpus, systemUtilization, userUtilization, idle
 *   memory[]:  physical, freeValue, swapFree, swapConfigured
 *   fsys[]:    serialnr, fsysname, capacity, free, freeP
 *
 * Covers zero preservation, decimal memory precision, empty-string
 * handling, duplicate fsys records, record counts, 1:1 field↔label
 * mapping and that all pre-existing ST06 metrics are still emitted.
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'warn';

const { parseToMetrics } = require('../src/json-parser');

const EXACT_SAMPLE = {
  monitor_type: 'ST06',
  host: 'SAPIDES',
  cpu: [
    { numberOfCpus: 4, systemUtilization: 0, userUtilization: 1, idle: 99 },
  ],
  memory: [
    {
      physical: 15885.26171875,
      freeValue: 3455.15625,
      swapFree: 49151.99609375,
      swapConfigured: 49151.99609375,
    },
  ],
  fsys: [
    { serialnr: 400, fsysname: '/', capacity: 30705, free: 19460, freeP: 63 },
    // duplicate rows on purpose — must NOT be deduplicated
    { serialnr: 400, fsysname: '/', capacity: 30705, free: 19460, freeP: 63 },
    // zeros + empty fsysname — zeros present, empty name absent
    { serialnr: 0, fsysname: '', capacity: 0, free: 0, freeP: 0 },
  ],
};

const CPU_LABELS = ['number_of_cpus', 'system_utilization', 'user_utilization', 'idle'];
const MEMORY_LABELS = ['physical', 'free_value', 'swap_free', 'swap_configured'];
const FSYS_LABELS = ['serialnr', 'fsysname', 'capacity', 'free', 'free_p'];

function find(metrics, name, predicate = () => true) {
  return metrics.filter((m) => m.fullName === name).find(predicate);
}

function parse(payload) {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'ST06', 'sap');
  expect(parseError).toBeNull();
  return metrics;
}

describe('ST06 collector', () => {
  test('monitor_type and host are represented', () => {
    const metrics = parse(EXACT_SAMPLE);
    const mt = find(metrics, 'sap_st06_monitor_type_count');
    expect(mt).toBeDefined();
    expect(mt.labels.monitor_type).toBe('ST06');
    expect(mt.value).toBe(1);

    expect(find(metrics, 'sap_st06_host_count', (m) => m.labels.host === 'SAPIDES').value).toBe(1);
    expect(find(metrics, 'sap_st06_host_present').value).toBe(1);
    expect(find(metrics, 'sap_st06_host_distinct').value).toBe(1);
  });

  test('CPU: 1:1 field coverage, exact values, zero preserved', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_st06_cpu_count').value).toBe(1);

    const infos = metrics.filter((m) => m.fullName === 'sap_st06_cpu_info');
    expect(infos.length).toBe(1);
    const info = infos[0];
    expect(Object.keys(info.labels).sort()).toEqual([...CPU_LABELS].sort());
    expect(info.labels.number_of_cpus).toBe('4');
    expect(info.labels.system_utilization).toBe('0'); // zero preserved as "0"
    expect(info.labels.user_utilization).toBe('1');
    expect(info.labels.idle).toBe('99');

    // presence/distinct — systemUtilization = 0 must count as PRESENT
    expect(find(metrics, 'sap_st06_number_of_cpus_present').value).toBe(1);
    expect(find(metrics, 'sap_st06_system_utilization_present').value).toBe(1);
    expect(find(metrics, 'sap_st06_user_utilization_present').value).toBe(1);
    expect(find(metrics, 'sap_st06_idle_present').value).toBe(1);

    // aggregates — 0 totals are emitted, not dropped
    expect(find(metrics, 'sap_st06_number_of_cpus_total').value).toBe(4);
    expect(find(metrics, 'sap_st06_number_of_cpus_max').value).toBe(4);
    expect(find(metrics, 'sap_st06_number_of_cpus_min').value).toBe(4);
    expect(find(metrics, 'sap_st06_system_utilization_total').value).toBe(0);
    expect(find(metrics, 'sap_st06_system_utilization_max').value).toBe(0);
    expect(find(metrics, 'sap_st06_system_utilization_min').value).toBe(0);
    expect(find(metrics, 'sap_st06_user_utilization_total').value).toBe(1);
    expect(find(metrics, 'sap_st06_idle_total').value).toBe(99);
    expect(find(metrics, 'sap_st06_idle_min').value).toBe(99);
  });

  test('MEMORY: 1:1 field coverage, decimal precision preserved', () => {
    const metrics = parse(EXACT_SAMPLE);
    const infos = metrics.filter((m) => m.fullName === 'sap_st06_memory_info');
    expect(infos.length).toBe(1);
    const info = infos[0];
    expect(Object.keys(info.labels).sort()).toEqual([...MEMORY_LABELS].sort());
    expect(info.labels.physical).toBe('15885.26171875');
    expect(info.labels.free_value).toBe('3455.15625');
    expect(info.labels.swap_free).toBe('49151.99609375');
    expect(info.labels.swap_configured).toBe('49151.99609375');

    for (const field of MEMORY_LABELS) {
      expect(find(metrics, `sap_st06_${field}_present`).value).toBe(1);
      expect(find(metrics, `sap_st06_${field}_distinct`).value).toBe(1);
    }

    // exact decimal values — NOT rounded to integers or truncated
    expect(find(metrics, 'sap_st06_physical_total').value).toBe(15885.26171875);
    expect(find(metrics, 'sap_st06_physical_max').value).toBe(15885.26171875);
    expect(find(metrics, 'sap_st06_physical_min').value).toBe(15885.26171875);
    expect(find(metrics, 'sap_st06_free_value_total').value).toBe(3455.15625);
    expect(find(metrics, 'sap_st06_swap_free_total').value).toBe(49151.99609375);
    expect(find(metrics, 'sap_st06_swap_configured_total').value).toBe(49151.99609375);
  });

  test('FSYS: 1:1 field coverage, duplicates not collapsed, raw fsysname', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(find(metrics, 'sap_st06_total_filesystems').value).toBe(3);

    const infos = metrics.filter((m) => m.fullName === 'sap_st06_fsys_info');
    expect(infos.length).toBe(3); // every row emits its own series
    for (const info of infos) {
      expect(Object.keys(info.labels).sort()).toEqual([...FSYS_LABELS].sort());
    }

    // duplicate "/" rows are counted, not deduplicated
    expect(find(metrics, 'sap_st06_fsysname_count', (m) => m.labels.fsysname === '/').value).toBe(2);
    expect(find(metrics, 'sap_st06_serialnr_count', (m) => m.labels.serialnr === '400').value).toBe(2);

    // zero record: serialnr=0 stays "0", empty fsysname stays ""
    const zeroInfo = infos.find((m) => m.labels.serialnr === '0');
    expect(zeroInfo.labels.serialnr).toBe('0');
    expect(zeroInfo.labels.capacity).toBe('0');
    expect(zeroInfo.labels.free).toBe('0');
    expect(zeroInfo.labels.free_p).toBe('0');
    expect(zeroInfo.labels.fsysname).toBe('');

    // presence semantics: zeros present, empty fsysname absent
    expect(find(metrics, 'sap_st06_serialnr_present').value).toBe(3);
    expect(find(metrics, 'sap_st06_capacity_present').value).toBe(3);
    expect(find(metrics, 'sap_st06_fsysname_present').value).toBe(2);
    expect(find(metrics, 'sap_st06_free_p_present').value).toBe(3);

    // aggregates
    expect(find(metrics, 'sap_st06_capacity_total').value).toBe(30705 + 30705 + 0);
    expect(find(metrics, 'sap_st06_capacity_max').value).toBe(30705);
    expect(find(metrics, 'sap_st06_capacity_min').value).toBe(0);
    expect(find(metrics, 'sap_st06_free_total').value).toBe(19460 + 19460 + 0);
    expect(find(metrics, 'sap_st06_free_p_total').value).toBe(63 + 63 + 0);
    expect(find(metrics, 'sap_st06_free_p_min').value).toBe(0);
  });

  test('record counts: cpu/memory/fsys records match info series', () => {
    const metrics = parse(EXACT_SAMPLE);
    expect(metrics.filter((m) => m.fullName === 'sap_st06_cpu_info').length).toBe(EXACT_SAMPLE.cpu.length);
    expect(metrics.filter((m) => m.fullName === 'sap_st06_memory_info').length).toBe(EXACT_SAMPLE.memory.length);
    expect(metrics.filter((m) => m.fullName === 'sap_st06_fsys_info').length).toBe(EXACT_SAMPLE.fsys.length);
  });

  test('existing legacy ST06 metrics remain unchanged', () => {
    const metrics = parse(EXACT_SAMPLE);
    // pre-existing average metrics (cpu section)
    expect(find(metrics, 'sap_st06_cpu_user')).toBeDefined();
    expect(find(metrics, 'sap_st06_cpu_system')).toBeDefined();
    expect(find(metrics, 'sap_st06_cpu_idle')).toBeDefined();
    expect(find(metrics, 'sap_st06_cpu_wait')).toBeDefined();
    // pre-existing memory / disk aggregates
    expect(find(metrics, 'sap_st06_memory_free_avg')).toBeDefined();
    expect(find(metrics, 'sap_st06_swap_size_avg')).toBeDefined();
    expect(find(metrics, 'sap_st06_swap_free_avg')).toBeDefined();
    expect(find(metrics, 'sap_st06_page_in_rate')).toBeDefined();
    expect(find(metrics, 'sap_st06_page_out_rate')).toBeDefined();
    expect(find(metrics, 'sap_st06_disk_utilization')).toBeDefined();
    expect(find(metrics, 'sap_st06_disk_queue_length')).toBeDefined();
  });

  test('empty-string host: absent but no crash', () => {
    const payload = { ...EXACT_SAMPLE, host: '' };
    const metrics = parse(payload);
    expect(metrics.some((m) => m.fullName === 'sap_st06_host_count')).toBe(false);
    expect(find(metrics, 'sap_st06_host_present').value).toBe(0);
    expect(find(metrics, 'sap_st06_host_distinct').value).toBe(0);
  });

  // ── Per-filesystem numeric gauges (sap_st06_filesystem_*) ──────────────────

  test('FSYS: numeric gauges per record with stable identity labels only', () => {
    const metrics = parse(EXACT_SAMPLE);
    const capacity = metrics.filter((m) => m.fullName === 'sap_st06_filesystem_capacity');
    const free = metrics.filter((m) => m.fullName === 'sap_st06_filesystem_free');
    const freeP = metrics.filter((m) => m.fullName === 'sap_st06_filesystem_free_percent');

    // 3 fsys records → 3 entries per family (duplicates each emit)
    expect(capacity.length).toBe(3);
    expect(free.length).toBe(3);
    expect(freeP.length).toBe(3);

    // labels contain ONLY stable identity fields — never capacity/free/free_p
    for (const m of [...capacity, ...free, ...freeP]) {
      expect(Object.keys(m.labels).sort()).toEqual(['fsysname', 'serialnr']);
    }

    // exact numeric values (numbers, not strings)
    const rootCap = capacity.find((m) => m.labels.fsysname === '/');
    expect(rootCap.labels.serialnr).toBe('400');
    expect(rootCap.value).toBe(30705);
    expect(typeof rootCap.value).toBe('number');
    expect(free.find((m) => m.labels.fsysname === '/').value).toBe(19460);
    expect(freeP.find((m) => m.labels.fsysname === '/').value).toBe(63);

    // zero record: numeric 0 preserved, identity keeps serialnr "0"
    const zeroCap = capacity.find((m) => m.labels.serialnr === '0');
    expect(zeroCap).toBeDefined();
    expect(zeroCap.value).toBe(0);
    expect(zeroCap.labels.fsysname).toBe('');
  });

  test('FSYS: changing free/capacity never affects the filesystem identity', () => {
    const payload = {
      monitor_type: 'ST06',
      host: 'SAPIDES',
      fsys: [
        { serialnr: 710, fsysname: '/sybase', capacity: 377706, free: 30792, freeP: 8 },
        { serialnr: 710, fsysname: '/sybase', capacity: 400000, free: 50000, freeP: 12 },
      ],
    };
    const metrics = parse(payload);
    const caps = metrics.filter((m) => m.fullName === 'sap_st06_filesystem_capacity');
    expect(caps.length).toBe(2);
    for (const c of caps) {
      expect(c.labels).toEqual({ serialnr: '710', fsysname: '/sybase' });
    }
    expect(caps.map((c) => c.value).sort((a, b) => a - b)).toEqual([377706, 400000]);
    const pct = metrics.filter((m) => m.fullName === 'sap_st06_filesystem_free_percent');
    expect(pct.map((m) => m.value).sort((a, b) => a - b)).toEqual([8, 12]);
  });

  test('missing/empty arrays: no crash, no per-filesystem gauges, legacy scalars remain', () => {
    // no arrays at all
    const bare = parse({ monitor_type: 'ST06', host: 'SAPIDES' });
    expect(bare.some((m) => m.fullName === 'sap_st06_total_filesystems')).toBe(false);
    expect(bare.some((m) => m.fullName === 'sap_st06_fsys_info')).toBe(false);
    expect(bare.some((m) => m.fullName === 'sap_st06_filesystem_capacity')).toBe(false);
    expect(bare.some((m) => m.fullName === 'sap_st06_filesystem_free')).toBe(false);
    expect(bare.some((m) => m.fullName === 'sap_st06_filesystem_free_percent')).toBe(false);
    // legacy CPU scalars still emitted (0 when arrays are missing)
    expect(find(bare, 'sap_st06_cpu_idle')).toBeDefined();
    expect(find(bare, 'sap_st06_cpu_user')).toBeDefined();

    // empty arrays
    const empty = parse({
      monitor_type: 'ST06',
      host: 'SAPIDES',
      cpu: [],
      memory: [],
      fsys: [],
    });
    expect(empty.some((m) => m.fullName === 'sap_st06_cpu_info')).toBe(false);
    expect(empty.some((m) => m.fullName === 'sap_st06_memory_info')).toBe(false);
    expect(empty.some((m) => m.fullName === 'sap_st06_fsys_info')).toBe(false);
    expect(empty.some((m) => m.fullName === 'sap_st06_filesystem_capacity')).toBe(false);
  });

  test('additive: fsys_info and numeric gauges coexist', () => {
    const metrics = parse(EXACT_SAMPLE);
    // the info series and all pre-existing aggregates are untouched
    expect(metrics.filter((m) => m.fullName === 'sap_st06_fsys_info').length).toBe(3);
    expect(find(metrics, 'sap_st06_total_filesystems').value).toBe(3);
    expect(find(metrics, 'sap_st06_capacity_total').value).toBe(30705 + 30705 + 0);
    expect(find(metrics, 'sap_st06_free_p_total').value).toBe(63 + 63 + 0);
    // new gauges are purely additive
    expect(metrics.filter((m) => m.fullName === 'sap_st06_filesystem_capacity').length).toBe(3);
    expect(metrics.filter((m) => m.fullName === 'sap_st06_filesystem_free_percent').length).toBe(3);
  });
});