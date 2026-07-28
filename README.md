# SAP Monitoring Platform

Production-ready SAP system monitoring built on **Amazon S3**, **Node.js**, **Prometheus**, and **Grafana**.

```
SAP ABAP
    │
    ▼
Node.js Upload API
    │
    ▼
Amazon S3 Bucket
    │
    ▼
Node.js Prometheus Exporter   ←  You are here
    │
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
- [Manual Deployment (Ubuntu / EC2)](#manual-deployment-ubuntu--ec2)
- [Configuration](#configuration)
- [Exporter Details](#exporter-details)
- [Prometheus Configuration](#prometheus-configuration)
- [Grafana Dashboard](#grafana-dashboard)
- [Adding New T-Codes](#adding-new-t-codes)
- [S3 File Format](#s3-file-format)
- [PM2 Process Management](#pm2-process-management)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)

---

## Architecture Overview

The platform collects SAP system metrics via T-Codes and makes them visible in Grafana:

1. **SAP ABAP** exports T-Code data as JSON files to **Amazon S3**.
   - File naming: `{TCODE}_{ISO_TIMESTAMP}.json` (e.g. `AL08_2026-07-27T06-29-13.json`)
   - Multiple files per T-Code may exist; the exporter always processes the **latest** file by `LastModified`.

2. The **Node.js Prometheus Exporter** runs on a schedule (each Prometheus scrape):
   - Connects to S3
   - Lists all objects
   - Groups files by T-Code
   - Selects only the **latest** file per T-Code
   - Downloads and parses the JSON
   - Converts every numeric value into a **Prometheus Gauge** metric
   - Exposes all metrics at the `/metrics` endpoint

3. **Prometheus** scrapes the exporter every 30 seconds.

4. **Grafana** visualises the metrics on a pre-configured dashboard with 30-second auto-refresh.

### Key Design Decisions

- ✅ **Dynamic & Future-Proof** — Adding new T-Codes requires **zero code changes**. The exporter auto-discovers T-Codes from S3 file names.
- ✅ **Resilient** — Invalid JSON files are skipped; remaining T-Codes still get processed.
- ✅ **Scalable** — Files are downloaded in parallel using `Promise.all()`.
- ✅ **Observable** — Structured logging via Pino with levels for dev and production.

---

## Supported T-Codes

| T-Code | Description          | Metrics Collected           |
|--------|----------------------|-----------------------------|
| AL08   | User Activity        | Active, Logged, Locked Users |
| SM50   | Work Processes       | Running, Waiting, Stopped    |
| SM12   | Lock Management      | Lock Entries, Waiting, Failed Locks |
| ST22   | Runtime Errors       | Total Dumps, Today's, Critical |
| ST06   | OS & Hardware        | CPU, Memory, Disk, Swap Usage |

Any future T-Code uploaded to S3 with the correct filename format is automatically discovered.

---

## Prerequisites

- **Node.js** ≥ 18 (for manual deployment)
- **AWS account** with an S3 bucket and IAM credentials
- **Docker & Docker Compose** (for containerized deployment)
- **Prometheus** (included in Docker setup)
- **Grafana** (included in Docker setup)

### Required IAM Permissions

The AWS credentials must have the following permissions on the S3 bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::mkill",
        "arn:aws:s3:::mkill/*"
      ]
    }
  ]
}
```

---

## Quick Start (Docker)

The fastest way to get everything running is with Docker Compose.

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
AWS_ACCESS_KEY_ID=******************************
AWS_SECRET_ACCESS_KEY=*********************
S3_BUCKET_NAME=mkill
```

### 3. Start All Services

```bash
docker compose up -d
```

This starts three containers:

| Service        | Port | URL                          |
|----------------|------|------------------------------|
| SAP Exporter   | 9105 | http://localhost:9105/metrics |
| Prometheus     | 9090 | http://localhost:9090        |
| Grafana        | 3000 | http://localhost:3000        |

### 4. Verify

```bash
# Check exporter health
curl http://localhost:9105/health

