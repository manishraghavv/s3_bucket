-- ==========================================
-- SAP Enterprise Monitoring TimescaleDB Schema
-- ==========================================

-- 1. DATABASE SCHEMA & HYPERTABLES

-- AL08: sessions table
CREATE TABLE al08_sessions (
  time TIMESTAMPTZ NOT NULL,
  tenant VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
  client VARCHAR(10),
  user_name VARCHAR(50),
  transaction VARCHAR(20),
  terminal VARCHAR(100),
  login_time TIMESTAMPTZ,
  host VARCHAR(100),
  session_type VARCHAR(20),
  ip_address VARCHAR(45)
);
SELECT create_hypertable('al08_sessions', 'time');

-- SM12: lock entries
CREATE TABLE sm12_locks (
  time TIMESTAMPTZ NOT NULL,
  tenant VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
  client VARCHAR(10),
  table_name VARCHAR(100),
  lock_object VARCHAR(200),
  user_name VARCHAR(50),
  lock_mode VARCHAR(20),
  lock_count INTEGER DEFAULT 1,
  program VARCHAR(100),
  report VARCHAR(100)
);
SELECT create_hypertable('sm12_locks', 'time');

-- SM50: work processes
CREATE TABLE sm50_workprocesses (
  time TIMESTAMPTZ NOT NULL,
  tenant VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
  client VARCHAR(10),
  wp_number INTEGER,
  wp_type VARCHAR(20),
  wp_status VARCHAR(20),
  cpu_time NUMERIC(10,2),
  user_name VARCHAR(50),
  report VARCHAR(100),
  semaphore VARCHAR(50),
  action VARCHAR(100),
  reason VARCHAR(100),
  program VARCHAR(100)
);
SELECT create_hypertable('sm50_workprocesses', 'time');

-- ST06: system performance
CREATE TABLE st06_system_perf (
  time TIMESTAMPTZ NOT NULL,
  tenant VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
  cpu_user NUMERIC(5,2),
  cpu_system NUMERIC(5,2),
  cpu_idle NUMERIC(5,2),
  cpu_wait NUMERIC(5,2),
  memory_used_bytes BIGINT,
  memory_free_bytes BIGINT,
  memory_total_bytes BIGINT,
  swap_used_bytes BIGINT,
  swap_free_bytes BIGINT,
  swap_total_bytes BIGINT,
  disk_utilization NUMERIC(5,2),
  disk_queue_length NUMERIC(10,2),
  disk_response_time NUMERIC(10,2),
  page_in_rate NUMERIC(10,2),
  page_out_rate NUMERIC(10,2),
  network_in_bytes BIGINT,
  network_out_bytes BIGINT
);
SELECT create_hypertable('st06_system_perf', 'time');

-- ST22: ABAP dumps
CREATE TABLE st22_dumps (
  time TIMESTAMPTZ NOT NULL,
  tenant VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
  client VARCHAR(10),
  user_name VARCHAR(50),
  program VARCHAR(100),
  dump_type VARCHAR(100),
  host VARCHAR(100),
  line_number INTEGER,
  severity VARCHAR(20) DEFAULT 'ERROR',
  is_critical BOOLEAN DEFAULT FALSE,
  error_class VARCHAR(100),
  error_text TEXT
);
SELECT create_hypertable('st22_dumps', 'time');


-- INDEXES
CREATE INDEX ix_al08_tenant_time ON al08_sessions (tenant, time DESC);
CREATE INDEX ix_al08_client ON al08_sessions (client, time DESC);
CREATE INDEX ix_al08_user ON al08_sessions (user_name, time DESC);

CREATE INDEX ix_sm12_tenant_time ON sm12_locks (tenant, time DESC);
CREATE INDEX ix_sm12_table ON sm12_locks (table_name, time DESC);
CREATE INDEX ix_sm12_user ON sm12_locks (user_name, time DESC);

CREATE INDEX ix_sm50_tenant_time ON sm50_workprocesses (tenant, time DESC);
CREATE INDEX ix_sm50_wp_status ON sm50_workprocesses (wp_status, time DESC);

CREATE INDEX ix_st06_tenant_time ON st06_system_perf (tenant, time DESC);

CREATE INDEX ix_st22_tenant_time ON st22_dumps (tenant, time DESC);
CREATE INDEX ix_st22_severity ON st22_dumps (severity, time DESC);
CREATE INDEX ix_st22_dump_type ON st22_dumps (dump_type, time DESC);


-- CONTINUOUS AGGREGATES

