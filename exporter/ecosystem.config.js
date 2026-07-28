/**
 * PM2 Ecosystem configuration for the SAP Prometheus Exporter.
 *
 * Usage:
 *   pm2 start ecosystem.config.js          # Start
 *   pm2 stop ecosystem.config.js           # Stop
 *   pm2 restart ecosystem.config.js        # Restart
 *   pm2 logs sap-exporter                  # View logs
 *   pm2 status                             # Check status
 *
 * For auto-start on system boot:
 *   pm2 startup
 *   pm2 save
 */

module.exports = {
  apps: [
    {
      name: 'sap-exporter',
      script: 'src/index.js',
      cwd: __dirname,

      // Process management
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '300M',

      // Environment variables
      env: {
        NODE_ENV: 'production',
      },

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/sap-exporter-error.log',
      out_file: './logs/sap-exporter-out.log',
      merge_logs: true,
      time: true,

      // Restart behavior
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,

      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 5000,

      // Source map support
      source_map_support: true,
    },
  ],
};
