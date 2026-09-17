'use strict';

/**
 * ST03N collector verification tests.
 *
 * Runs parseToMetrics() against the REAL ST03N snapshot fixture
 * (test/fixtures/st03n.json — a verbatim copy of the live S3 object,
 * system JCI / client 811 / period D / periodStart 20260915) and asserts:
 *
 *   - every one of the 16 top-level sections is discovered, with its
 *     record-count metric matching the payload length
 *   - timeProfileTotal ([] in the live payload) never fails the parse
 *   - every documented numeric source field is exposed 1:1 in the unit its
 *     name promises (_ms / _s / _kb / _bytes)
 *   - the values equal the source values (spot checks against the raw JSON)
 *   - derived / aggregated numbers use the documented semantics
 *     (sums, and dialog-step weighted averages)
 *   - zero is preserved, missing fields are skipped instead of throwing
 *   - metric names are valid Prometheus names and labels stay bounded
 */

// config.js (loaded transitively via logger) requires AWS credentials to be
// present or it exits the process — provide dummy values for unit testing.
process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.LOG_LEVEL = 'warn';

const path = require('path');
const fs = require('fs');
const { parseToMetrics } = require('../src/json-parser');

const FIXTURE = path.join(__dirname, 'fixtures', 'st03n.json');
const RAW = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function parse() {
  const { metrics, parseError } = parseToMetrics(JSON.stringify(RAW), 'ST03N', 'sap');
  return { metrics, parseError };
}

const { metrics: METRICS } = parse();

/** All series of one metric name. */
function all(name) {
  return METRICS.filter((m) => m.fullName === `sap_st03n_${name}`);
}

/** First series of one metric name, optionally filtered by label match. */
function find(name, labels = {}) {
  return all(name).find((m) => Object.entries(labels).every(([k, v]) => m.labels[k] === v));
}

/** Series of one metric name matching a label, or a descriptive failure. */
function pick(name, labels) {
  const hit = find(name, labels);
  if (!hit) throw new Error(`no series ${name} for ${JSON.stringify(labels)}`);
  return hit.value;
}

/** Independent sum of a source field over a source section. */
function sourceSum(section, field) {
  return RAW[section].reduce((total, row) => total + Number(row[field]), 0);
}

/** Independent dialog-step weighted average of a source field. */
function sourceWeightedAvg(section, field, weightField) {
  let weighted = 0;
  let weight = 0;
  for (const row of RAW[section]) {
    const w = Number(row[weightField]);
    if (!Number.isFinite(w) || w <= 0) continue;
    weighted += Number(row[field]) * w;
    weight += w;
  }
  return weighted / weight;
}