-- ST06 5-minute aggregate
CREATE MATERIALIZED VIEW st06_system_perf_5min
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('5 minutes', time) AS bucket,
    tenant,
    AVG(cpu_user) AS avg_cpu_user,
    AVG(cpu_system) AS avg_cpu_system,
    AVG(cpu_idle) AS avg_cpu_idle,
    AVG(cpu_wait) AS avg_cpu_wait,
    AVG(memory_used_bytes) AS avg_memory_used,
    AVG(disk_utilization) AS avg_disk_utilization
FROM st06_system_perf
GROUP BY bucket, tenant;

-- AL08 5-minute aggregate
CREATE MATERIALIZED VIEW al08_sessions_5min
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('5 minutes', time) AS bucket,
    tenant,
    COUNT(*) as active_sessions,
    COUNT(DISTINCT client) as active_clients,
    COUNT(DISTINCT user_name) as active_users
FROM al08_sessions
GROUP BY bucket, tenant;

-- ST22 hourly aggregate
CREATE MATERIALIZED VIEW st22_dumps_1hour
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 hour', time) AS bucket,
    tenant,
    COUNT(*) as total_dumps,
    COUNT(*) FILTER (WHERE is_critical) as critical_dumps
FROM st22_dumps
GROUP BY bucket, tenant;


-- 2. VIEWS for Common Queries
CREATE OR REPLACE VIEW vw_sap_system_health AS
SELECT 
  tenant,
  time,
  CASE 
    WHEN (100-cpu_idle) < 70 AND (100.0*memory_used_bytes/NULLIF(memory_total_bytes,0)) < 80 AND disk_utilization < 80 THEN 95
    WHEN (100-cpu_idle) < 85 AND (100.0*memory_used_bytes/NULLIF(memory_total_bytes,0)) < 85 AND disk_utilization < 90 THEN 70
    WHEN (100-cpu_idle) < 95 OR (100.0*memory_used_bytes/NULLIF(memory_total_bytes,0)) < 95 OR disk_utilization < 95 THEN 40
    ELSE 10
  END as health_score,
  (100 - cpu_idle) as cpu_usage_pct,
  (100.0 * memory_used_bytes / NULLIF(memory_total_bytes,0)) as memory_usage_pct,
  disk_utilization as disk_usage_pct
FROM st06_system_perf;


-- 3. SQL QUERIES (Grafana Panel Queries)

