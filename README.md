# SAP Monitoring Platform

Production-ready SAP system monitoring built on **Amazon S3**, **Node.js**, **Prometheus**, and **Grafana**.

```
SAP ABAP
    │
    ▼
Generate JSON files
    │
    ▼
Amazon S3 Bucket
    │
    ▼
Node.js Prometheus Exporter
    │  Reads latest JSON per T-Code
    │  Parses using T-Code-specific collectors
    │  Generates real Prometheus metrics (no fake values)
    ▼
/metrics
    │
    ▼
Prometheus
    │
    ▼
Grafana Dashboard
```

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Supported SAP T-Codes](#supported-sap-t-codes)
- [Prerequisites](#prerequisites)
- [Quick Start (Docker)](#quick-start-docker)
- [Exporter Details](#exporter-details)
- [Supported Metrics](#supported-metrics)
- [Grafana Dashboard](#grafana-dashboard)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

The platform collects SAP system metrics via T-Codes and makes them visible in Grafana:

1. **SAP ABAP** exports T-Code data as JSON files to **Amazon S3**.
   - File naming: `{TCODE}_{ISO_TIMESTAMP}.json` (e.g. `AL08_2026-07-27T06-29-13.json`)
   - Each T-Code has its own JSON schema with specific field names.
   - Multiple files per T-Code may exist; the exporter always processes the **latest** file by `LastModified`.

2. The **Node.js Prometheus Exporter** runs on each Prometheus scrape:
   - Lists all S3 objects
   - Groups files by T-Code
   - Selects only the **latest** file per T-Code
   - Downloads and parses the JSON using **T-Code-specific collectors**
   - Converts data into **meaningful Prometheus Gauge metrics** (no generic walker)
   - Exposes all metrics at the `/metrics` endpoint

3. **Prometheus** scrapes the exporter every 60 seconds.

4. **Grafana** visualises the metrics on auto-provisioned dashboards.

### Key Design Decisions

- ✅ **No generic parser** — Each T-Code has a dedicated collector that knows the exact JSON schema
- ✅ **Real JSON field names** — Parsers use actual field names (e.g. `WP_TYP`, `WP_STATUS`, `syuser`, `USER_ID`)
- ✅ **No fake metrics** — Every metric directly maps to values from the JSON payload
- ✅ **Dynamic labels** — Per-client, per-user, per-table breakdowns from real data
- ✅ **Resilient** — Invalid JSON files are skipped; remaining T-Codes still get processed
- ✅ **No TimescaleDB / DB Bridge** — Exporter is the **sole** source of metrics

---

## Supported T-Codes

| T-Code | Description          | JSON Array Key |
|--------|----------------------|----------------|
| AL08   | User Activity        | `data`, `sessions` |
| SM12   | Lock Management      | `data`, `locks` |
| SM50   | Work Processes       | `data`, `work_processes` |
| ST22   | Runtime Errors       | `data`, `dumps` |
| ST06   | OS & Hardware        | (nested object, no array) |

---

## Prerequisites

- **Node.js** ≥ 18 (for manual deployment)
- **AWS account** with an S3 bucket and IAM credentials
- **Docker & Docker Compose** (for containerized deployment)
- **Prometheus** (included in Docker setup)
- **Grafana** (included in Docker setup)

---

## Quick Start (Docker)

### 1. Clone & Configure

```bash
git clone <repo-url> sap-monitor
cd sap-monitor

# Create environment configuration
cp .env.example .env
```

### 2. Edit `.env`

Set your AWS credentials:

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET_NAME=my-sap-bucket
```

### 3. Start All Services

```bash
docker compose down --remove-orphans
docker compose up --build -d
```

This starts three containers:

| Service        | Internal Port | External Port | URL                          |
|----------------|---------------|---------------|------------------------------|
| SAP Exporter   | 9105          | 9106          | http://localhost:9106/metrics |
| Prometheus     | 9090          | 9090          | http://localhost:9090         |
| Grafana        | 3000          | 3000          | http://localhost:3000         |

### 4. Verify

```bash
# Check exporter health
curl http://localhost:9106/health

# View Prometheus metrics
curl http://localhost:9106/metrics | grep sap_

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets
```

### 5. Open Grafana

1. Browse to **http://localhost:3000**
2. Login: `admin` / `admin` (change in `.env`!)
3. Navigate to **Dashboards → SAP** folder
4. Open **SAP Exporter Overview** or **SAP Monitoring Dashboard**

---

## Supported Metrics

### AL08 — Logged-On Users

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_al08_logged_users` | — | Unique logged-on users |
| `sap_al08_total_sessions` | — | Total active sessions |
| `sap_al08_client_count` | `client` | Sessions per client |
| `sap_al08_tcode_count` | `tcode` | Sessions per transaction |
| `sap_al08_user_count` | `user` | Sessions per user |
| `sap_al08_terminal_count` | `terminal` | Sessions per terminal |
| `sap_al08_host_count` | `host` | Sessions per host (SERVER_NAME) |
| `sap_al08_type_count` | `type` | Sessions per raw TYPE code (e.g. 2, 4, 32) |
| `sap_al08_status_count` | `stat` | Sessions per raw STATUS code |
| `sap_al08_session_info` | `session_id`, `client`, `userid`, `tcode`, `terminal`, `time`, `session`, `type`, `stat`, `server_name` | One series per logged-on session — complete AL08 row with raw source values |

### SM12 — Lock Entries

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_sm12_total_locks` | — | Total lock entries |
| `sap_sm12_unique_users` | — | Unique lock owners (GUNAME) |
| `sap_sm12_locked_tables` | — | Unique locked tables (TABLE) |
| `sap_sm12_exclusive_locks` | — | Exclusive locks (GMODE E/X) |
| `sap_sm12_shared_locks` | — | Shared locks (GMODE S) |
| `sap_sm12_other_locks` | — | Locks in other/unclassified GMODE (e.g. O) |
| `sap_sm12_table_count` | `table` | Locks per table |
| `sap_sm12_user_count` | `user` | Locks per owner user (GUNAME) |
| `sap_sm12_lock_mode_count` | `lock_mode` | Locks per mode |
| `sap_sm12_client_count` | `client` | Locks per client (GCLIENT) |
| `sap_sm12_object_count` | `object` | Locks per lock object (GOBJ) |
| `sap_sm12_host_count` | `host` | Locks per host (GTHOST) |
| `sap_sm12_guse_total` | — | Sum of GUSE numeric column |
| `sap_sm12_gusevb_total` | — | Sum of GUSEVB numeric column |
| `sap_sm12_gtwp_total` | — | Sum of GTWP numeric column |
| `sap_sm12_gtwp_max` | — | Max GTWP value across lock entries |
| `sap_sm12_gtsysnr_total` | — | Sum of GTSYSNR numeric column |
| `sap_sm12_latest_date` | — | Newest GTDATE as numeric YYYYMMDD |
| `sap_sm12_latest_time` | — | Newest GTTIME as numeric HHMMSS |
| `sap_sm12_lock_arg_present` | — | Lock entries with non-empty LOCK_ARG |
| `sap_sm12_lock_arg_distinct` | — | Distinct non-empty LOCK_ARG values |
| `sap_sm12_user_id_present` | — | Lock entries with non-empty USER_ID |
| `sap_sm12_gusr_present` | — | Lock entries with non-empty GUSR |
| `sap_sm12_gusrvb_present` | — | Lock entries with non-empty GUSRVB |
| `sap_sm12_gusrvb_distinct` | — | Distinct non-empty GUSRVB values |
| `sap_sm12_gtmark_present` | — | Lock entries with non-empty GTMARK |

LOCK_ARG / GUSRVB are free-form strings that are effectively unique per lock;
they are counted (presence / distinct) but never used as Prometheus labels.
USER_ID / GUSR / GTMARK are empty in the real payload and are exposed via
presence gauges so no blank-label series is created.

### SM50 — Work Processes

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_sm50_total_wp` | — | Total work processes |
| `sap_sm50_running_wp` | — | Running work processes |
| `sap_sm50_waiting_wp` | — | Waiting work processes |
| `sap_sm50_finished_wp` | — | Finished work processes |
| `sap_sm50_dialog_wp` | — | Dialog (DIA) work processes |
| `sap_sm50_background_wp` | — | Background (BTC) work processes |
| `sap_sm50_update_wp` | — | Update (UPD) work processes |
| `sap_sm50_spool_wp` | — | Spool (SPO) work processes |
| `sap_sm50_enqueue_wp` | — | Enqueue (ENQ) work processes |
| `sap_sm50_stopped_wp` | — | Stopped work processes |
| `sap_sm50_cpu_seconds` | `type` | CPU seconds by WP type |
| `sap_sm50_status_count` | `status` | WPs per status |
| `sap_sm50_type_count` | `type` | WPs per type |
| `sap_sm50_user_count` | `user` | WPs per user |
| `sap_sm50_client_count` | `client` | WPs per client |

### SM13 — Update Requests

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_sm13_total_updates` | — | Total update requests |
| `sap_sm13_pending_updates` | — | Pending update requests |
| `sap_sm13_error_updates` | — | Error update requests |
| `sap_sm13_finished_updates` | — | Finished update requests |
| `sap_sm13_unknown_updates` | — | Update requests with unknown state |
| `sap_sm13_update_state` | `user`, `tcode`, `function` | State code per update request |
| `sap_sm13_update_age_seconds` | `user`, `tcode`, `function` | Age of update request (seconds) |
| `sap_sm13_update_state_count` | `state` | Update requests per state |
| `sap_sm13_user_count` | `user` | Update requests per user |
| `sap_sm13_tcode_count` | `tcode` | Update requests per transaction code |
| `sap_sm13_function_count` | `update_function` | Update requests per function module |
| `sap_sm13_monitor_type_count` | `monitor_type` | Payload monitor type (top-level) |
| `sap_sm13_vbkey_present` | — | Records with a vbkey |
| `sap_sm13_vbkey_distinct` | — | Distinct vbkey values (unique request keys) |
| `sap_sm13_latest_date` | — | Latest update timestamp (YYYYMMDDHHMMSS) |
| `sap_sm13_vbtimoff_total` | — | Sum of vbtimoff values |
| `sap_sm13_vbtimoff_max` | — | Max vbtimoff value |
| `sap_sm13_vbtimoff_min` | — | Min vbtimoff value |
| `sap_sm13_vbrc_total` | — | Sum of vbrc values |
| `sap_sm13_vbrc_max` | — | Max vbrc value |
| `sap_sm13_report_count` | `report` | Update requests per report |
| `sap_sm13_status_count` | `status` | Update requests per status text |
| `sap_sm13_error_class_count` | `error_class` | Update requests per error class |
| `sap_sm13_error_number_count` | `error_number` | Update requests per error number |
| `sap_sm13_error_text_present` | — | Records with non-empty errorText |
| `sap_sm13_error_text_distinct` | — | Distinct non-empty errorText values |

### SP01 — Spool Request Overview

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_sp01_total_requests` | — | Total spool requests |
| `sap_sp01_waiting_requests` | — | Waiting/pending requests |
| `sap_sp01_error_requests` | — | Requests with errors |
| `sap_sp01_completed_requests` | — | Completed requests |
| `sap_sp01_request_count` | `state` | Requests per final state |
| `sap_sp01_active_printers` | — | Active printer destinations |
| `sap_sp01_printer_request_count` | `printer` | Requests per printer |
| `sap_sp01_printer_utilization` | `printer` | Printer utilization % |
| `sap_sp01_unique_owners` | — | Unique request owners |
| `sap_sp01_owner_request_count` | `owner` | Requests per owner |
| `sap_sp01_request_info` | `rqident`, `rqowner`, `rqdest`, `rqcretime`, `rqfinal`, `rqerror` | Per-request detail (kept for Grafana panel 1214) |
| `sap_sp01_monitor_type_count` | `monitor_type` | Payload monitor type (top-level) |
| `sap_sp01_request_id_present` | — | Records with an RQIDENT |
| `sap_sp01_request_id_distinct` | — | Distinct RQIDENT values (no label — high cardinality) |
| `sap_sp01_owner_count` | `owner` | Requests per owner (RQOWNER) |
| `sap_sp01_title_present` | — | Records with non-empty RQTITLE |
| `sap_sp01_title_distinct` | — | Distinct non-empty RQTITLE values |
| `sap_sp01_destination_count` | `destination` | Requests per destination (RQDEST) |
| `sap_sp01_creation_date_present` | — | Records with non-empty RQCDATE |
| `sap_sp01_creation_date_distinct` | — | Distinct non-empty RQCDATE values |
| `sap_sp01_latest_creation_date` | — | Latest creation date (YYYYMMDD) |
| `sap_sp01_latest_creation_time` | — | Latest creation time (HHMMSS) |
| `sap_sp01_final_status_count` | `final_status` | Requests per RQFINAL value |
| `sap_sp01_error_total` | — | Sum of RQERROR values |
| `sap_sp01_error_count` | `error` | Requests per RQERROR value |
| `sap_sp01_rq1name_present` | — | Records with non-empty RQ1NAME |
| `sap_sp01_rq1name_distinct` | — | Distinct non-empty RQ1NAME values |

### SP12 — TemSe Data Administration

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_sp12_monitor_type_count` | `monitor_type` | Payload monitor type (top-level) |
| `sap_sp12_line_count` | — | Total output lines (incl. empty) |
| `sap_sp12_line_present` | — | Non-empty output lines |
| `sap_sp12_line_distinct` | — | Distinct non-empty line texts |
| `sap_sp12_check_type_present` | — | Check-type header line present (TemSe:) |
| `sap_sp12_check_description_present` | — | Check description line present |
| `sap_sp12_latest_check_date` | — | Latest check date (YYYYMMDD) |
| `sap_sp12_latest_check_time` | — | Latest check time (HHMMSS) |
| `sap_sp12_no_data` | — | "No Data" box present (1) / absent (0) |
| `sap_sp12_temse_objects_checked` | — | TemSe objects checked count |
| `sap_sp12_tst01_status` | — | TST01 check status (OK = 1) |

### ST22 — ABAP Runtime Errors

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_st22_total_dumps` | — | Total runtime errors (dumps) |
| `sap_st22_today_dumps` | — | Today's dumps |
| `sap_st22_critical_dumps` | — | Critical dumps |
| `sap_st22_dump_type_count` | `dump_type` | Dumps per type |
| `sap_st22_program_count` | `program` | Dumps per program |
| `sap_st22_user_count` | `user` | Dumps per user |
| `sap_st22_host_count` | `host` | Dumps per host |
| `sap_st22_client_count` | `client` | Dumps per client |
| `sap_st22_error_code_count` | `error_code` | Dumps per error code |
| `sap_st22_monitor_type_count` | `monitor_type` | Payload monitor type (top-level) |
| `sap_st22_latest_date` | — | Latest dump date (YYYYMMDD) |
| `sap_st22_latest_time` | — | Latest dump time (HHMMSS) |
| `sap_st22_dump_id_count` | `dump_id` | Dumps per dump ID |
| `sap_st22_includename_count` | `includename` | Dumps per include name |
| `sap_st22_line_number_total` | — | Sum of linenumber values |
| `sap_st22_line_number_max` | — | Max linenumber value |
| `sap_st22_error_analysis_present` | — | Records with non-empty errorAnalysis |
| `sap_st22_error_analysis_distinct` | — | Distinct non-empty errorAnalysis values |
| `sap_st22_short_text_present` | — | Records with non-empty shortText |
| `sap_st22_short_text_distinct` | — | Distinct non-empty shortText values |
| `sap_st22_include_count` | `include` | Dumps per include |
| `sap_st22_line_no_total` | — | Sum of lineno values |
| `sap_st22_line_no_max` | — | Max lineno value |
| `sap_st22_program_field_count` | `program_field` | Dumps per program field |

### ST06 — System Performance

| Metric | Labels | Description |
|--------|--------|-------------|
| `sap_st06_cpu_user` | `cpu` | CPU user % (avg or per-core) |
| `sap_st06_cpu_system` | `cpu` | CPU system % |
| `sap_st06_cpu_idle` | `cpu` | CPU idle % |
| `sap_st06_cpu_wait` | `cpu` | CPU I/O wait % |
| `sap_st06_memory_used_bytes` | — | Used memory (bytes) |
| `sap_st06_memory_free_bytes` | — | Free memory (bytes) |
| `sap_st06_memory_total_bytes` | — | Total memory (bytes) |
| `sap_st06_memory_usage_pct` | — | Memory usage % |
| `sap_st06_swap_used_bytes` | — | Used swap (bytes) |
| `sap_st06_swap_free_bytes` | — | Free swap (bytes) |
| `sap_st06_swap_total_bytes` | — | Total swap (bytes) |
| `sap_st06_swap_usage_pct` | — | Swap usage % |
| `sap_st06_disk_utilization` | — | Disk utilization % |
| `sap_st06_page_in_rate` | — | Page-in rate |
| `sap_st06_page_out_rate` | — | Page-out rate |
| `sap_st06_network_in_bytes` | — | Network in (bytes) |
| `sap_st06_network_out_bytes` | — | Network out (bytes) |

---

## Grafana Dashboard

Two dashboards are auto-provisioned:

### 1. SAP Exporter Overview
Quick overview with summary stats and key panels per T-Code:
- Exporter health + T-Code summary stats
- AL08: User types, top clients, transactions, hosts
- SM12: Lock mode pie, top tables, users, clients
- SM50: WP status pie, types, CPU seconds, clients
- ST22: Dump types, programs, users, hosts, error codes
- ST06: CPU/memory/disk gauges, paging, network, swap

### 2. SAP Monitoring Dashboard
Full-depth monitoring with trend data:
- Summary row with all key stats
- AL08: User trend time series, clients/transactions/hosts/terminals
- SM12: Lock trend, tables, modes, clients, users
- SM50: WP stats per type, status/type charts, CPU, clients, users
- ST22: Dump trend, programs, types, users, hosts, error codes
- ST06: All system performance gauges and trends

### Panel Types Used
- **Stat** — Key performance indicators with thresholds
- **Gauge** — CPU, memory, disk utilization
- **Time Series** — Trends over time
- **Bar Chart** — Top-N distributions
- **Pie Chart** — Category distributions

---

## S3 File Format

### Naming Convention

```
{TCODE}_{YYYY}-{MM}-{DD}T{HH}-{MM}-{SS}.json
```

Example: `AL08_2026-07-27T06-29-13.json`

### JSON Field Names

Each T-Code uses its own field naming convention. The exporter supports:

| T-Code | Key Fields |
|--------|------------|
| AL08   | `SESSION_ID`, `CLIENT`, `USERID`, `TCODE`, `TERMINAL`, `TIME`, `SESSION`, `TYPE`, `STAT`, `SERVER_NAME` |
| SM12   | `TABLE`, `LOCK_ARG`, `USER_ID`, `GMODE`, `GUSR`, `GUSRVB`, `GUSE`, `GUSEVB`, `GOBJ`, `GCLIENT`, `GUNAME`, `GTHOST`, `GTWP`, `GTSYSNR`, `GTDATE`, `GTTIME`, `GTMARK` |
| SM50   | `WP_TYP`, `WP_STATUS`, `WP_BNAME`, `WP_CPU`, `WP_CLIENT`, `WP_NO`, `WP_REPORT` |
| SM13   | top-level `monitor_type`; per record `vbkey`, `vbusr`, `vbdate`, `vbtimoff`, `vbstate`, `vbrc`, `vbtcode`, `vbreport`, `vbfunc`, `status`, `errorClass`, `errorNumber`, `errorText` |
| SP12   | top-level `monitor_type`; per record `line` (TemSe check report output line) |
| SP01   | top-level `monitor_type`; per record `RQIDENT`, `RQOWNER`, `RQTITLE`, `RQDEST`, `RQCDATE`, `RQCRETIME`, `RQFINAL`, `RQERROR`, `RQ1NAME` |
| ST22   | top-level `monitor_type`; per record `sydate`, `sytime`, `syhost`, `syuser`, `dumpid`, `programname`, `includename`, `linenumber`, `errorAnalysis`, `shortText`, `include`, `lineno`, `program` |
| ST06   | `cpu.{n}.user/system/idle/wait`, `memory.*`, `swap.*`, `disk.*`, `paging.*`, `network.*` |

The exporter also provides uppercase fallbacks for all fields.

---

## Troubleshooting

### Exporter won't start

```bash
# Check logs
docker compose logs sap-exporter

# Verify AWS credentials
docker compose exec sap-exporter node -e "require('./src/config')"
```

### No metrics in Prometheus

```bash
# Check exporter directly
curl http://localhost:9106/metrics | grep sap_

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Verify S3 bucket has JSON files
aws s3 ls s3://your-bucket/
```

### Grafana shows "No data"

1. Verify Prometheus is scraping the exporter (check Prometheus targets UI)
2. Ensure the metrics exist: `curl http://localhost:9106/metrics | grep sap_`
3. Check the Grafana datasource points to `http://prometheus:9090`
4. Verify the dashboard PromQL queries match the actual metric names (see [Supported Metrics](#supported-metrics))

### S3 permission errors

```bash
# Verify credentials using AWS CLI
aws s3 ls s3://your-bucket/

# Check bucket exists
aws s3api head-bucket --bucket your-bucket
```

---

## Project Structure

```
sap-monitor/
├── exporter/                        # Node.js Prometheus Exporter
│   ├── src/
│   │   ├── index.js                 # Main entry point, Express server
│   │   ├── config.js                # Environment configuration
│   │   ├── logger.js                # Pino structured logger
│   │   ├── s3-client.js             # AWS SDK v3 S3 wrapper
│   │   ├── file-processor.js        # T-Code grouping & latest-file selection
│   │   ├── json-parser.js           # T-Code-specific JSON → metrics parsers
│   │   └── metrics.js               # Prometheus Gauge registry (dynamic)
│   ├── Dockerfile                   # Multi-stage Docker build
│   └── package.json
├── prometheus/
│   └── prometheus.yml               # Prometheus scrape configuration
├── grafana/
│   ├── dashboards/
│   │   ├── sap-exporter-overview.json       # Overview dashboard
│   │   └── sap-monitoring-dashboard.json    # Full monitoring dashboard
│   └── provisioning/
│       ├── datasources/
│       │   └── datasource.yml       # Auto-provisioned datasource
│       └── dashboards/
│           └── dashboards.yml       # Dashboard provider config
├── docker-compose.yml               # Orchestrates all three services
├── .env.example                     # Example environment variables
├── .gitignore
└── README.md
```

---

## License

MIT