// Source schema → metric suffix. This is the "every field, no drops" table:
// a field missing from here (or from the emitted metrics) fails the tests below.
const SCHEMA = {
  workloadOverview: {
    dimension: ['taskTypeName', 'task_type'],
    fields: {
      numberOfDialogSteps: 'workload_dialog_steps',
      avgResponseTimeMs: 'workload_avg_response_time_ms',
      avgProcessingTimeMs: 'workload_avg_processing_time_ms',
      avgCpuTimeMs: 'workload_avg_cpu_time_ms',
      avgDbTimeMs: 'workload_avg_db_time_ms',
      avgDbProcedureCallMs: 'workload_avg_db_procedure_call_ms',
      avgWaitTimeMs: 'workload_avg_wait_time_ms',
      avgGuiTimeMs: 'workload_avg_gui_time_ms',
      requestedDataKb: 'workload_requested_data_kb',
      numberOfSequentialReads: 'workload_sequential_reads',
      totalSequentialReadTimeS: 'workload_sequential_read_time_s',
      numberOfDirectReads: 'workload_direct_reads',
      totalDirectReadTimeS: 'workload_direct_read_time_s',
      numberOfLogicalDbChanges: 'workload_logical_db_changes',
      totalRollOutTimeS: 'workload_roll_out_time_s',
      numberOfRollInOperations: 'workload_roll_in_operations',
      numberOfRollOutOperations: 'workload_roll_out_operations',
    },
  },
  transactionProfile: {
    dimension: ['reportOrTransactionName', 'transaction'],
    fields: {
      numberOfDialogSteps: 'transaction_dialog_steps',
      totalResponseTimeS: 'transaction_total_response_time_s',
      avgResponseTimeMs: 'transaction_avg_response_time_ms',
      totalProcessingTimeS: 'transaction_total_processing_time_s',
      avgProcessingTimeMs: 'transaction_avg_processing_time_ms',
      totalCpuTimeS: 'transaction_total_cpu_time_s',
      avgCpuTimeMs: 'transaction_avg_cpu_time_ms',
      totalDatabaseTimeS: 'transaction_total_database_time_s',
      avgDbTimeMs: 'transaction_avg_db_time_ms',
      totalRollWaitTimeS: 'transaction_total_roll_wait_time_s',
      numberOfRoundtrips: 'transaction_roundtrips',
      avgFrontendNwTimeMs: 'transaction_avg_frontend_nw_time_ms',
      avgGuiTimeMs: 'transaction_avg_gui_time_ms',
      requestedDataKb: 'transaction_requested_data_kb',
      avgDataVolToServerByte: 'transaction_avg_data_vol_to_server_bytes',
      avgDataVolToFrontEndByte: 'transaction_avg_data_vol_to_frontend_bytes',
    },
  },
  timeProfile: {
    dimension: ['timeInterval', 'time_interval'],
    fields: {
      numberOfDialogSteps: 'timeprofile_dialog_steps',
      totalResponseTimeS: 'timeprofile_total_response_time_s',
      avgResponseTimeMs: 'timeprofile_avg_response_time_ms',
      totalProcessingTimeS: 'timeprofile_total_processing_time_s',
      avgProcessingTimeMs: 'timeprofile_avg_processing_time_ms',
      totalCpuTimeS: 'timeprofile_total_cpu_time_s',
      avgCpuTimeMs: 'timeprofile_avg_cpu_time_ms',
      totalDatabaseTimeS: 'timeprofile_total_database_time_s',
      avgDbTimeMs: 'timeprofile_avg_db_time_ms',
      totalDbProcedureTimeS: 'timeprofile_total_db_procedure_time_s',
      avgDbProcedureCallMs: 'timeprofile_avg_db_procedure_call_ms',
      totalRollWaitTimeS: 'timeprofile_total_roll_wait_time_s',
      avgRollWaitTimeMs: 'timeprofile_avg_roll_wait_time_ms',
      avgWaitTimeMs: 'timeprofile_avg_wait_time_ms',
      numberOfRoundtrips: 'timeprofile_roundtrips',
      avgFrontendNetworkTimeMs: 'timeprofile_avg_frontend_network_time_ms',
      avgGuiTimeMs: 'timeprofile_avg_gui_time_ms',
    },
  },
  topResponseTime: {
    dimension: ['wpid', 'wpid'],
    extraLabels: ['tasktype', 'account', 'tcode'],
    fields: {
      respti: 'top_response_time_ms',
      procti: 'top_response_processing_time_ms',
      cputi: 'top_response_cpu_time_ms',
      rollwaitti: 'top_response_roll_wait_ms',
      guitime: 'top_response_gui_time_ms',
      guinettime: 'top_response_gui_net_time_ms',
      dbpCount: 'top_response_db_procedure_count',
      dsqlcnt: 'top_response_db_sql_count',
      rollinti: 'top_response_roll_in_count',
      rolloutcnt: 'top_response_roll_out_count',
      rolloutti: 'top_response_roll_out_time_ms',
      usedbytes: 'top_response_used_bytes',
      rfcreceive: 'top_response_rfc_receive',
      rfcsend: 'top_response_rfc_send',
    },
  },
  topDbAccesses: {
    dimension: ['wpid', 'wpid'],
    extraLabels: ['tasktype', 'tcode', 'btcjobname'],
    fields: {
      respti: 'top_db_response_time_ms',
      procti: 'top_db_processing_time_ms',
      cputi: 'top_db_cpu_time_ms',
      rollwaitti: 'top_db_roll_wait_ms',
      guitime: 'top_db_gui_time_ms',
      guinettime: 'top_db_gui_net_time_ms',
      dbpCount: 'top_db_procedure_count',
      dsqlcnt: 'top_db_sql_count',
      rollinti: 'top_db_roll_in_count',
      rolloutcnt: 'top_db_roll_out_count',
      rolloutti: 'top_db_roll_out_time_ms',
      usedbytes: 'top_db_used_bytes',
      rfcreceive: 'top_db_rfc_receive',
      rfcsend: 'top_db_rfc_send',
    },
  },
  rfcClientProfile: {
    dimension: ['functionModule', 'function_module'],
    fields: {
      numberOfCalls: 'rfc_client_calls',
      totalExecutionTime: 'rfc_client_total_execution_time',
      avgTimePerRfc: 'rfc_client_avg_time_ms',
      totalCallTime: 'rfc_client_total_call_time',
      avgTimePerRequest: 'rfc_client_avg_time_per_request',
      sendData: 'rfc_client_send_data',
      receivedData: 'rfc_client_received_data',
    },
  },
  rfcClientDestProfile: {
    dimension: ['reportOrTransactionName', 'transaction'],
    fields: {
      numberOfCalls: 'rfc_client_dest_calls',
      totalExecutionTime: 'rfc_client_dest_total_execution_time',
      avgTimePerRfc: 'rfc_client_dest_avg_time_ms',
      totalCallTime: 'rfc_client_dest_total_call_time',
      avgTimePerRequest: 'rfc_client_dest_avg_time_per_request',
      sendData: 'rfc_client_dest_send_data',
      receivedData: 'rfc_client_dest_received_data',
      numberOfRecords: 'rfc_client_dest_records',
    },
  },
  rfcServerProfile: {
    dimension: ['functionModule', 'function_module'],
    fields: {
      numberOfRfcCalls: 'rfc_server_calls',
      totalExecutionTime: 'rfc_server_total_execution_time',
      avgTimePerRfc: 'rfc_server_avg_time_ms',
      totalCallTime: 'rfc_server_total_call_time',
      avgTimePerCall: 'rfc_server_avg_time_per_call',
      rfcSendData: 'rfc_server_send_data',
      receivedDataThroughRfc: 'rfc_server_received_data',
    },
  },
  rfcServerDestProfile: {
    dimension: ['reportOrTransactionName', 'transaction'],
    fields: {
      numberOfRfcCalls: 'rfc_server_dest_calls',
      totalExecutionTime: 'rfc_server_dest_total_execution_time',
      avgTimePerRfc: 'rfc_server_dest_avg_time_ms',
      totalCallTime: 'rfc_server_dest_total_call_time',
      avgTimePerCall: 'rfc_server_dest_avg_time_per_call',
      rfcSendData: 'rfc_server_dest_send_data',
      receivedData: 'rfc_server_dest_received_data',
      numberOfRecords: 'rfc_server_dest_records',
    },
  },
  userProfile: {
    dimension: ['user', 'user'],
    fields: {
      numberOfSteps: 'user_steps',
      totalResponseTimeS: 'user_total_response_time_s',
      avgResponseTimeMs: 'user_avg_response_time_ms',
      totalCpuTimeS: 'user_total_cpu_time_s',
      avgCpuTimeMs: 'user_avg_cpu_time_ms',
      totalDbTimeS: 'user_total_db_time_s',
      avgDbTimeMs: 'user_avg_db_time_ms',
      totalQueueTimeS: 'user_total_queue_time_s',
      avgQueueTimeMs: 'user_avg_queue_time_ms',
      totalGuiTimeS: 'user_total_gui_time_s',
      avgGuiTimeMs: 'user_avg_gui_time_ms',
    },
  },
  settlementStatistics: {
    dimension: ['client', 'client'],
    fields: {
      numberOfSteps: 'settlement_steps',
      responseTimeS: 'settlement_response_time_s',
      processingTimeS: 'settlement_processing_time_s',
      cpuTimeS: 'settlement_cpu_time_s',
      rollWaitTimeS: 'settlement_roll_wait_time_s',
      totalQueueTimeS: 'settlement_queue_time_s',
      numberOfDialogSteps: 'settlement_dialog_steps',
      numberOfUpdateSteps: 'settlement_update_steps',
      numberOfBackgroundSteps: 'settlement_background_steps',
      databaseTimeS: 'settlement_database_time_s',
    },
  },
  frontendStatistics: {
    dimension: ['frontendName', 'frontend_name'],
    extraLabels: ['instance'],
    fields: {
      numberOfSteps: 'frontend_steps',
      inputKb: 'frontend_input_kb',
      avgInputByte: 'frontend_avg_input_bytes',
      outputKb: 'frontend_output_kb',
      avgOutputByte: 'frontend_avg_output_bytes',
      frontendNetworkTimeS: 'frontend_network_time_s',
      avgFrontendNetworkTimeMs: 'frontend_avg_network_time_ms',
      guiTimeS: 'frontend_gui_time_s',
      avgGuiTimePerOperationMs: 'frontend_avg_gui_time_per_operation_ms',
      numberOfRoundtrips: 'frontend_roundtrips',
    },
  },
};