/*
--------------------------------------------------
-- AL08 Queries
--------------------------------------------------
-- Panel: Total Logged Users (stat)
SELECT COUNT(*) as value FROM al08_sessions WHERE $__timeFilter(time) AND tenant = '${tenant}';

-- Panel: Users by Client (bar chart)
SELECT client, COUNT(*) as sessions FROM al08_sessions WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY client ORDER BY sessions DESC LIMIT 20;

-- Panel: Users by Transaction (bar chart) 
SELECT transaction, COUNT(*) as count FROM al08_sessions WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY transaction ORDER BY count DESC LIMIT 20;

-- Panel: Users by Terminal (pie chart)
SELECT terminal, COUNT(*) as sessions FROM al08_sessions WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY terminal ORDER BY sessions DESC LIMIT 10;

-- Panel: Active Sessions over time
SELECT time_bucket('5 minutes', time) as time, COUNT(*) as active_sessions FROM al08_sessions WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

-- Panel: AL08 Table
SELECT client, user_name as "User", transaction as "Transaction", terminal as "Terminal", login_time as "Login Time", host as "Host" FROM al08_sessions WHERE $__timeFilter(time) AND tenant = '${tenant}' ORDER BY time DESC LIMIT 500;

--------------------------------------------------
-- SM12 Queries
--------------------------------------------------
-- Panel: Total Locks (stat)
SELECT SUM(lock_count) as value FROM sm12_locks WHERE $__timeFilter(time) AND tenant = '${tenant}';

-- Panel: Locks by User (bar)
SELECT user_name, SUM(lock_count) as locks FROM sm12_locks WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY user_name ORDER BY locks DESC LIMIT 20;

-- Panel: Locks by Table (bar)
SELECT table_name, SUM(lock_count) as locks FROM sm12_locks WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY table_name ORDER BY locks DESC LIMIT 20;

-- Panel: Lock Trend (time series)
SELECT time_bucket('5 minutes', time) as time, SUM(lock_count) as total_locks FROM sm12_locks WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

-- Panel: Lock Table
SELECT table_name as "Table", lock_object as "Lock Object", user_name as "User", client as "Client", lock_mode as "Lock Mode" FROM sm12_locks WHERE $__timeFilter(time) AND tenant = '${tenant}' ORDER BY time DESC LIMIT 500;

--------------------------------------------------
-- SM50 Queries
--------------------------------------------------
-- Total WPs stat
SELECT COUNT(DISTINCT wp_number) as value FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}';

-- Running WPs
SELECT COUNT(DISTINCT wp_number) as value FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' AND wp_status = 'Running';

-- Waiting WPs
SELECT COUNT(DISTINCT wp_number) as value FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' AND wp_status = 'Waiting';

-- Dialog WPs
SELECT COUNT(*) as value FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' AND wp_type = 'DIA' AND time = (SELECT MAX(time) FROM sm50_workprocesses WHERE tenant = '${tenant}');

-- Background WPs
SELECT COUNT(*) as value FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' AND wp_type = 'BTC' AND time = (SELECT MAX(time) FROM sm50_workprocesses WHERE tenant = '${tenant}');

-- WP Status Distribution (pie)
SELECT wp_status, COUNT(*) as count FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY wp_status;

-- WP Type Distribution (pie)
SELECT wp_type, COUNT(*) as count FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY wp_type;

-- CPU Usage trend
SELECT time_bucket('5 minutes', time) as time, AVG(cpu_time) as avg_cpu FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' AND wp_status = 'Running' GROUP BY 1 ORDER BY 1;

-- Top CPU Consumers
SELECT user_name, SUM(cpu_time) as total_cpu FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY user_name ORDER BY total_cpu DESC LIMIT 10;

-- WP Table
SELECT wp_number as "WP#", wp_type as "Type", wp_status as "Status", cpu_time as "CPU", user_name as "User", program as "Program", client as "Client", report as "Report" FROM sm50_workprocesses WHERE $__timeFilter(time) AND tenant = '${tenant}' ORDER BY time DESC LIMIT 500;

--------------------------------------------------
-- ST06 Queries
--------------------------------------------------
-- CPU Usage gauge
SELECT (100 - cpu_idle) as value FROM st06_system_perf WHERE tenant = '${tenant}' ORDER BY time DESC LIMIT 1;

-- CPU Idle gauge
SELECT cpu_idle as value FROM st06_system_perf WHERE tenant = '${tenant}' ORDER BY time DESC LIMIT 1;

-- Memory Usage gauge
SELECT ROUND(100.0 * memory_used_bytes / NULLIF(memory_total_bytes, 0), 2) as value FROM st06_system_perf WHERE tenant = '${tenant}' ORDER BY time DESC LIMIT 1;

-- Disk Usage gauge
SELECT disk_utilization as value FROM st06_system_perf WHERE tenant = '${tenant}' ORDER BY time DESC LIMIT 1;

-- CPU Trend
SELECT time_bucket('5 minutes', time) as time, AVG(100 - cpu_idle) as cpu_usage, AVG(cpu_user) as cpu_user, AVG(cpu_system) as cpu_system, AVG(cpu_wait) as cpu_wait FROM st06_system_perf WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

-- Memory Trend
SELECT time_bucket('5 minutes', time) as time, AVG(memory_used_bytes)/1073741824 as used_gb, AVG(memory_free_bytes)/1073741824 as free_gb FROM st06_system_perf WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

-- Disk Trend
SELECT time_bucket('5 minutes', time) as time, AVG(disk_utilization) as disk_util, AVG(disk_queue_length) as queue_len, AVG(disk_response_time) as response_ms FROM st06_system_perf WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

-- Page In/Out
SELECT time_bucket('5 minutes', time) as time, AVG(page_in_rate) as page_in, AVG(page_out_rate) as page_out FROM st06_system_perf WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

--------------------------------------------------
-- ST22 Queries
--------------------------------------------------
-- Today's Dumps stat
SELECT COUNT(*) as value FROM st22_dumps WHERE time >= date_trunc('day', NOW()) AND tenant = '${tenant}';

-- Critical Dumps stat
SELECT COUNT(*) as value FROM st22_dumps WHERE time >= date_trunc('day', NOW()) AND tenant = '${tenant}' AND is_critical = TRUE;

-- Dump Types (pie)
SELECT dump_type, COUNT(*) as count FROM st22_dumps WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY dump_type ORDER BY count DESC;

-- Top Programs (bar)
SELECT program, COUNT(*) as dumps FROM st22_dumps WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY program ORDER BY dumps DESC LIMIT 10;

-- Top Users (bar)
SELECT user_name, COUNT(*) as dumps FROM st22_dumps WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY user_name ORDER BY dumps DESC LIMIT 10;

-- Dump Timeline
SELECT time_bucket('1 hour', time) as time, COUNT(*) as dump_count, COUNT(*) FILTER (WHERE is_critical) as critical_count FROM st22_dumps WHERE $__timeFilter(time) AND tenant = '${tenant}' GROUP BY 1 ORDER BY 1;

-- Dump Table
SELECT time as "Date/Time", client as "Client", user_name as "User", program as "Program", dump_type as "Dump Type", host as "Host", line_number as "Line#", is_critical as "Critical" FROM st22_dumps WHERE $__timeFilter(time) AND tenant = '${tenant}' ORDER BY time DESC LIMIT 500;

--------------------------------------------------
-- Overview Queries
--------------------------------------------------
-- Health Score (calculated)
SELECT health_score
FROM vw_sap_system_health 
WHERE tenant = '${tenant}' 
ORDER BY time DESC LIMIT 1;
*/

