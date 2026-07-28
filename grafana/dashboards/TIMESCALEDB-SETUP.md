# TimescaleDB Setup for SAP Enterprise Monitoring

## 1. Environment Variables Needed
Create a `.env` file in the same directory as your docker-compose file with the following variables:
```env
POSTGRES_USER=postgres
POSTGRES_PASSWORD=mysecretpassword
POSTGRES_DB=sap_metrics
```

## 2. Docker Compose Setup
Add this snippet to your `docker-compose.yml` to set up both Grafana and TimescaleDB:
```yaml
version: '3.8'
services:
  timescaledb:
    image: timescale/timescaledb:latest-pg15
    container_name: timescaledb
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "5432:5432"
    volumes:
      - timescaledb-data:/var/lib/postgresql/data

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "3000:3000"
    volumes:
      - ./grafana/provisioning:/etc/grafana/provisioning
      - ./grafana/dashboards:/var/lib/grafana/dashboards

volumes:
  timescaledb-data:
```

## 3. Running TimescaleDB Directly with Docker
If not using docker-compose, run this command:
```bash
docker run -d --name timescaledb -p 5432:5432 \
  -e POSTGRES_PASSWORD=mysecretpassword \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=sap_metrics \
  timescale/timescaledb:latest-pg15
```

## 4. Configuring the Datasource in Grafana
The datasource is automatically provisioned via the `timescaledb.yml` provisioning file provided. If manual configuration is ever needed:
1. Go to **Connections -> Data Sources**
2. Add a new **PostgreSQL** datasource
3. Set Host to `timescaledb:5432`
4. Provide the configured Database, User, and Password
5. Under PostgreSQL details, enable **TimescaleDB**
6. Click Save & Test

## 5. Importing the Dashboard
Dashboards are provisioned from `/var/lib/grafana/dashboards` based on the configured dashboard provider. 
To manually import an updated dashboard:
1. Go to **Dashboards -> Import**
2. Upload the JSON file or paste the JSON text
3. Select the TimescaleDB datasource
4. Click Import

## 6. Inserting Test Data
Connect to the database via psql or your preferred client, and run:
```sql
-- Create a sample performance metrics table
CREATE TABLE st06_system_perf (
    time TIMESTAMPTZ NOT NULL,
    cpu_idle FLOAT,
    memory_used_bytes BIGINT,
    memory_total_bytes BIGINT,
    disk_utilization FLOAT
);

-- Convert standard table to a TimescaleDB hypertable
SELECT create_hypertable('st06_system_perf', 'time');

-- Insert a test data point (Triggering critical CPU alert: cpu_idle=5.0)
INSERT INTO st06_system_perf (time, cpu_idle, memory_used_bytes, memory_total_bytes, disk_utilization)
VALUES (NOW(), 5.0, 9000000000, 10000000000, 92.5);
```