describe('ST03N collector — snapshot identity', () => {
  test('parses the real snapshot without error', () => {
    const { parseError } = parse();
    expect(parseError).toBeNull();
    expect(METRICS.length).toBeGreaterThan(1000);
  });

  test('snapshot_info carries monitor_type / system / client / period_type / period_start', () => {
    const info = find('snapshot_info');
    expect(info).toBeDefined();
    expect(info.value).toBe(1);
    expect(info.labels).toMatchObject({
      monitor_type: 'ST03N',
      system: 'JCI',
      client: '811',
      period_type: 'D',
      period_start: '20260915',
    });
  });

  test('system and client are attached to every ST03N series', () => {
    for (const m of METRICS) {
      expect(m.labels.system).toBe('JCI');
      // settlementStatistics is per SAP client: its own `client` field is the
      // dimension, so that section carries the record's client, not the scope's.
      const expected = m.fullName.startsWith('sap_st03n_settlement_') ? m.labels.client : '811';
      expect(m.labels.client).toBe(expected);
    }
  });
});

describe('ST03N collector — section discovery', () => {
  test('all 16 sections are counted, even the empty one', () => {
    const counts = Object.fromEntries(all('records').map((m) => [m.labels.section, m.value]));
    expect(counts).toEqual({
      workloadOverview: 17,
      transactionProfile: 99,
      earlywatchProfile: 68,
      timeProfile: 8,
      timeProfileTotal: 0,
      topResponseTime: 40,
      topDbAccesses: 40,
      memoryUseStatistics: 99,
      rfcClientProfile: 26,
      rfcClientDestProfile: 12,
      rfcServerProfile: 33,
      rfcServerDestProfile: 21,
      userProfile: 13,
      settlementStatistics: 4,
      frontendStatistics: 6,
    });
  });

  test('the empty timeProfileTotal emits no value metrics but does not break the parse', () => {
    // Names unique to the empty section (timeProfile's own metrics are named
    // timeprofile_<x>, its total_* fields spell out "total_").
    expect(all('timeprofile_total_dialog_steps')).toEqual([]);
    expect(all('timeprofile_total_avg_response_time_ms')).toEqual([]);
    expect(all('records').length).toBe(15);
    expect(find('records', { section: 'timeProfileTotal' }).value).toBe(0);
  });
});

