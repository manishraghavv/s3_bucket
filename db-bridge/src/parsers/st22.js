'use strict';
/**
 * ST22 Parser - ABAP Runtime Errors (Dumps)
 * Expected JSON:
 * {
 *   "monitor_type": "ST22",
 *   "timestamp": "2026-07-27T12:00:00Z",
 *   "dumps": [
 *     {
 *       "DATE": "20260727",
 *       "TIME": "120000",
 *       "USER": "BATCHUSER",
 *       "CLIENT": "100",
 *       "PROGRAM": "SAPMV45A",
 *       "DUMP_TYPE": "RAISE_EXCEPTION",
 *       "HOST": "saphost01",
 *       "LINE": 1234,
 *       "ERROR_CLASS": "CX_SY_ILLEGAL_ARGUMENT",
 *       "ERROR_TEXT": "Value out of range"
 *     }
 *   ]
 * }
 */
const CRITICAL_DUMP_TYPES = new Set([
  'SYSTEM_FAILURE', 'RAISE_EXCEPTION', 'MEMORY_NO_MORE_PAGING',
  'TIME_OUT', 'DBIF_RSQL_INVALID_REQUEST', 'DBIF_REPO_UNKNOWN_EXCEPTION',
  'ABAP_RUNTIME_ERR', 'OBJECTS_OBJREF_NOT_ASSIGNED',
]);
async function insertST22(pool, data, tenant, fileTime) {
  const dumps = data.dumps || data.DUMPS || data.data || [];
  if (!Array.isArray(dumps) || dumps.length === 0) return 0;
  const recordTime = data.timestamp ? new Date(data.timestamp) : (fileTime || new Date());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const SQL = `INSERT INTO st22_dumps(time,tenant,client,user_name,program,dump_type,host,line_number,severity,is_critical,error_class,error_text)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`;
    let count = 0;
    for (const dump of dumps) {
      const dumpType = dump.DUMP_TYPE || dump.EXCEPT_NAME || dump.TYPE || 'UNKNOWN';
      const isCritical = CRITICAL_DUMP_TYPES.has(dumpType) || (dump.SEVERITY || '').toUpperCase() === 'CRITICAL';
      const dumpDate = dump.DATE || dump.DATUM || '';
      const dumpTime = dump.TIME || dump.UZEIT || '';
      let dumpDateTime = recordTime;
      if (dumpDate.length === 8) {
        const y = dumpDate.slice(0,4), mo = dumpDate.slice(4,6), d = dumpDate.slice(6,8);
        const h = dumpTime.slice(0,2)||'00', m = dumpTime.slice(2,4)||'00', s = dumpTime.slice(4,6)||'00';
        dumpDateTime = new Date(`${y}-${mo}-${d}T${h}:${m}:${s}Z`);
      }
      await client.query(SQL, [
        dumpDateTime, tenant,
        dump.CLIENT || dump.MANDT || '000',
        dump.USER || dump.BNAME || '',
        dump.PROGRAM || dump.PROG || '',
        dumpType,
        dump.HOST || dump.SERVER || '',
        parseInt(dump.LINE || dump.LINE_NUM || '0', 10),
        isCritical ? 'CRITICAL' : 'ERROR',
        isCritical,
        dump.ERROR_CLASS || dump.EXCEPT || null,
        dump.ERROR_TEXT || dump.SHORT_TEXT || null,
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
module.exports = { insertST22 };
