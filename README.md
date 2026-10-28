# What is this?

The tiniest possible Node.js webhook server. Listens for a signed POST
and runs an arbitrary shell command. Uses only Node built-ins — zero
dependencies to install.

Use it for anything you'd otherwise SSH in to do: kick off a deploy,
purge a cache, run a backup, rotate a log, restart a service. The
command is up to you.

# How to run

Three environment variables:

- `COMMAND` — shell command to run when the webhook fires.
- `SECRET` — bearer token clients must present.
- `PORT` — optional; port to listen on. Defaults to `3002`.

Start it:

```
COMMAND=<your command> SECRET=<your secret> node index.js
```

Trigger it:

```
curl -X POST localhost:3002 \
  -H "Authorization: Bearer <your secret>" \
  -H "Content-Type: application/json" \
  -d '{"sha": "abc123"}'
```

The `Authorization: Bearer` value is hashed to a 32-byte SHA-256 digest
and compared to `SECRET`'s digest in constant time
(`crypto.timingSafeEqual`). The request body is optional — anything you
send gets JSON-parsed (best effort) and logged with the outcome, so
audit fields like `sha` or `repo` survive.

## Response

The server waits for `COMMAND` to finish and returns the outcome, so
the caller can fail on a broken command instead of always seeing
`200`.

- Success (exit 0): `200` with `{ ok: true, durationMs, stdout_tail, stderr_tail }`.
- Failure (non-zero exit or killed by signal): `500` with `{ ok: false, exit_code, signal, durationMs, stdout_tail, stderr_tail }`. On a signal kill (including our own timeout SIGKILL), `exit_code` is `null` and `signal` is set — that's how you tell a timeout from a real exit-1.
- Missing or invalid `Authorization`: `401`, no body. The request is still logged (timestamp + remote IP) but no command runs.
- Request body larger than 64 KiB: `413` with `{ ok: false, error: "body too large" }`.
- Second call arriving while an earlier one is still running: `409` with `{ ok: false, error: "already running" }`. Safe to retry once the first one finishes.
- Wrong method: `405` with `Allow: POST`.

Named constants at the top of `index.js` (`TAIL_MAX`, `BODY_MAX`,
`EXEC_MAX_BUFFER`, `COMMAND_TIMEOUT_MS`) control the caps; edit in one
place. Defaults: 2000-char tails, 64 KiB body, 2 MiB child stdio buffer
per stream, 10-minute timeout for `COMMAND`.

# Running under pm2

`ecosystem.config.js` at the repo root registers `index.js` with pm2 so
the process is supervised, restarts on crash, and survives host reboots
(if pm2's own systemd unit is installed via `pm2 startup`). Env values
(`APP_NAME`, `COMMAND`, `SECRET`, `PORT`) come from `.env`, which
`ecosystem.config.js` loads itself — no secrets in the repo, and no
need to prefix variables on the pm2 command line. A variable set in
the shell wins over `.env`.

First-time start (or after `git pull` in an existing checkout):

```
cp .env.example .env
# edit .env — set APP_NAME, COMMAND, SECRET, PORT

pm2 startOrReload ecosystem.config.js
pm2 save
```

Restart in place, picking up new code AND new `.env` values:

```
pm2 restart ecosystem.config.js
```

A restart that names the config file re-reads `.env`; a restart by
process name does not, and neither does a reboot resurrect until the
next config-file restart — run `pm2 save` after a config-file restart
so the current list persists.

Notes:

- `COMMAND` runs in a shell in pm2's working directory. If your command
  needs a specific cwd (e.g. it references files by relative path), set
  the pm2 process's `cwd` in `ecosystem.config.js`, or prefix `COMMAND`
  with `cd /path/to/dir &&`.
- `APP_NAME` names the pm2 process handle used by `pm2 restart` /
  `pm2 logs`. Defaults to `webhook`. Give each instance a distinct
  `APP_NAME` + `PORT` if you want to run several webhooks on one host.
  Changing `APP_NAME` in `.env` and restarting via the config file
  starts a second process under the new name — the old one keeps
  running. Delete the old one (`pm2 delete <old-name>`) when renaming.

Everyday commands:

```
pm2 status                     # list processes
pm2 logs <APP_NAME>            # tail combined stdout/stderr
pm2 restart <APP_NAME>         # bounce without re-reading ecosystem
pm2 stop <APP_NAME>            # stop but keep in the process list
pm2 delete <APP_NAME>          # remove from the process list
pm2 save                       # persist the current list so `pm2 resurrect` re-hydrates it after reboot
```

Use `pm2 restart <name> --update-env` when a variable changed in the
shell (rotated secret exported there, new `COMMAND`); it updates the
env from the invoking shell, not from `.env`. A plain `pm2 restart
<name>` reuses the env pm2 recorded at `startOrReload` time.