describe('ST03N collector — workloadOverview (18 source fields)', () => {
  test('every numeric field is exposed per task type', () => {
    for (const [field, suffix] of Object.entries(SCHEMA.workloadOverview.fields)) {
      const series = all(suffix);
      expect(series.length).toBeGreaterThan(0);
      for (const m of series) expect(m.labels.task_type).toBeTruthy();
    }
  });

  test('values equal the source values (DIALOG row)', () => {
    const row = RAW.workloadOverview[0];
    expect(row.taskTypeName).toBe('DIALOG');
    for (const [field, suffix] of Object.entries(SCHEMA.workloadOverview.fields)) {
      if (row[field] === undefined) continue;
      expect(pick(suffix, { task_type: 'DIALOG' })).toBeCloseTo(Number(row[field]), 6);
    }
  });

  test('numeric 0 is preserved (DIALOG avgDbProcedureCallMs / avgWaitTimeMs / avgGuiTimeMs)', () => {
    expect(pick('workload_avg_db_procedure_call_ms', { task_type: 'DIALOG' })).toBe(0);
    expect(pick('workload_avg_wait_time_ms', { task_type: 'DIALOG' })).toBe(0);
    expect(pick('workload_avg_gui_time_ms', { task_type: 'DIALOG' })).toBe(0);
    expect(all('workload_avg_wait_time_ms').filter((m) => m.value === 0).length).toBeGreaterThan(0);
  });

  test('physical_reads is the documented sequential+direct sum', () => {
    const row = RAW.workloadOverview[0];
    expect(pick('physical_reads', { task_type: 'DIALOG' })).toBe(
      row.numberOfSequentialReads + row.numberOfDirectReads,
    );
  });

  test('every task type produces exactly one task_count series', () => {
    expect(all('task_count').reduce((t, m) => t + m.value, 0)).toBe(RAW.workloadOverview.length);
    expect(new Set(all('task_count').map((m) => m.labels.task_type)).size).toBe(
      RAW.workloadOverview.length,
    );
  });

  test('legacy app/Grafana metric names alias the same source fields', () => {
    expect(pick('dialog_count', { task_type: 'DIALOG' })).toBe(823);
    expect(pick('response_time_ms', { task_type: 'DIALOG' })).toBe(6846.5);
    expect(pick('processing_time_ms', { task_type: 'DIALOG' })).toBe(5876.9);
    expect(pick('cpu_time_ms', { task_type: 'DIALOG' })).toBe(25.6);
    expect(pick('db_time_ms', { task_type: 'DIALOG' })).toBe(16.4);
    expect(pick('sequential_reads', { task_type: 'DIALOG' })).toBe(71150);
    expect(pick('directory_reads', { task_type: 'DIALOG' })).toBe(87652);
    // Aliases carry the same numbers as the canonical names.
    expect(pick('dialog_count', { task_type: 'DIALOG' })).toBe(
      pick('workload_dialog_steps', { task_type: 'DIALOG' }),
    );
  });
});

