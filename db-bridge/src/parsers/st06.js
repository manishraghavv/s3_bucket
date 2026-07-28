'use strict';
/**
 * ST06 Parser - System Performance
 * Expected JSON:
 * {
 *   "monitor_type": "ST06",
 *   "timestamp": "2026-07-27T12:00:00Z",
 *   "cpu": { "user": 5.2, "system": 1.1, "idle": 93.7, "wait": 0.0 },
 *   "memory": {
 *     "total_bytes": 137438953472,
 *     "used_bytes": 68719476736,
 *     "free_bytes": 68719476736
 *   },
 *   "swap": {
 *     "total_bytes": 8589934592,
 *     "used_bytes": 1073741824,
 *     "free_bytes": 7516192768
 *   },
 *   "disk": {
 *     "utilization": 45.2,
 *     "queue_length": 0.1,
 *     "response_time": 3.5
 *   },
 *   "paging": { "page_in_rate": 12.5, "page_out_rate": 8.3 },
 *   "network": { "in_bytes": 1048576, "out_bytes": 524288 }
 * }
 * Also handles flat structure from Prometheus exporter with sap_st06_* fields.
 */
async function insertST06(pool, data, tenant, fileTime) {
  const recordTime = data.timestamp ? new Date(data.timestamp) : (fileTime || new Date());
  // Support both nested and flat JSON structures
  const cpu = data.cpu || {};
  const mem = data.memory || {};
  const swap = data.swap || {};
  const disk = data.disk || {};
  const paging = data.paging || {};
  const network = data.network || {};
  const SQL = `INSERT INTO st06_system_perf(
    time,tenant,cpu_user,cpu_system,cpu_idle,cpu_wait,
    memory_used_bytes,memory_free_bytes,memory_total_bytes,
    swap_used_bytes,swap_free_bytes,swap_total_bytes,
    disk_utilization,disk_queue_length,disk_response_time,
    page_in_rate,page_out_rate,network_in_bytes,network_out_bytes
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
  ON CONFLICT DO NOTHING`;
  await pool.query(SQL, [
    recordTime, tenant,
    parseFloat(cpu.user || data.cpu_user || data.USER_CPU || 0),
    parseFloat(cpu.system || data.cpu_system || data.SYS_CPU || 0),
    parseFloat(cpu.idle || data.cpu_idle || data.IDLE_CPU || 0),
    parseFloat(cpu.wait || data.cpu_wait || data.WAIT_CPU || 0),
    BigInt(mem.used_bytes || data.memory_used_bytes || 0),
    BigInt(mem.free_bytes || data.memory_free_bytes || 0),
    BigInt(mem.total_bytes || data.memory_total_bytes || 0),
    BigInt(swap.used_bytes || data.swap_used_bytes || 0),
    BigInt(swap.free_bytes || data.swap_free_bytes || 0),
    BigInt(swap.total_bytes || data.swap_total_bytes || 0),
    parseFloat(disk.utilization || data.disk_utilization || 0),
    parseFloat(disk.queue_length || data.disk_queue_length || 0),
    parseFloat(disk.response_time || data.disk_response_time || 0),
    parseFloat(paging.page_in_rate || data.page_in_rate || 0),
    parseFloat(paging.page_out_rate || data.page_out_rate || 0),
    BigInt(network.in_bytes || data.network_in_bytes || 0),
    BigInt(network.out_bytes || data.network_out_bytes || 0),
  ]);
  return 1;
}
module.exports = { insertST06 };
