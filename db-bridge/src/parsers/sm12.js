'use strict';
/**
 * SM12 Parser - Lock Entries
 * Expected JSON structure:
 * {
 *   "monitor_type": "SM12",
 *   "timestamp": "2026-07-27T12:00:00Z",
 *   "locks": [
 *     {
 *       "TABLE_NAME": "MARA",
 *       "LOCK_OBJECT": "ENMARA",
 *       "USER": "BATCHUSER",
 *       "CLIENT": "100",
 *       "LOCK_MODE": "E",
 *       "PROGRAM": "SAPMM06E",
 *       "REPORT": "MM06EFB0"
 *     }
 *   ]
 * }
 */
async function insertSM12(pool, data, tenant, fileTime) {
  const locks = data.locks || data.LOCKS || data.data || [];
  if (!Array.isArray(locks) || locks.length === 0) return 0;
  const recordTime = data.timestamp ? new Date(data.timestamp) : (fileTime || new Date());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const SQL = `INSERT INTO sm12_locks(time,tenant,client,table_name,lock_object,user_name,lock_mode,lock_count,program,report)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`;
    let count = 0;
    for (const lock of locks) {
      await client.query(SQL, [
        recordTime, tenant,
        lock.CLIENT || lock.MANDT || '000',
        lock.TABLE_NAME || lock.TABNAME || '',
        lock.LOCK_OBJECT || lock.ENQNAME || '',
        lock.USER || lock.BNAME || '',
        lock.LOCK_MODE || lock.MODE || 'E',
        parseInt(lock.COUNT || lock.LOCK_COUNT || '1', 10),
        lock.PROGRAM || lock.PROG || null,
        lock.REPORT || null,
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
module.exports = { insertSM12 };
