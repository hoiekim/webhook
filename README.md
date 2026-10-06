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

# gh-proxy

A second, independent server (`gh-proxy.js`) for a narrower job: run the
`gh` CLI itself, with whatever arguments a caller sends, authenticated by
the caller's own token rather than a server-side secret. Where `index.js`
runs one operator-chosen command behind a shared password, `gh-proxy.js`
runs any `gh` subcommand the caller asks for, scoped to whatever that
caller's own credential can already do.

Start it:

```
node gh-proxy.js
```

Call it:

```
curl -X POST localhost:3003/gh \
  -H "Authorization: Bearer <a GitHub token>" \
  -H "Content-Type: application/json" \
  -d '{"command": "pr list --state open"}'
```

The server runs `GH_TOKEN="<that token>" gh <command>` and returns the
result. `command` is split into arguments the way a shell would — quotes
group a token, a backslash escapes a character — but no shell is ever
invoked: the parsed arguments go straight to `gh` as a literal argument
list. A `command` containing `;`, `&&`, `|`, `$(...)` or backticks does
not chain a second command, because there is no shell there to interpret
them; they just become (almost always invalid) arguments to `gh`.

There is no separate access secret: the bearer token in the `Authorization`
header IS `GH_TOKEN` for the call. A missing or invalid token fails exactly
the way running `gh` locally with no `GH_TOKEN` set would — at the GitHub
API, inside `gh` itself.

**That does NOT mean this process can only do what the presented token
can do.** `gh` has its own escape hatches out of the GitHub-API surface —
`gh alias set x '!<shell command>'` runs an arbitrary shell command with
no GitHub auth involved at all (a real, documented `gh` feature, not a
bug in it); `gh extension` downloads and runs third-party code; `gh
config`/`gh auth` can durably change how a LATER call behaves. None of
that is closed by shell-free argv splitting, because the first (and only)
command that ever runs is `gh` itself — splitting the string just decides
what `gh` is handed, not what `gh` is allowed to do with it. The first
argument is checked against `ALLOWED_SUBCOMMANDS` in `gh-proxy.js` before
anything executes — an allowlist of the subcommands actually needed
(`api`, `issue`, `pr`, `repo`, `release`, `run`, `workflow`, …), not a
denylist of the ones found dangerous so far. A subcommand this proxy
hasn't been told is safe is refused, not permitted.

Each call also gets its own scratch directory, used as both its working
directory and its `GH_CONFIG_DIR` — so a disk-writing subcommand (`gh
repo clone`, `gh run download`) can't collide with another in-flight
call, and nothing one caller's `gh config` touches can leak into a later
caller's. Removed after the call finishes either way.

## Response

- Success (`gh` exits 0): `200` with `{ ok: true, exit_code: 0, durationMs, stdout, stderr, truncated }`.
- Failure (non-zero exit or killed by signal): `500` with `{ ok: false, exit_code, signal, durationMs, stdout, stderr }`. As with the webhook above, a signal kill (our own timeout, or `gh` crashing) reports `exit_code: null` with `signal` set, distinct from a real non-zero exit.
- Missing or invalid `Authorization`: `401`, no body.
- Missing/empty `command`, or a `command` with an unterminated quote: `400` with `{ ok: false, error: "<reason>" }`.
- First word of `command` is not on `ALLOWED_SUBCOMMANDS`: `403` with `{ ok: false, error: "subcommand '<name>' is not on the allowlist" }`.
- Request body larger than 64 KiB: `413` with `{ ok: false, error: "body too large" }`.
- Wrong method: `405` with `Allow: POST`. Wrong path (anything but `/gh`): `404`.

`stdout`/`stderr` are capped at `OUTPUT_MAX` (256 KiB each) with
`truncated: true` if either was cut; `gh`'s own output (JSON listings,
diffs) runs larger than a typical deploy command's, so this cap is well
above the webhook's 2000-character tails. `COMMAND_TIMEOUT_MS` defaults to
2 minutes — override with the `GH_PROXY_TIMEOUT_MS` env var (`0` means no
timeout, same as `execFile`'s own convention) for a call that legitimately
needs longer.

Unlike the webhook above, concurrent calls are not serialized: each
request runs its own `gh` invocation with its own token, so there is no
shared command for two in-flight requests to race against.

What gets logged per call is the subcommand name and argument count only
— never the full argument list or the raw command string. An allowed
subcommand can still carry a secret as one of its own arguments (`gh
secret set NAME --body "<value>"`), and a log line is a wider-access,
longer-retained surface than the request itself.

# Running under pm2

`ecosystem.config.js` at the repo root registers BOTH servers as
separate pm2 apps — `webhook` (`index.js`) and `gh-proxy`
(`gh-proxy.js`) — so each is supervised, restarts on crash, and
survives host reboots (if pm2's own systemd unit is installed via
`pm2 startup`). Env values are read from the shell at startup — no
secrets in the repo.

First-time start (or after `git pull` in an existing checkout) — starts
both apps in one call:

```
APP_NAME=<your name> \
  COMMAND='<your shell command>' \
  SECRET='<your secret>' \
  PORT=3002 \
  GH_PROXY_PORT=3003 \
  pm2 startOrReload ecosystem.config.js
```

Restart in place, picking up new code AND new env:

```
APP_NAME=<your name> \
  COMMAND='<your shell command>' \
  SECRET='<your secret>' \
  PORT=3002 \
  GH_PROXY_PORT=3003 \
  pm2 restart ecosystem.config.js --update-env
```

Only want one of the two apps? Add `--only webhook` or
`--only gh-proxy` to either command above — pm2 reads the rest of
`ecosystem.config.js` for context but starts/restarts just the named
app, so you don't have to supply the other app's env vars at all.

Notes:

- `COMMAND` runs in a shell in pm2's working directory. If your command
  needs a specific cwd (e.g. it references files by relative path), set
  the pm2 process's `cwd` in `ecosystem.config.js`, or prefix `COMMAND`
  with `cd /path/to/dir &&`.
- `APP_NAME` names the webhook app's pm2 process handle (used by
  `pm2 restart` / `pm2 logs`); `GH_PROXY_APP_NAME` is its gh-proxy
  equivalent. Both default to their script's own name (`webhook`,
  `gh-proxy`). Give each instance a distinct name + port if you want
  to run several of either on one host.
- `gh-proxy` takes no `COMMAND`/`SECRET` — only `GH_PROXY_PORT` (default
  `3003`) and the optional `GH_PROXY_TIMEOUT_MS`. It uses a different
  port env name on purpose, so starting both apps from one
  `pm2 startOrReload` call can't collide them on a single shared `PORT`
  value.

Everyday commands:

```
pm2 status                     # list processes
pm2 logs <APP_NAME>            # tail combined stdout/stderr
pm2 restart <APP_NAME>         # bounce without re-reading ecosystem
pm2 stop <APP_NAME>            # stop but keep in the process list
pm2 delete <APP_NAME>          # remove from the process list
pm2 save                       # persist the current list so `pm2 resurrect` re-hydrates it after reboot
```

Use `pm2 restart <name> --update-env` when the env changed (rotated
secret, new `COMMAND`); a plain `pm2 restart <name>` reuses the env
pm2 recorded at `startOrReload` time.