describe('ST03N collector — transactionProfile (18 source fields)', () => {
  test('every numeric field is exposed per transaction', () => {
    for (const suffix of Object.values(SCHEMA.transactionProfile.fields)) {
      expect(all(suffix).length).toBe(RAW.transactionProfile.length);
    }
  });

  test('long transaction names survive as label values', () => {
    const row = RAW.transactionProfile[0];
    expect(row.reportOrTransactionName).toBe('CL_BGRFC_SUPERVISOR_START=====CP');
    expect(pick('transaction_avg_response_time_ms', { transaction: row.reportOrTransactionName })).toBe(
      60043.5,
    );
  });

  test('background job is part of the transaction identity (99 records stay distinct)', () => {
    const names = new Set(RAW.transactionProfile.map((r) => r.reportOrTransactionName));
    expect(names.size).toBe(68); // one report name can repeat across jobs
    const keys = new Set(
      all('transaction_avg_response_time_ms').map((m) => `${m.labels.transaction}|${m.labels.background_job}`),
    );
    expect(keys.size).toBe(99);
    expect(pick('transaction_dialog_steps', { transaction: 'SE24', background_job: '' })).toBe(405);
  });

  test('values equal the source values (SE24 row)', () => {
    const row = RAW.transactionProfile.find((r) => r.reportOrTransactionName === 'SE24');
    expect(row).toBeDefined();
    for (const [field, suffix] of Object.entries(SCHEMA.transactionProfile.fields)) {
      const labels = { transaction: 'SE24' };
      if (suffix === 'transaction_requested_data_kb') {
        // requestedDataKb is a float in the source; keep precision.
        expect(pick(suffix, labels)).toBeCloseTo(Number(row[field]), 6);
      } else {
        expect(pick(suffix, labels)).toBeCloseTo(Number(row[field]), 6);
      }
    }
  });

  test('totals over the whole section match independently computed sums', () => {
    expect(all('transaction_dialog_steps').reduce((t, m) => t + m.value, 0)).toBe(
      sourceSum('transactionProfile', 'numberOfDialogSteps'),
    );
    expect(all('transaction_total_response_time_s').reduce((t, m) => t + m.value, 0)).toBeCloseTo(
      sourceSum('transactionProfile', 'totalResponseTimeS'),
      3,
    );
  });
});

describe('ST03N collector — timeProfile', () => {
  test('every numeric field is exposed per interval', () => {
    for (const suffix of Object.values(SCHEMA.timeProfile.fields)) {
      expect(all(suffix).length).toBe(RAW.timeProfile.length);
    }
  });

  test('interval values and label values match the source', () => {
    const row = RAW.timeProfile[0];
    expect(row.timeInterval).toBe('12--13');
    expect(pick('timeprofile_dialog_steps', { time_interval: '12--13' })).toBe(row.numberOfDialogSteps);
    expect(pick('timeprofile_avg_roll_wait_time_ms', { time_interval: '12--13' })).toBe(
      row.avgRollWaitTimeMs,
    );
    expect(pick('timeprofile_avg_gui_time_ms', { time_interval: '12--13' })).toBe(row.avgGuiTimeMs);
  });

  test('roll_wait_ms legacy alias is available from this section', () => {
    expect(all('roll_wait_ms').length).toBe(RAW.timeProfile.length);
    expect(pick('roll_wait_ms', { time_interval: '12--13' })).toBe(209.5);
  });
});

