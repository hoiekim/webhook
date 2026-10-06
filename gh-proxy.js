const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const execFileAsync = promisify(execFile);
const { GH_PROXY_PORT, GH_PROXY_TIMEOUT_MS } = process.env;

// Response size caps.
const BODY_MAX = 64 * 1024; // request body bytes accepted
const OUTPUT_MAX = 256 * 1024; // stdout/stderr characters surfaced per response
const EXEC_MAX_BUFFER = 8 * 1024 * 1024; // child stdio buffer per stream — `gh`
// output (JSON listings, diffs) runs larger than a typical deploy command's.

// `undefined`/empty means "not set, use the default"; an explicit `0` means
// "no timeout" (Node's own `execFile` convention) and must survive rather
// than falling back to the default the way `Number(x) || default` would
// have treated it (0 is falsy).
const COMMAND_TIMEOUT_MS =
  GH_PROXY_TIMEOUT_MS !== undefined && GH_PROXY_TIMEOUT_MS !== ""
    ? Number(GH_PROXY_TIMEOUT_MS)
    : 2 * 60 * 1000; // most `gh` calls are a single API round-trip; 2 min
// covers a slow one (a large `gh pr diff`, a paginated list) without
// leaving a hung call tying up this process indefinitely.

// `gh`'s OWN first-level subcommands that reach something other than the
// GitHub API: `alias` can run an arbitrary shell command on invocation
// (`gh alias set x '!<shell command>'` is a documented, no-auth-required
// feature of `gh` itself, not a bug in it), `extension` downloads and
// executes third-party code, `config`/`auth` can durably change how every
// LATER call behaves (an editor/pager/protocol a later command shells out
// to, or the account `gh` authenticates as), and `codespace` opens an
// interactive remote shell session. None of these are "whatever the
// caller's token can already do" — they're `gh`'s own escape hatches out
// of the GitHub-API surface this proxy exists to expose, and no amount of
// argv-splitting or env scrubbing closes them, so they're blocked by an
// ALLOWLIST of the subcommands actually needed, not a denylist of the ones
// found dangerous so far — an unaudited remaining subcommand defaults to
// refused, not permitted.
const ALLOWED_SUBCOMMANDS = new Set([
  "api",
  "issue",
  "pr",
  "label",
  "release",
  "repo",
  "run",
  "workflow",
  "gist",
  "search",
  "status",
  "org",
  "project",
  "ruleset",
  "secret",
  "variable",
  "attestation",
  "cache",
]);

