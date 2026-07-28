-- =============================================================================
-- SAP Enterprise Monitoring — TimescaleDB Initialization Script
-- 
-- This script runs automatically on first TimescaleDB container startup.
-- It creates all hypertables for SAP monitoring data.
--
-- Tables:
--   al08_sessions      — Logged-on users (AL08)
--   sm12_locks         — Lock entries (SM12)
--   sm50_workprocesses — Work processes (SM50)
--   st06_system_perf   — System performance (ST06)
--   st22_dumps         — ABAP runtime errors (ST22)
-- =============================================================================

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- =============================================================================
-- AL08 — Logged-On Users
-- =============================================================================
CREATE TABLE IF NOT EXISTS al08_sessions (
  time          TIMESTAMPTZ   NOT NULL,
  tenant        VARCHAR(50)   NOT NULL DEFAULT 'DEFAULT',
  client        VARCHAR(10),
  user_name     VARCHAR(50),
  transaction   VARCHAR(20),
  terminal      VARCHAR(100),
  login_time    TIMESTAMPTZ,
  host          VARCHAR(100),
  session_type  VARCHAR(20)   DEFAULT 'A',
  ip_address    VARCHAR(45)
);

SELECT create_hypertable('al08_sessions', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_al08_tenant_time   ON al08_sessions (tenant, time DESC);
CREATE INDEX IF NOT EXISTS idx_al08_user          ON al08_sessions (user_name, time DESC);
CREATE INDEX IF NOT EXISTS idx_al08_client        ON al08_sessions (client, time DESC);
CREATE INDEX IF NOT EXISTS idx_al08_transaction   ON al08_sessions (transaction, time DESC);

-- =============================================================================
-- SM12 — Lock Entries
-- =============================================================================
CREATE TABLE IF NOT EXISTS sm12_locks (
  time          TIMESTAMPTZ   NOT NULL,
  tenant        VARCHAR(50)   NOT NULL DEFAULT 'DEFAULT',
  client        VARCHAR(10),
  table_name    VARCHAR(100),
  lock_object   VARCHAR(200),
  user_name     VARCHAR(50),
  lock_mode     VARCHAR(20),
  lock_count    INTEGER       DEFAULT 1,
  program       VARCHAR(100),
  report        VARCHAR(100)
);

SELECT create_hypertable('sm12_locks', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sm12_tenant_time   ON sm12_locks (tenant, time DESC);
CREATE INDEX IF NOT EXISTS idx_sm12_user          ON sm12_locks (user_name, time DESC);
CREATE INDEX IF NOT EXISTS idx_sm12_table         ON sm12_locks (table_name, time DESC);

-- =============================================================================
-- SM50 — Work Processes
-- =============================================================================
CREATE TABLE IF NOT EXISTS sm50_workprocesses (
  time          TIMESTAMPTZ   NOT NULL,
  tenant        VARCHAR(50)   NOT NULL DEFAULT 'DEFAULT',
  client        VARCHAR(10),
  wp_number     INTEGER,
  wp_type       VARCHAR(20),
  wp_status     VARCHAR(20),
  cpu_time      NUMERIC(10,2),
  user_name     VARCHAR(50),
  report        VARCHAR(100),
  semaphore     VARCHAR(50),
  action        VARCHAR(100),
  reason        VARCHAR(100),
  program       VARCHAR(100)
);

SELECT create_hypertable('sm50_workprocesses', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_sm50_tenant_time   ON sm50_workprocesses (tenant, time DESC);
CREATE INDEX IF NOT EXISTS idx_sm50_status        ON sm50_workprocesses (wp_status, time DESC);
CREATE INDEX IF NOT EXISTS idx_sm50_type          ON sm50_workprocesses (wp_type, time DESC);
CREATE INDEX IF NOT EXISTS idx_sm50_user          ON sm50_workprocesses (user_name, time DESC);

-- =============================================================================
-- ST06 — System Performance (CPU, Memory, Disk, Network)
-- =============================================================================
CREATE TABLE IF NOT EXISTS st06_system_perf (
  time                  TIMESTAMPTZ   NOT NULL,
  tenant                VARCHAR(50)   NOT NULL DEFAULT 'DEFAULT',
  cpu_user              NUMERIC(5,2),
  cpu_system            NUMERIC(5,2),
  cpu_idle              NUMERIC(5,2),
  cpu_wait              NUMERIC(5,2),
  memory_used_bytes     BIGINT,
  memory_free_bytes     BIGINT,
  memory_total_bytes    BIGINT,
  swap_used_bytes       BIGINT,
  swap_free_bytes       BIGINT,
  swap_total_bytes      BIGINT,
  disk_utilization      NUMERIC(5,2),
  disk_queue_length     NUMERIC(10,2),
  disk_response_time    NUMERIC(10,2),
  page_in_rate          NUMERIC(10,2),
  page_out_rate         NUMERIC(10,2),
  network_in_bytes      BIGINT,
  network_out_bytes     BIGINT
);

SELECT create_hypertable('st06_system_perf', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_st06_tenant_time   ON st06_system_perf (tenant, time DESC);

-- =============================================================================
-- ST22 — ABAP Runtime Errors (Dumps)
-- =============================================================================
CREATE TABLE IF NOT EXISTS st22_dumps (
  time          TIMESTAMPTZ   NOT NULL,
  tenant        VARCHAR(50)   NOT NULL DEFAULT 'DEFAULT',
  client        VARCHAR(10),
  user_name     VARCHAR(50),
  program       VARCHAR(100),
  dump_type     VARCHAR(100),
  host          VARCHAR(100),
  line_number   INTEGER,
  severity      VARCHAR(20)   DEFAULT 'ERROR',
  is_critical   BOOLEAN       DEFAULT FALSE,
  error_class   VARCHAR(100),
  error_text    TEXT
);

SELECT create_hypertable('st22_dumps', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_st22_tenant_time   ON st22_dumps (tenant, time DESC);
CREATE INDEX IF NOT EXISTS idx_st22_critical      ON st22_dumps (is_critical, time DESC);
CREATE INDEX IF NOT EXISTS idx_st22_program       ON st22_dumps (program, time DESC);
CREATE INDEX IF NOT EXISTS idx_st22_user          ON st22_dumps (user_name, time DESC);

-- =============================================================================
-- CONTINUOUS AGGREGATES — Pre-aggregate for dashboard performance
-- =============================================================================

-- ST06: 5-minute CPU/Memory averages
CREATE MATERIALIZED VIEW IF NOT EXISTS st06_perf_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', time)              AS bucket,
  tenant,
  AVG(cpu_user)                               AS avg_cpu_user,
  AVG(cpu_system)                             AS avg_cpu_system,
  AVG(cpu_idle)                               AS avg_cpu_idle,
  AVG(cpu_wait)                               AS avg_cpu_wait,
  AVG(100 - cpu_idle)                         AS avg_cpu_usage,
  AVG(memory_used_bytes)                      AS avg_memory_used,
  AVG(memory_free_bytes)                      AS avg_memory_free,
  AVG(memory_total_bytes)                     AS avg_memory_total,
  AVG(disk_utilization)                       AS avg_disk_util,
  AVG(disk_queue_length)                      AS avg_disk_queue,
  AVG(disk_response_time)                     AS avg_disk_response,
  AVG(page_in_rate)                           AS avg_page_in,
  AVG(page_out_rate)                          AS avg_page_out
FROM st06_system_perf
GROUP BY bucket, tenant
WITH NO DATA;

SELECT add_continuous_aggregate_policy('st06_perf_5m',
  start_offset => INTERVAL '1 day',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);

-- AL08: 5-minute session counts
CREATE MATERIALIZED VIEW IF NOT EXISTS al08_sessions_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', time) AS bucket,
  tenant,
  COUNT(*)                       AS session_count,
  COUNT(DISTINCT user_name)      AS unique_users,
  COUNT(DISTINCT client)         AS unique_clients,
  COUNT(DISTINCT transaction)    AS unique_transactions
FROM al08_sessions
GROUP BY bucket, tenant
WITH NO DATA;

SELECT add_continuous_aggregate_policy('al08_sessions_5m',
  start_offset => INTERVAL '1 day',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);

-- ST22: Hourly dump aggregates
CREATE MATERIALIZED VIEW IF NOT EXISTS st22_dumps_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time)                       AS bucket,
  tenant,
  COUNT(*)                                          AS total_dumps,
  COUNT(*) FILTER (WHERE is_critical)               AS critical_dumps,
  COUNT(DISTINCT program)                           AS unique_programs,
  COUNT(DISTINCT user_name)                         AS unique_users
FROM st22_dumps
GROUP BY bucket, tenant
WITH NO DATA;

SELECT add_continuous_aggregate_policy('st22_dumps_1h',
  start_offset => INTERVAL '7 days',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- =============================================================================
-- VIEWS — Convenience views for Grafana panels
-- =============================================================================

CREATE OR REPLACE VIEW vw_sap_system_health AS
WITH latest AS (
  SELECT
    tenant,
    (100 - cpu_idle)                                          AS cpu_pct,
    (100.0 * memory_used_bytes / NULLIF(memory_total_bytes, 0)) AS mem_pct,
    disk_utilization                                          AS disk_pct,
    ROW_NUMBER() OVER (PARTITION BY tenant ORDER BY time DESC) AS rn
  FROM st06_system_perf
),
dumps_today AS (
  SELECT tenant, COUNT(*) AS dump_count
  FROM st22_dumps
  WHERE time >= date_trunc('day', NOW())
  GROUP BY tenant
),
locks_now AS (
  SELECT tenant, COALESCE(SUM(lock_count), 0) AS lock_count
  FROM sm12_locks
  WHERE time > NOW() - INTERVAL '5 minutes'
  GROUP BY tenant
)
SELECT
  l.tenant,
  ROUND(l.cpu_pct, 2)                                                  AS cpu_usage_pct,
  ROUND(l.mem_pct, 2)                                                  AS memory_usage_pct,
  ROUND(l.disk_pct, 2)                                                 AS disk_usage_pct,
  COALESCE(d.dump_count, 0)                                            AS dumps_today,
  COALESCE(k.lock_count, 0)                                            AS current_locks,
  CASE
    WHEN l.cpu_pct > 90 OR l.mem_pct > 90 OR l.disk_pct > 90        THEN 'CRITICAL'
    WHEN l.cpu_pct > 75 OR l.mem_pct > 80 OR l.disk_pct > 80        THEN 'WARNING'
    WHEN COALESCE(d.dump_count, 0) > 5 OR COALESCE(k.lock_count, 0) > 50 THEN 'WARNING'
    ELSE 'HEALTHY'
  END                                                                  AS health_status,
  CASE
    WHEN l.cpu_pct > 90 OR l.mem_pct > 90 OR l.disk_pct > 90        THEN 10
    WHEN l.cpu_pct > 75 OR l.mem_pct > 80 OR l.disk_pct > 80        THEN 50
    WHEN COALESCE(d.dump_count, 0) > 5 OR COALESCE(k.lock_count, 0) > 50 THEN 70
    ELSE 95
  END                                                                  AS health_score
FROM latest l
LEFT JOIN dumps_today d ON d.tenant = l.tenant
LEFT JOIN locks_now   k ON k.tenant = l.tenant
WHERE l.rn = 1;

-- =============================================================================
-- RETENTION POLICIES — Auto-delete old data
-- =============================================================================

SELECT add_retention_policy('al08_sessions',         INTERVAL '90 days',  if_not_exists => TRUE);
SELECT add_retention_policy('sm12_locks',            INTERVAL '90 days',  if_not_exists => TRUE);
SELECT add_retention_policy('sm50_workprocesses',    INTERVAL '90 days',  if_not_exists => TRUE);
SELECT add_retention_policy('st06_system_perf',      INTERVAL '365 days', if_not_exists => TRUE);
SELECT add_retention_policy('st22_dumps',            INTERVAL '365 days', if_not_exists => TRUE);

-- =============================================================================
-- SAMPLE DATA — For dashboard testing
-- =============================================================================

-- ST06 sample data (last 2 hours, every 5 minutes)
INSERT INTO st06_system_perf (time, tenant, cpu_user, cpu_system, cpu_idle, cpu_wait,
  memory_used_bytes, memory_free_bytes, memory_total_bytes,
  swap_used_bytes, swap_free_bytes, swap_total_bytes,
  disk_utilization, disk_queue_length, disk_response_time,
  page_in_rate, page_out_rate, network_in_bytes, network_out_bytes)
SELECT
  NOW() - (generate_series(0, 24) * INTERVAL '5 minutes') AS time,
  'DEFAULT'                                               AS tenant,
  (5 + random() * 20)::NUMERIC(5,2)                      AS cpu_user,
  (1 + random() * 5)::NUMERIC(5,2)                       AS cpu_system,
  (70 + random() * 25)::NUMERIC(5,2)                     AS cpu_idle,
  (random() * 3)::NUMERIC(5,2)                           AS cpu_wait,
  (68719476736 + (random() * 10737418240)::BIGINT)       AS memory_used_bytes,
  (68719476736 - (random() * 10737418240)::BIGINT)       AS memory_free_bytes,
  137438953472                                            AS memory_total_bytes,
  1073741824                                              AS swap_used_bytes,
  7516192768                                             AS swap_free_bytes,
  8589934592                                             AS swap_total_bytes,
  (40 + random() * 30)::NUMERIC(5,2)                    AS disk_utilization,
  (random() * 2)::NUMERIC(10,2)                         AS disk_queue_length,
  (2 + random() * 8)::NUMERIC(10,2)                    AS disk_response_time,
  (random() * 100)::NUMERIC(10,2)                      AS page_in_rate,
  (random() * 50)::NUMERIC(10,2)                       AS page_out_rate,
  (1048576 + (random() * 10485760)::BIGINT)            AS network_in_bytes,
  (524288 + (random() * 5242880)::BIGINT)              AS network_out_bytes;

-- AL08 sample sessions
INSERT INTO al08_sessions (time, tenant, client, user_name, transaction, terminal, login_time, host, session_type, ip_address)
VALUES
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '100', 'MANISHRAGHAV',  'SE38', 'LAPTOP-MR',   NOW() - INTERVAL '2 hours', 'saphost01', 'A', '10.0.0.10'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '100', 'SAPUSER01',     'VA01', 'WORKST-01',   NOW() - INTERVAL '1 hour',  'saphost01', 'A', '10.0.0.11'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '100', 'BATCHUSER',     'SM37', 'saphost02',   NOW() - INTERVAL '3 hours', 'saphost02', 'B', '10.0.0.20'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '200', 'DEVELOPER01',   'SE80', 'DEV-WS-01',   NOW() - INTERVAL '30 mins', 'saphost01', 'A', '10.0.0.30'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '200', 'FIUSER01',      'FB50', 'FIWS-01',     NOW() - INTERVAL '1 hour',  'saphost03', 'A', '10.0.0.40'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '100', 'MMUSER01',      'ME21N','MMWS-01',     NOW() - INTERVAL '45 mins', 'saphost01', 'A', '10.0.0.50'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '300', 'SDUSER01',      'VA03', 'SDWS-01',     NOW() - INTERVAL '2 hours', 'saphost04', 'A', '10.0.0.60'),
  (NOW() - INTERVAL '5 minutes', 'DEFAULT', '100', 'ADMIN',         'SM50', 'ADMINWS',     NOW() - INTERVAL '10 mins', 'saphost01', 'A', '10.0.0.1');

-- SM12 sample locks
INSERT INTO sm12_locks (time, tenant, client, table_name, lock_object, user_name, lock_mode, lock_count, program, report)
VALUES
  (NOW(), 'DEFAULT', '100', 'MARA', 'ENMARA',     'SAPUSER01', 'E', 1, 'SAPMM06E', 'MM06EFB0'),
  (NOW(), 'DEFAULT', '100', 'EKKO', 'ENEKKO',     'BATCHUSER', 'E', 3, 'SAPMM06E', 'MM06EFB0'),
  (NOW(), 'DEFAULT', '200', 'VBAK', 'ENVBAK',     'SDUSER01',  'E', 1, 'SAPMV45A', 'SAPMV45A'),
  (NOW(), 'DEFAULT', '100', 'BKPF', 'ENBKPF',     'FIUSER01',  'E', 2, 'SAPFBL3N', 'RFITEMAP'),
  (NOW(), 'DEFAULT', '100', 'KNA1', 'ENKNA1',     'MMUSER01',  'S', 1, 'SAPMF02D', 'SAPMF02D');

-- SM50 sample work processes
INSERT INTO sm50_workprocesses (time, tenant, client, wp_number, wp_type, wp_status, cpu_time, user_name, program, report)
VALUES
  (NOW(), 'DEFAULT', '100', 0,  'DIA', 'Running', 2.45,  'SAPUSER01',  'SAPMV45A', 'VA01'),
  (NOW(), 'DEFAULT', '100', 1,  'DIA', 'Running', 8.12,  'MANISHRAGHAV','RSDBRUNT', 'SE38'),
  (NOW(), 'DEFAULT', '100', 2,  'DIA', 'Waiting', 0.00,  '',           '',         ''),
  (NOW(), 'DEFAULT', '100', 3,  'DIA', 'Waiting', 0.00,  '',           '',         ''),
  (NOW(), 'DEFAULT', '100', 4,  'BTC', 'Running', 45.23, 'BATCHUSER',  'RSUSR006', 'SM37'),
  (NOW(), 'DEFAULT', '100', 5,  'BTC', 'Running', 12.87, 'BATCHUSER',  'SAPMSSY1', 'SM37'),
  (NOW(), 'DEFAULT', '100', 6,  'BTC', 'Waiting', 0.00,  '',           '',         ''),
  (NOW(), 'DEFAULT', '100', 7,  'UPD', 'Waiting', 0.00,  '',           '',         ''),
  (NOW(), 'DEFAULT', '100', 8,  'SPO', 'Waiting', 0.00,  '',           '',         ''),
  (NOW(), 'DEFAULT', '200', 9,  'DIA', 'Running', 1.20,  'DEVELOPER01','SAPLCLBF', 'SE80'),
  (NOW(), 'DEFAULT', '200', 10, 'DIA', 'Running', 3.45,  'FIUSER01',   'SAPLFBL3', 'FB50');

-- ST22 sample dumps
INSERT INTO st22_dumps (time, tenant, client, user_name, program, dump_type, host, line_number, severity, is_critical, error_class, error_text)
VALUES
  (NOW() - INTERVAL '2 hours', 'DEFAULT', '100', 'SAPUSER01',   'SAPMV45A',  'RAISE_EXCEPTION',           'saphost01', 1234, 'CRITICAL', TRUE,  'CX_SY_ILLEGAL_ARGUMENT', 'Value out of valid range'),
  (NOW() - INTERVAL '4 hours', 'DEFAULT', '100', 'BATCHUSER',   'RSUSR006',  'TIME_OUT',                  'saphost02', 567,  'CRITICAL', TRUE,  'CX_SY_TIMEOUT',          'Report exceeded maximum runtime'),
  (NOW() - INTERVAL '1 day',   'DEFAULT', '200', 'DEVELOPER01', 'ZSAPTEST',  'OBJECTS_OBJREF_NOT_ASSIGNED','saphost01', 89,   'ERROR',    FALSE, 'CX_SY_REF_IS_INITIAL',   'NULL reference dereferenced'),
  (NOW() - INTERVAL '6 hours', 'DEFAULT', '100', 'MMUSER01',    'SAPMM06E',  'DBIF_RSQL_INVALID_REQUEST', 'saphost01', 2345, 'CRITICAL', TRUE,  'CX_SY_OPEN_SQL_DB',      'Database error in OPEN SQL'),
  (NOW() - INTERVAL '3 hours', 'DEFAULT', '300', 'SDUSER01',    'SAPMV45A',  'CONVT_NO_NUMBER',           'saphost04', 456,  'ERROR',    FALSE, '',                       'Cannot convert string to number');

\echo 'SAP Enterprise Monitoring — TimescaleDB initialized successfully!'