describe('ST03N collector — top-N sections', () => {
  test('topResponseTime: all 14 metrics per record with wpid/task_type/account/tcode labels', () => {
    const row = RAW.topResponseTime[0];
    for (const suffix of Object.values(SCHEMA.topResponseTime.fields)) {
      expect(all(suffix).length).toBe(RAW.topResponseTime.length);
    }
    const labels = { wpid: row.wpid, account: row.account, tcode: row.tcode };
    expect(pick('top_response_time_ms', labels)).toBe(row.respti);
    expect(pick('top_response_db_sql_count', labels)).toBe(row.dsqlcnt);
    expect(pick('top_response_used_bytes', labels)).toBe(row.usedbytes);
    expect(pick('top_response_gui_net_time_ms', labels)).toBe(row.guinettime);
    expect(pick('top_response_roll_out_count', labels)).toBe(row.rolloutcnt);
  });

  test('topDbAccesses: btcjobname is exposed, not dropped', () => {
    const row = RAW.topDbAccesses[0];
    for (const suffix of Object.values(SCHEMA.topDbAccesses.fields)) {
      expect(all(suffix).length).toBe(RAW.topDbAccesses.length);
    }
    const hit = find('top_db_sql_count', { wpid: row.wpid, background_job: row.btcjobname });
    expect(hit).toBeDefined();
    expect(hit.value).toBe(row.dsqlcnt);
    expect(hit.labels.task_type).toBe(row.tasktype);
    const jobs = new Set(all('top_db_sql_count').map((m) => m.labels.background_job));
    expect(jobs.has('SAP_REORG_JOBS')).toBe(true);
  });

  test('topResponseTime and topDbAccesses stay separate metric families', () => {
    expect(all('top_response_time_ms').length).toBe(40);
    expect(all('top_db_response_time_ms').length).toBe(40);
    expect(all('top_response_roll_in_count').reduce((t, m) => t + m.value, 0)).toBe(
      sourceSum('topResponseTime', 'rollinti'),
    );
  });
});

describe('ST03N collector — RFC sections', () => {
  test.each([
    ['rfcClientProfile', 'rfc_client_calls'],
    ['rfcClientDestProfile', 'rfc_client_dest_calls'],
    ['rfcServerProfile', 'rfc_server_calls'],
    ['rfcServerDestProfile', 'rfc_server_dest_calls'],
  ])('%s keeps its own schema', (section, callsMetric) => {
    const spec = SCHEMA[section];
    for (const suffix of Object.values(spec.fields)) {
      expect(all(suffix).length).toBe(RAW[section].length);
    }
    expect(all(callsMetric).length).toBe(RAW[section].length);
  });

  test('client and server call counts are not merged', () => {
    expect(all('rfc_client_calls').reduce((t, m) => t + m.value, 0)).toBe(
      sourceSum('rfcClientProfile', 'numberOfCalls'),
    );
    expect(all('rfc_server_calls').reduce((t, m) => t + m.value, 0)).toBe(
      sourceSum('rfcServerProfile', 'numberOfRfcCalls'),
    );
    expect(sourceSum('rfcClientProfile', 'numberOfCalls')).not.toBe(
      sourceSum('rfcServerProfile', 'numberOfRfcCalls'),
    );
  });

  test('function modules are the RFC dimension and values match the source', () => {
    const row = RAW.rfcClientProfile[0];
    expect(pick('rfc_client_calls', { function_module: row.functionModule })).toBe(row.numberOfCalls);
    const server = RAW.rfcServerProfile[0];
    expect(pick('rfc_server_avg_time_ms', { function_module: server.functionModule })).toBe(
      server.avgTimePerRfc,
    );
  });
});