// The caller's own token stands in for a shared server secret: there is
// nothing else to compare it against — a request with no bearer token, or
// one carrying an invalid/revoked token, fails the same way running `gh`
// locally without `GH_TOKEN` set would, when the underlying `gh` call hits
// the GitHub API.
function extractToken(req) {
  const raw = req.headers["authorization"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

// Splits a command string into argv the way a shell's word-splitting does
// (quotes group a token, a backslash escapes the next character), but never
// invokes a shell — the result is handed to `execFile` as a literal argument
// array. That stops a `;`, `&&`, `|`, `$(...)` or backtick in the command
// string from chaining a second command at the dispatch layer; it says
// nothing about what the first (and only) command — `gh` itself — then
// does with its own argv, which is what the subcommand allowlist above is
// for. `command` is already known non-empty (checked by the caller before
// this runs), so a well-formed input always yields at least one token.
function splitCommand(input) {
  const args = [];
  let current = "";
  let quote = null; // null | '"' | "'"
  let escaped = false;
  let hasToken = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (escaped || quote) {
    throw new Error("unterminated quote or escape in command");
  }
  if (hasToken) args.push(current);
  return args;
}

http
  .createServer(async (req, res) => {
    if (req.url !== "/gh") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }

    const token = extractToken(req);
    if (!token) {
      console.warn(
        new Date().toISOString(),
        "request with no bearer token from",
        req.socket.remoteAddress,
      );
      res.writeHead(401).end();
      return;
    }

    const startedAt = Date.now();
    let workDir = null;
    try {
      const chunks = [];
      let total = 0;
      let overflow = false;
      try {
        for await (const chunk of req) {
          total += chunk.length;
          if (total > BODY_MAX) {
            overflow = true;
            break;
          }
          chunks.push(chunk);
        }
      } catch {
        /* client disconnected mid-body — treat as empty */
      }
      if (overflow) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "body too large" }));
        return;
      }

      let command;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        command = body && body.command;
      } catch {
        /* falls through to the missing-command check below */
      }
      if (typeof command !== "string" || command.trim() === "") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing or empty 'command'" }));
        return;
      }

      let args;
      try {
        args = splitCommand(command);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
        return;
      }

      if (!ALLOWED_SUBCOMMANDS.has(args[0])) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: false,
            error: `subcommand '${args[0]}' is not on the allowlist`,
          }),
        );
        return;
      }

      // A fresh scratch directory per request, used as both the child's
      // cwd (so a disk-writing subcommand like `gh repo clone`/`gh run
      // download` can't collide with another in-flight request or write
      // into this server's own checkout) and its GH_CONFIG_DIR (so one
      // caller's `gh config`-influenced defaults — editor, pager, git
      // protocol — can never carry over to another caller's call; `gh`
      // itself persists config to disk, and without an isolated dir every
      // request would otherwise share one file on the host). Removed in
      // `finally` below regardless of outcome.
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-proxy-"));
      const configDir = path.join(workDir, "gh-config");
      await fs.mkdir(configDir);

      // Drop every ambient GitHub-auth env var this process itself was
      // started with before setting the caller's — otherwise a host-level
      // credential could silently take over if the caller's own token were
      // ever rejected for a reason `gh` treats as "fall back", and two
      // different auth sources would be in play on one call. `gh help
      // environment` documents all three as recognized inputs.
      const env = { ...process.env, GH_TOKEN: token, GH_CONFIG_DIR: configDir };
      delete env.GITHUB_TOKEN;
      delete env.GH_ENTERPRISE_TOKEN;
      delete env.GITHUB_ENTERPRISE_TOKEN;

      // Log the subcommand and arg count, never the full argv or the
      // command string — an allowed subcommand can still carry a secret
      // value as one of its OWN arguments (`gh secret set NAME --body
      // "<value>"`), and a log line is a wider-access, longer-retained
      // surface than the request itself.
      const { stdout, stderr } = await execFileAsync("gh", args, {
        env,
        cwd: workDir,
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const durationMs = Date.now() - startedAt;
      console.log(
        new Date().toISOString(),
        "gh OK",
        JSON.stringify({ durationMs, subcommand: args[0], argCount: args.length }),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          exit_code: 0,
          durationMs,
          stdout: stdout.slice(0, OUTPUT_MAX),
          stderr: stderr.slice(0, OUTPUT_MAX),
          truncated: stdout.length > OUTPUT_MAX || stderr.length > OUTPUT_MAX,
        }),
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      // `error.code` is a number on a normal non-zero `gh` exit (not found,
      // bad token, validation failure) — an expected outcome this proxy
      // just relays, not a server fault. `null` means the child was killed
      // by a signal (our timeout's SIGKILL, or `gh` itself crashing), which
      // the caller needs to be able to tell apart from a real exit code.
      const exit_code = typeof error.code === "number" ? error.code : null;
      const signal = error.signal || null;
      const stdout = String(error.stdout || "").slice(0, OUTPUT_MAX);
      const stderr = String(error.stderr || error.message || "").slice(0, OUTPUT_MAX);
      console.error(
        new Date().toISOString(),
        "gh FAILED",
        JSON.stringify({ durationMs, exit_code, signal }),
      );
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, exit_code, signal, durationMs, stdout, stderr }),
      );
    } finally {
      if (workDir) {
        fs.rm(workDir, { recursive: true, force: true }).catch(() => {
          /* best-effort cleanup — a leftover scratch dir is untidy, not unsafe */
        });
      }
    }
  })
  .listen(GH_PROXY_PORT || 3003, () => {
    console.log(
      new Date().toISOString(),
      `gh-proxy listening on :${GH_PROXY_PORT || 3003}`,
    );
  });
