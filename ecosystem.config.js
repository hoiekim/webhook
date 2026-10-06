/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    {
      name: process.env.APP_NAME || "webhook",
      script: "index.js",
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_memory_restart: "100M",
      env: {
        NODE_ENV: "production",
        APP_NAME: process.env.APP_NAME,
        COMMAND: process.env.COMMAND,
        SECRET: process.env.SECRET,
        PORT: process.env.PORT || "3002",
      },
    },
    {
      // Separate app, separate port var (GH_PROXY_PORT, not PORT) — so
      // starting both apps from one `pm2 startOrReload ecosystem.config.js`
      // invocation can't collide them on the same shell PORT value the way
      // sharing one env name would.
      name: process.env.GH_PROXY_APP_NAME || "gh-proxy",
      script: "gh-proxy.js",
      interpreter: "node",
      autorestart: true,
      watch: false,
      max_memory_restart: "150M",
      env: {
        NODE_ENV: "production",
        GH_PROXY_PORT: process.env.GH_PROXY_PORT || "3003",
        GH_PROXY_TIMEOUT_MS: process.env.GH_PROXY_TIMEOUT_MS,
      },
    },
  ],
};
