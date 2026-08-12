module.exports = {
  apps: [{
    name: 'jinhe-trip',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // 自动重启
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    // 崩溃/内存溢出保护
    max_memory_restart: '256M',
    // 日志
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // 监听文件变化自动重载（生产环境可关闭）
    watch: false,
    // 优雅关闭
    kill_timeout: 5000,
    wait_ready: false
  }]
};
