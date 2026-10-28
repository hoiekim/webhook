// Loads `.env` (next to this file) into `process.env` before the config
// below is evaluated, so `pm2 startOrReload` / `pm2 restart
// ecosystem.config.js` picks up `.env` values with no inline `VAR=...`
// prefix and no dependency. pm2 itself never reads `.env`.
//
// Precedence: the shell wins — a variable already set in the environment
// that invokes pm2 is never overridden by `.env` (the dotenv rule). A
// missing `.env` is fine: values then come from the shell alone, and the
// `|| "3002"` fallback below applies as before. `APP_NAME` from `.env`
// also names the pm2 process, like it did from the shell — changing it
// later starts a second process under the new name (the old one keeps
// running), so delete the old process when renaming.
//
// This only takes effect when pm2 (re)reads this file, i.e. a start or
// restart that names the file. `pm2 restart <name>` reuses the
// previously loaded configuration and does NOT re-read `.env`; neither
// does a reboot resurrect from `pm2 save` until the next config-file
// restart. After editing `.env`, run `pm2 restart ecosystem.config.js`
// (then `pm2 save`). Every variable the app uses is in the `env` block
// below, so a config-file restart re-reads all of them.
//
// Parser: one `KEY=value` per line, optional `export ` prefix, `#`
// full-line comments, double/single quotes, and ` #` inline comments on
// unquoted values. Malformed lines are warned about and skipped, never
// fatal — a bad `.env` must not stop pm2 from starting.
const { readFileSync } = require("fs");
const { join } = require("path");

function loadDotenv() {
  let text;
  try {
    text = readFileSync(join(__dirname, ".env"), "utf-8");
  } catch {
    return; // no .env file — shell environment only
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // UTF-8 BOM
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.replace(/^export[ \t]+/, "");
    const eq = body.indexOf("=");
    if (eq === -1) {
      console.warn(`[ecosystem] ignoring malformed .env line: ${JSON.stringify(rawLine)}`);
      continue;
    }
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      console.warn(`[ecosystem] ignoring malformed .env line: ${JSON.stringify(rawLine)}`);
      continue;
    }
    // Already set (shell, or an earlier line in this file) wins.
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end === -1) {
        console.warn(`[ecosystem] ignoring unterminated quoted value in .env line: ${JSON.stringify(rawLine)}`);
        continue;
      }
      const inner = value.slice(1, end);
      // Single-quoted values are literal; double-quoted values honour
      // backslash escapes (single pass, so `\\n` stays backslash + n).
      value =
        quote === "'"
          ? inner
          : inner.replace(/\\(.)/g, (_match, ch) => {
              switch (ch) {
                case "n":
                  return "\n";
                case "r":
                  return "\r";
                case "t":
                  return "\t";
                default:
                  return ch;
              }
            });
    } else {
      // Unquoted: a ` #` starts an inline comment; a `#` glued to the
      // value (e.g. in a URL fragment) is part of the value.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    process.env[key] = value;
  }
}

loadDotenv();

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
  ],
};