# View Prometheus metrics
curl http://localhost:9105/metrics

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets
```

### 5. Open Grafana

1. Browse to **http://localhost:3000**
2. Login: `admin` / `admin` (change in `.env`!)
3. The **SAP Runtime Monitoring** dashboard is auto-provisioned.
4. Navigate to **Dashboards → SAP Runtime Monitoring**.

---

## Manual Deployment (Ubuntu / EC2)

### 1. Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

node --version   # v20.x.x
npm --version    # 10.x.x
```

### 2. Clone & Install

```bash
git clone <repo-url> sap-monitor
cd sap-monitor/exporter
npm install --production
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env   # Fill in AWS credentials
```

### 4. Run the Exporter

**Option A: Direct Node (for testing)**

```bash
node src/index.js
```

**Option B: PM2 (recommended for production)**

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start with PM2
pm2 start ecosystem.config.js

# Save process list for auto-restart
pm2 startup
pm2 save
```

### 5. Install Prometheus

```bash
# Download Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.53.0/prometheus-2.53.0.linux-amd64.tar.gz
tar xzf prometheus-2.53.0.linux-amd64.tar.gz
sudo mv prometheus-2.53.0.linux-amd64 /opt/prometheus

# Copy configuration
sudo cp ../prometheus/prometheus.yml /opt/prometheus/

# Create systemd service
sudo tee /etc/systemd/system/prometheus.service << 'EOF'
[Unit]
Description=Prometheus
Wants=network-online.target
After=network-online.target

[Service]
User=prometheus
Group=prometheus
Type=simple
ExecStart=/opt/prometheus/prometheus \
  --config.file=/opt/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus \
  --web.console.libraries=/opt/prometheus/console_libraries \
  --web.console.templates=/opt/prometheus/consoles \
  --storage.tsdb.retention.time=30d

[Install]
WantedBy=multi-user.target
EOF

# Create user and directories
sudo useradd --no-create-home --shell /bin/false prometheus
sudo mkdir -p /var/lib/prometheus
sudo chown -R prometheus:prometheus /opt/prometheus /var/lib/prometheus

# Start Prometheus
sudo systemctl daemon-reload
sudo systemctl enable prometheus
sudo systemctl start prometheus
```

**Important**: When running without Docker, update `prometheus.yml` targets from `sap-exporter:9105` to `localhost:9105`:

```yaml
static_configs:
  - targets: ["localhost:9105"]
    labels:
      service: "sap-monitor"
```

### 6. Install Grafana

```bash
# Add Grafana repository
sudo apt-get install -y software-properties-common
sudo add-apt-repository "deb https://packages.grafana.com/oss/deb stable main"
wget -q -O- https://packages.grafana.com/gpg.key | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y grafana

# Copy dashboard and provisioning
sudo mkdir -p /etc/grafana/provisioning/datasources
sudo mkdir -p /etc/grafana/provisioning/dashboards
sudo cp ../grafana/dashboard.json /var/lib/grafana/dashboards/
sudo cp ../grafana/provisioning/datasources/prometheus.yml /etc/grafana/provisioning/datasources/
sudo cp ../grafana/provisioning/dashboards/sap.yml /etc/grafana/provisioning/dashboards/

# Update datasource URL for non-Docker setup (change to localhost)
sudo sed -i 's|http://sap-prometheus:9090|http://localhost:9090|g' \
  /etc/grafana/provisioning/datasources/prometheus.yml