describe('ST03N collector — user / settlement / frontend / memory / earlywatch', () => {
  test('userProfile: all 11 metrics per user, exact values', () => {
    const row = RAW.userProfile[0];
    for (const suffix of Object.values(SCHEMA.userProfile.fields)) {
      expect(all(suffix).length).toBe(RAW.userProfile.length);
    }
    expect(pick('user_steps', { user: 'SAPSYS' })).toBe(row.numberOfSteps);
    expect(pick('user_avg_response_time_ms', { user: 'SAPSYS' })).toBe(row.avgResponseTimeMs);
    expect(pick('user_avg_gui_time_ms', { user: 'SAPSYS' })).toBe(row.avgGuiTimeMs);
    expect(new Set(all('user_steps').map((m) => m.labels.user)).size).toBe(RAW.userProfile.length);
  });

  test('settlementStatistics: 11 fields per client, client is the dimension', () => {
    const row = RAW.settlementStatistics[1];
    for (const suffix of Object.values(SCHEMA.settlementStatistics.fields)) {
      expect(all(suffix).length).toBe(RAW.settlementStatistics.length);
    }
    expect(pick('settlement_steps', { client: row.client })).toBe(row.numberOfSteps);
    expect(pick('settlement_background_steps', { client: row.client })).toBe(row.numberOfBackgroundSteps);
    expect(pick('settlement_roll_wait_time_s', { client: '811' })).toBe(782);
  });

  test('frontendStatistics: 12 fields per frontend, frontend_name + instance labels', () => {
    const row = RAW.frontendStatistics[1];
    for (const suffix of Object.values(SCHEMA.frontendStatistics.fields)) {
      expect(all(suffix).length).toBe(RAW.frontendStatistics.length);
    }
    expect(pick('frontend_steps', { frontend_name: row.frontendName })).toBe(row.numberOfSteps);
    expect(pick('frontend_input_kb', { frontend_name: row.frontendName })).toBeCloseTo(row.inputKb, 6);
    const instances = new Set(all('frontend_steps').map((m) => m.labels.instance));
    expect(instances.has('SAPIDES_JCI_00')).toBe(true);
  });

  test('memoryUseStatistics is dialog-step weighted with a max, no report-name labels', () => {
    const rows = RAW.memoryUseStatistics;
    expect(all('memory_dialog_steps').reduce((t, m) => t + m.value, 0)).toBe(
      sourceSum('memoryUseStatistics', 'numOfDialogSteps'),
    );
    expect(pick('memory_wp_reservations')).toBe(
      sourceSum('memoryUseStatistics', 'numOfWpReservations'),
    );
    expect(pick('memory_wp_restarts')).toBe(0); // real zeros in the source
    expect(pick('memory_avg_total_usage_kb')).toBeCloseTo(
      sourceWeightedAvg('memoryUseStatistics', 'avgTotalMemoryUsageKb', 'numOfDialogSteps'),
      3,
    );
    expect(pick('memory_avg_extended_memory_kb')).toBeCloseTo(
      sourceWeightedAvg('memoryUseStatistics', 'avgUsageExtendedMemoryKb', 'numOfDialogSteps'),
      3,
    );
    expect(pick('memory_max_extended_memory_kb')).toBe(
      Math.max(...rows.map((r) => r.maxUsageExtendedMemoryKb)),
    );
    expect(all('memory_avg_total_usage_kb').length).toBe(1);
  });

  test('earlywatchProfile aggregates with dialog-step weighting and keeps its totals', () => {
    const rows = RAW.earlywatchProfile;
    expect(all('earlywatch_steps').reduce((t, m) => t + m.value, 0)).toBe(
      sourceSum('earlywatchProfile', 'numberOfSteps'),
    );
    expect(pick('earlywatch_total_response_time_s')).toBeCloseTo(
      sourceSum('earlywatchProfile', 'totalResponseTimeS'),
      3,
    );
    expect(pick('earlywatch_avg_response_time_ms')).toBeCloseTo(
      sourceWeightedAvg('earlywatchProfile', 'avgResponseTimeMs', 'numberOfSteps'),
      3,
    );
    expect(pick('earlywatch_requested_data_kb')).toBeCloseTo(
      sourceSum('earlywatchProfile', 'requestedDataKb'),
      3,
    );
    // Aggregated: one series per metric, and no report names leaking into labels.
    for (const m of all('earlywatch_avg_response_time_ms')) {
      expect(m.labels.transaction).toBeUndefined();
      expect(m.labels.report).toBeUndefined();
    }
    expect(all('earlywatch_avg_response_time_ms').length).toBe(1);
    expect(rows.length).toBe(68);
  });
});

