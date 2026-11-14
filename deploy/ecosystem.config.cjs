// pm2 process file for Mailloom. See docs/deploy.md.
//
// Layout on the server:
//   /opt/mailloom/releases/mailloom-<commit>/   one folder per release (unpacked tarball)
//   /opt/mailloom/current                       symlink to the release that runs
//   /etc/mailloom/mailloom.env                  the secrets file (copy of .env.example, filled in, mode 600)
//   /var/lib/mailloom/sessions.db               SESSION_DB_PATH (folder mode 700)
//
// Start:   pm2 start /opt/mailloom/current/ecosystem.config.cjs
// Reload:  pm2 restart mailloom --update-env
module.exports = {
  apps: [
    {
      name: 'mailloom',
      script: 'server.mjs',
      cwd: '/opt/mailloom/current',
      // Must be Node 22.13 or newer. Uncomment and fix the path if the system "node" is older:
      // interpreter: '/usr/local/bin/node',
      instances: 1, // one process only: sessions and push watchers live in this process
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      kill_timeout: 10000,
      time: true,
      env: {
        // dotenv reads this file; nothing secret is written in this pm2 file.
        DOTENV_CONFIG_PATH: '/etc/mailloom/mailloom.env',
        NODE_ENV: 'production'
      }
    }
  ]
};
