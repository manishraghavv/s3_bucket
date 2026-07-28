'use strict';
/**
 * AL08 Parser
 * ===========
 * Parses the AL08 JSON payload (logged-on users) and inserts
 * rows into the al08_sessions TimescaleDB hypertable.
 *
 * Expected JSON structure (from SAP ABAP program):
 * {
 *   "monitor_type": "AL08",
 *   "timestamp": "2026-07-27T12:00:00Z",
 *   "sessions": [
 *     {
 *       "CLIENT": "100",
 *       "USER": "MANISHRAGHAV",
 *       "TCODE": "SE38",
 *       "TERMINAL": "LAPTOP01",
 *       "TIME": "120000",
 *       "HOST": "saphost01",
 *       "TYPE": "A",
 *       "IPADDR": "10.0.0.1"
 *     }
 *   ]
 * }
 */

/**
 * Insert AL08 session data into TimescaleDB.
 *
 * @param {import('pg').Pool} pool
 * @param {object} data - Parsed JSON payload
 * @param {string} tenant
 * @param {Date} [fileTime] - LastModified from S3 (used as timestamp if payload has none)
 * @returns {Promise<number>} Number of rows inserted
 */
async function insertAL08(pool, data, tenant, fileTime) {
  const sessions = data.sessions || data.SESSIONS || data.data || [];
  if (!Array.isArray(sessions) || sessions.length === 0) return 0;

  const recordTime = data.timestamp ? new Date(data.timestamp) : (fileTime || new Date());
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const INSERT_SQL = `
      INSERT INTO al08_sessions
        (time, tenant, client, user_name, transaction, terminal, login_time, host, session_type, ip_address)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT DO NOTHING
    `;

    let count = 0;
    for (const session of sessions) {
      const loginTime = parseLoginTime(session.TIME || session.LOGON_TIME);
      await client.query(INSERT_SQL, [
        recordTime,
        tenant,
        session.CLIENT || session.MANDT || '000',
        session.USER || session.BNAME || '',
        session.TCODE || session.TRANSACTION || '',
        session.TERMINAL || session.TERMINAL_ID || '',
        loginTime,
        session.HOST || session.APPLICATION_SERVER || '',
        session.TYPE || session.SESSION_TYPE || 'A',
        session.IPADDR || session.IP_ADDRESS || null,
      ]);
      count++;
    }

    await client.query('COMMIT');
    return count;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Parse SAP time format (HHMMSS or HH:MM:SS) to a Date or null.
 * @param {string|number|undefined} sapTime
 * @returns {Date|null}
 */
function parseLoginTime(sapTime) {
  if (!sapTime) return null;
  const str = String(sapTime).padStart(6, '0');
  const h = str.slice(0, 2);
  const m = str.slice(2, 4);
  const s = str.slice(4, 6);
  const d = new Date();
  d.setHours(parseInt(h, 10), parseInt(m, 10), parseInt(s, 10), 0);
  return d;
}

module.exports = { insertAL08 };