# Start Grafana
sudo systemctl enable grafana-server
sudo systemctl start grafana-server
```

### 7. Open Security Group (EC2)

If on EC2, ensure these inbound rules exist:

| Port | Source       | Purpose           |
|------|-------------|--------------------|
| 9105 | Prometheus SG | Exporter scrape   |
| 9090 | Your IP     | Prometheus UI      |
| 3000 | Your IP     | Grafana UI         |

---

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)):

| Variable                | Default         | Description                         |
|-------------------------|-----------------|-------------------------------------|
| `AWS_REGION`            | `us-east-1`     | AWS region                         |
| `AWS_ACCESS_KEY_ID`     | —               | AWS access key **(required)**       |
| `AWS_SECRET_ACCESS_KEY` | —               | AWS secret key **(required)**       |
| `AWS_SESSION_TOKEN`     | —               | Temporary STS token                 |
| `S3_BUCKET_NAME`        | `mkill`         | S3 bucket name                      |
| `AWS_ENDPOINT`          | —               | Custom S3 endpoint                  |
| `EXPORTER_PORT`         | `9105`          | HTTP server port                    |
| `EXPORTER_HOST`         | `0.0.0.0`       | HTTP bind address                   |
| `METRICS_PREFIX`        | `sap`           | Prometheus metric name prefix       |
| `METRICS_PATH`          | `/metrics`      | Metrics HTTP path                   |
| `S3_REQUEST_TIMEOUT`    | `10000`         | S3 request timeout (ms)             |
| `S3_MAX_RETRIES`        | `3`             | S3 operation retries                |
| `LOG_LEVEL`             | `info`          | Log level (trace/debug/info/warn)   |

---

## Exporter Details

### Metrics Endpoint

```
GET /metrics
```

Returns Prometheus-formatted metrics with `Content-Type: text/plain; version=0.0.4; charset=utf-8`.

### Health Endpoint

```
GET /health
```

Returns a JSON health check:

```json
{
  "status": "ok",
  "timestamp": "2026-07-27T12:00:00.000Z",
  "uptime": 3600
}
```

### Scrape Cycle

On every Prometheus scrape of `/metrics`:

1. List all objects in the S3 bucket
2. Group files by T-Code (extracted from filename prefix)
3. For each T-Code, select the file with the newest `LastModified`
4. Reset all previously-registered metrics
5. Download latest files in parallel
6. Parse JSON and register Gauge metrics dynamically
7. Return all metrics

### Metric Naming Convention

Metrics follow the pattern:

```
sap_{tcode_lowercase}_{json_path_snake_case}
```

For example, given `AL08` JSON:
```json
{
  "active_users": 42,
  "logged_users": 100,
  "locked_users": 3
}
```

The exporter produces:
```
# HELP sap_al08_active_users SAP metric: sap_al08_active_users
# TYPE sap_al08_active_users gauge
sap_al08_active_users 42

# HELP sap_al08_logged_users SAP metric: sap_al08_logged_users
# TYPE sap_al08_logged_users gauge
sap_al08_logged_users 100

# HELP sap_al08_locked_users SAP metric: sap_al08_locked_users
# TYPE sap_al08_locked_users gauge
sap_al08_locked_users 3
```

Nested JSON is flattened with underscores:
```json
{
  "cpu": {
    "usage_percent": 45.2
  }
}
```

Produces: `sap_st06_cpu_usage_percent`

---

## Prometheus Configuration

The [`prometheus/prometheus.yml`](prometheus/prometheus.yml) file configures:

```yaml
scrape_configs:
  - job_name: "sap-monitor"
    scrape_interval: 30s
    scrape_timeout: 10s
    metrics_path: /metrics
    static_configs:
      - targets: ["sap-exporter:9105"]   # Docker, or "localhost:9105" for bare metal
