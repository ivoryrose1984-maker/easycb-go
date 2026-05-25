// PM2 process manager config — keeps both bots running 24/7
// Usage:
//   pm2 start ecosystem.config.js          # start both
//   pm2 stop all                            # stop both
//   pm2 restart all                         # restart both
//   pm2 logs                                # stream all logs
//   pm2 logs apex-predator                  # TS bot logs only
//   pm2 logs arb-go                         # Go bot logs only
//   pm2 monit                               # live CPU/memory dashboard
//   pm2 save                                # save process list (survives reboots)

module.exports = {
  apps: [
    {
      name: 'apex-predator',
      script: 'dist/ApexPredator.js',
      cwd: './apex-predator',
      interpreter: 'node',
      env_file: './apex-predator/.env.testnet',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: '10s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/apex-predator.log',
      error_file: './logs/apex-predator-error.log',
      merge_logs: true,
    },
    {
      name: 'arb-go',
      script: './arb-bot',
      cwd: './arbitrage',
      interpreter: 'none',
      env_file: './arbitrage/.env',
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      min_uptime: '10s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/arb-go.log',
      error_file: './logs/arb-go-error.log',
      merge_logs: true,
    },
  ],
};
