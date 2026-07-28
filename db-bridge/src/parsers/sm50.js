'use strict';
/**
 * SM50 Parser - Work Processes
 * Expected JSON structure:
 * {
 *   "monitor_type": "SM50",
 *   "timestamp": "2026-07-27T12:00:00Z",
 *   "work_processes": [
 *     {
 *       "WP_NUMBER": 0,
 *       "TYPE": "DIA",
 *       "STATUS": "Running",
 *       "CPU": "1.23",
 *       "USER": "SAPUSER",
 *       "CLIENT": "100",
 *       "REPORT": "SAPMV45A",
 *       "PROGRAM": "SAPMV45A",
 *       "ACTION": "Processing",
 *       "REASON": "",
 *       "SEMAPHORE": ""
 *     }
 *   ]
 * }
 */
async function insertSM50(pool, data, tenant, fileTime) {
  const wps = data.work_processes || data.WORK_PROCESSES || data.workProcesses || data.data || [];
  if (!Array.isArray(wps) || wps.length === 0) return 0;
  const recordTime = data.timestamp ? new Date(data.timestamp) : (fileTime || new Date());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const SQL = `INSERT INTO sm50_workprocesses(time,tenant,client,wp_number,wp_type,wp_status,cpu_time,user_name,report,semaphore,action,reason,program)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`;
    let count = 0;
    for (const wp of wps) {
      await client.query(SQL, [
        recordTime, tenant,
        wp.CLIENT || wp.MANDT || '000',
        parseInt(wp.WP_NUMBER || wp.NO || wp.PID || '0', 10),
        wp.TYPE || wp.WP_TYPE || 'DIA',
        wp.STATUS || wp.WP_STATUS || 'Waiting',
        parseFloat(wp.CPU || wp.CPU_TIME || '0'),
        wp.USER || wp.BNAME || '',
        wp.REPORT || null,
        wp.SEMAPHORE || null,
        wp.ACTION || null,
        wp.REASON || null,
        wp.PROGRAM || wp.PROG || null,
      ]);
      count++;
    }
    await client.query('COMMIT');
    return count;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
module.exports = { insertSM50 };
