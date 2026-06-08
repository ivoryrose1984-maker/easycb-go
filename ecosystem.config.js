// PM2 process manager — Apex Unified
// Usage:
//   pm2 start ecosystem.config.js    # start
//   pm2 stop apex-unified            # stop
//   pm2 restart apex-unified         # restart
//   pm2 logs apex-unified            # stream logs
//   pm2 monit                        # live CPU/memory dashboard
//   pm2 save                         # persist across reboots

module.exports = {
  apps: [
    {
      name: 'apex-unified',
      script: 'npm',
      args: 'run dry-run',
      cwd: './apex-unified',
      interpreter: 'none',
      env_file: './apex-unified/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      stop_exit_codes: [1],   // circuit breaker exits with code 1 — do not restart
      restart_delay: 5000,
      min_uptime: '10s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/var/log/apex/unified.log',
      error_file: '/var/log/apex/unified-error.log',
      merge_logs: true,
    },
  ],
};