```

Key settings:

| Setting            | Value     | Notes                               |
|--------------------|-----------|-------------------------------------|
| scrape_interval    | `30s`     | Matches SAP data upload frequency   |
| scrape_timeout     | `10s`     | Enough for S3 download + parse      |
| retention.time     | `30d`     | Retain 30 days of metrics           |

---

## Grafana Dashboard

The dashboard **SAP Runtime Monitoring** (`grafana/dashboard.json`) is auto-provisioned with:

| Row  | T-Code | Panels                   | Panel Types     |
|------|--------|--------------------------|-----------------|
| 1    | AL08   | Active, Logged, Locked   | Stat            |
| 2    | SM50   | Running, Waiting, Stopped | Gauge           |
| 3    | SM12   | Entries, Waiting, Failed  | Stat            |
| 4    | ST22   | Total, Today's, Critical  | Stat            |
| 5    | ST06   | CPU, Memory, Disk, Swap  | Gauge           |

- **Auto-refresh**: 30 seconds
- **Theme**: Dark (compatible with dark mode)
- **Thresholds**: Colour-coded (green / orange / red) for quick health assessment

---

## Adding New T-Codes

**No code changes required.** To add a new T-Code:

1. Configure your SAP ABAP system to export JSON files named `{TCODE}_{ISO_TIMESTAMP}.json`
2. Upload them to the same S3 bucket
3. On the next Prometheus scrape, the exporter automatically:
   - Discovers the new T-Code
   - Downloads the latest file
   - Creates metrics named `sap_{tcode}_{metric_path}`
4. **Manually add panels** to the Grafana dashboard to visualise the new metrics

Example: Adding a hypothetical `ST03` T-Code

1. Upload `ST03_2026-07-27T12-00-00.json` to S3
2. The exporter creates `sap_st03_*` metrics
3. In Grafana, add new panels to the dashboard referencing `sap_st03_*`

---

## S3 File Format

### Naming Convention

```
{TCODE}_{YYYY}-{MM}-{DD}T{HH}-{MM}-{SS}.json
```

Example: `AL08_2026-07-27T06-29-13.json`

### JSON Structure

The exporter recursively walks the JSON tree. Any numeric leaf value becomes a Gauge metric. Example valid JSON:

```json
{
  "active_users": 42,
  "logged_users": 100,
  "locked_users": 3,
  "details": {
    "max_users": 500,
    "threshold_pct": 80.5
  }
}
```

### Invalid Files

If a JSON file is malformed, the exporter logs an error and continues processing other T-Codes. The scrape cycle does not fail.

---

## PM2 Process Management

For production deployments without Docker, use PM2:

```bash
# Start
pm2 start ecosystem.config.js

# View logs
pm2 logs sap-exporter

# Monitor
pm2 monit

# Restart
pm2 restart sap-exporter

# Stop
pm2 stop sap-exporter

# Auto-start on boot
pm2 startup
pm2 save
```

Configuration is in [`exporter/ecosystem.config.js`](exporter/ecosystem.config.js).

---

## Troubleshooting

### Exporter won't start

```bash
# Check logs
pm2 logs sap-exporter
# or
node src/index.js

# Verify environment
node -e "require('./src/config')"
```

### No metrics in Prometheus

```bash
# Check exporter directly
curl http://localhost:9105/metrics

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Check Prometheus can reach the exporter
curl http://sap-exporter:9105/metrics   # Docker
curl http://localhost:9105/metrics       # Bare metal
```

### S3 permission errors

```bash
# Verify credentials using AWS CLI
aws s3 ls s3://mkill/

# Check bucket exists
aws s3api head-bucket --bucket mkill
```

### Grafana shows "No data"

1. Verify Prometheus is scraping the exporter (check Prometheus targets UI)
2. Ensure the metrics exist: `curl http://localhost:9105/metrics | grep sap_`
3. Check the Grafana datasource is correctly configured to point to Prometheus
4. Verify the dashboard PromQL queries match the actual metric names

---

## Security Considerations

- **IAM credentials**: Store in `.env` (gitignored). Never commit to version control.
- **Least privilege**: The IAM policy should only grant `s3:ListBucket` and `s3:GetObject` on the specific bucket.
- **Network isolation**: In production, place the exporter in a private subnet. Only Prometheus needs HTTP access to it.
- **Grafana auth**: Change the default `admin` password immediately. Consider OAuth/OIDC for production.
- **HTTPS**: Use a reverse proxy (nginx, ALB) to terminate TLS for both Prometheus and Grafana.
- **Container security**: The Docker image runs as a non-root user (`appuser`).

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
│   │   ├── json-parser.js           # Dynamic JSON → metrics parser
│   │   └── metrics.js               # Prometheus Gauge registry (dynamic)
│   ├── Dockerfile                   # Multi-stage Docker build
│   ├── ecosystem.config.js          # PM2 process management
│   └── package.json
├── prometheus/
│   └── prometheus.yml               # Prometheus scrape configuration
├── grafana/
│   ├── dashboard.json               # SAP Runtime Monitoring dashboard
│   └── provisioning/
│       ├── datasources/
│       │   └── prometheus.yml       # Auto-provisioned datasource
│       └── dashboards/
│           └── sap.yml              # Dashboard provider config
├── docker-compose.yml               # Orchestrates all three services
├── .env.example                     # Example environment variables
├── .gitignore
└── README.md
```

---

## License

MIT