-- 4. SAMPLE INSERT STATEMENTS

INSERT INTO al08_sessions (time, tenant, client, user_name, transaction, terminal, login_time, host, session_type, ip_address) VALUES
(NOW(), 'DEFAULT', '100', 'JSMITH', 'SM50', 'TERM1', NOW() - INTERVAL '1 hour', 'sapapp01', 'GUI', '192.168.1.50'),
(NOW(), 'DEFAULT', '100', 'MDOE', 'SE38', 'TERM2', NOW() - INTERVAL '30 minutes', 'sapapp01', 'GUI', '192.168.1.51'),
(NOW(), 'DEFAULT', '200', 'BUSER', 'RFC', 'RFC_CLIENT', NOW() - INTERVAL '5 minutes', 'sapapp02', 'RFC', '10.0.0.15');

INSERT INTO sm12_locks (time, tenant, client, table_name, lock_object, user_name, lock_mode, lock_count, program, report) VALUES
(NOW(), 'DEFAULT', '100', 'MARA', 'EMARA', 'JSMITH', 'E', 1, 'SAPLMGMM', 'SAPLMGMM'),
(NOW(), 'DEFAULT', '100', 'VBAK', 'EVVBAK', 'MDOE', 'X', 2, 'SAPMV45A', 'SAPMV45A');

INSERT INTO sm50_workprocesses (time, tenant, client, wp_number, wp_type, wp_status, cpu_time, user_name, report, semaphore, action, reason, program) VALUES
(NOW(), 'DEFAULT', '100', 0, 'DIA', 'Running', 15.5, 'JSMITH', 'SAPLMGMM', '', 'Sequential Read', '', 'SAPLMGMM'),
(NOW(), 'DEFAULT', '100', 1, 'DIA', 'Waiting', 0, '', '', '', '', '', ''),
(NOW(), 'DEFAULT', '100', 2, 'BTC', 'Running', 120.3, 'BGD_USER', 'RSBTCP', '', 'Database Update', '', 'RSBTCP');

INSERT INTO st06_system_perf (time, tenant, cpu_user, cpu_system, cpu_idle, cpu_wait, memory_used_bytes, memory_free_bytes, memory_total_bytes, swap_used_bytes, swap_free_bytes, swap_total_bytes, disk_utilization, disk_queue_length, disk_response_time, page_in_rate, page_out_rate, network_in_bytes, network_out_bytes) VALUES
(NOW(), 'DEFAULT', 15.2, 5.1, 78.5, 1.2, 34359738368, 8589934592, 42949672960, 1073741824, 16106127360, 17179869184, 45.5, 0.5, 5.2, 120, 45, 1500000, 2500000);

INSERT INTO st22_dumps (time, tenant, client, user_name, program, dump_type, host, line_number, severity, is_critical, error_class, error_text) VALUES
(NOW(), 'DEFAULT', '100', 'MDOE', 'ZCUSTOM_REP', 'DATA_OFFSET_TOO_LARGE', 'sapapp01', 145, 'ERROR', TRUE, 'CX_SY_DATA_ACCESS', 'Invalid data access offset'),
(NOW() - INTERVAL '2 hours', 'DEFAULT', '200', 'BUSER', 'SAPLRSAN', 'TIME_OUT', 'sapapp02', 889, 'WARNING', FALSE, 'CX_SY_TIME_OUT', 'Maximum runtime exceeded');