describe('ST03N collector — metric hygiene', () => {
  test('all metric names are valid Prometheus names and use the sap_st03n prefix', () => {
    for (const m of METRICS) {
      expect(m.fullName).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/);
      expect(m.fullName.startsWith('sap_st03n_')).toBe(true);
    }
  });

  test('every value is a finite number (no NaN / Infinity leakage)', () => {
    for (const m of METRICS) {
      expect(Number.isFinite(m.value)).toBe(true);
    }
  });

  test('label values are strings and label sets stay bounded by the source section', () => {
    for (const m of METRICS) {
      for (const [, value] of Object.entries(m.labels)) expect(typeof value).toBe('string');
    }
    // Bounded dimensions only: no per-report labels on the 68/99-record sections.
    for (const m of METRICS) {
      if (m.fullName.startsWith('sap_st03n_earlywatch_') || m.fullName.startsWith('sap_st03n_memory_')) {
        expect(Object.keys(m.labels).sort()).toEqual(['client', 'system']);
      }
    }
  });

  test('every record keeps a distinct label set (no series collapsed in the registry)', () => {
    const byFamily = new Map();
    for (const m of METRICS) {
      if (!byFamily.has(m.fullName)) byFamily.set(m.fullName, new Set());
      byFamily.get(m.fullName).add(JSON.stringify(m.labels));
    }
    const families = [
      ['sap_st03n_workload_dialog_steps', 17],
      ['sap_st03n_transaction_avg_response_time_ms', 99],
      ['sap_st03n_timeprofile_avg_response_time_ms', 8],
      ['sap_st03n_top_response_time_ms', 40],
      ['sap_st03n_top_db_sql_count', 40],
      ['sap_st03n_rfc_client_calls', 26],
      ['sap_st03n_rfc_client_dest_calls', 12],
      ['sap_st03n_rfc_server_calls', 33],
      ['sap_st03n_rfc_server_dest_calls', 21],
      ['sap_st03n_user_steps', 13],
      ['sap_st03n_settlement_steps', 4],
      ['sap_st03n_frontend_steps', 6],
    ];
    for (const [family, expected] of families) {
      expect([family, byFamily.get(family).size]).toEqual([family, expected]);
    }
  });
});

describe('ST03N collector — robustness', () => {
  /** Helpers over an ad-hoc parsed payload (not the shared fixture). */
  function parsePayload(payload) {
    const { metrics, parseError } = parseToMetrics(JSON.stringify(payload), 'ST03N', 'sap');
    const at = (name) => metrics.filter((m) => m.fullName === `sap_st03n_${name}`);
    return {
      metrics,
      parseError,
      at,
      value: (name, labels = {}) =>
        at(name).find((m) => Object.entries(labels).every(([k, v]) => m.labels[k] === v))?.value,
      recordCount: (section) => at('records').find((m) => m.labels.section === section)?.value,
    };
  }

  test('numeric strings, missing sections and snake_case keys do not throw', () => {
    const p = parsePayload({
      monitor_type: 'ST03N',
      system: 'JCI',
      client: '811',
      period_type: 'D',
      period_start: '20260915',
      workload_overview: [
        { taskTypeName: 'DIALOG', numberOfDialogSteps: '823', avgResponseTimeMs: '6846.5' },
        { taskTypeName: 'RFC', numberOfDialogSteps: null },
      ],
      transaction_profile: 'not-an-array',
    });
    expect(p.parseError).toBeNull();
    expect(p.value('workload_dialog_steps', { task_type: 'DIALOG' })).toBe(823);
    expect(p.value('workload_avg_response_time_ms', { task_type: 'DIALOG' })).toBe(6846.5);
    // Missing fields are skipped, not emitted as NaN, and the row still counts.
    expect(p.at('workload_avg_response_time_ms').length).toBe(1);
    expect(p.recordCount('workloadOverview')).toBe(2);
    expect(p.recordCount('transactionProfile')).toBe(0);
    expect(p.recordCount('timeProfileTotal')).toBe(0);
  });

  test('an empty / section-less payload yields the section counts only', () => {
    const p = parsePayload({ monitor_type: 'ST03N' });
    expect(p.parseError).toBeNull();
    expect(p.at('records').length).toBe(15);
    expect(p.metrics.filter((m) => m.value !== 0).map((m) => m.fullName)).toEqual([
      'sap_st03n_snapshot_info',
    ]);
  });

  test('a non-object payload returns no metrics instead of throwing', () => {
    const { metrics, parseError } = parseToMetrics('[1,2,3]', 'ST03N', 'sap');
    expect(parseError).toBeNull();
    expect(metrics).toEqual([]);
  });

  test('a truncated / malformed body reports a parse error rather than throwing', () => {
    const { metrics, parseError } = parseToMetrics('{"monitor_type":"ST03N",', 'ST03N', 'sap');
    expect(metrics).toEqual([]);
    expect(parseError).toBeInstanceOf(Error);
  });
});
