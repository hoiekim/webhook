const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const { GH_PROXY_PORT, GH_PROXY_TIMEOUT_MS } = process.env;

// Response size caps.
const BODY_MAX = 64 * 1024; // request body bytes accepted
const OUTPUT_MAX = 256 * 1024; // stdout/stderr characters surfaced per response
const EXEC_MAX_BUFFER = 8 * 1024 * 1024; // child stdio buffer per stream — `gh`
// output (JSON listings, diffs) runs larger than a typical deploy command's.
const COMMAND_TIMEOUT_MS = Number(GH_PROXY_TIMEOUT_MS) || 2 * 60 * 1000; // most
// `gh` calls are a single API round-trip; 2 min covers a slow one (a large
// `gh pr diff`, a paginated list) without leaving a hung call tying up this
// process indefinitely. Override via GH_PROXY_TIMEOUT_MS for a caller that
// legitimately needs longer (e.g. `gh repo clone` of something large).

// The caller's own token stands in for a shared server secret: there is
// nothing else to compare it against — a request with no bearer token, or
// one carrying an invalid/revoked token, fails the same way running `gh`
// locally without `GH_TOKEN` set would, when the underlying `gh` call hits
// the GitHub API. That also means this process is exactly as powerful as
// whatever the caller's token can already do, no more.
function extractToken(req) {
  const raw = req.headers["authorization"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1].trim() : null;
}

// Splits a command string into argv the way a shell's word-splitting does
// (quotes group a token, a backslash escapes the next character), but never
// invokes a shell — the result is handed to `execFile` as a literal argument
// array. That is what makes an arbitrary caller-supplied string safe here:
// there is no shell to interpret `;`, `&&`, `|`, `$(...)` or backticks, so a
// command string containing them just becomes literal (and almost always
// invalid) `gh` arguments instead of a second command.
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
      if (args.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "empty command" }));
        return;
      }

      // Drop any ambient GH_TOKEN/GITHUB_TOKEN this process itself was
      // started with before setting the caller's — otherwise a host-level
      // token could silently win if the caller's own token were ever
      // empty, and two different auth sources would be in play at once.
      const env = { ...process.env, GH_TOKEN: token };
      delete env.GITHUB_TOKEN;
      delete env.GH_ENTERPRISE_TOKEN;

      // Log the parsed argv, never the raw command string or token — argv
      // is enough to audit what ran, and re-logging `command` would just
      // duplicate it since splitCommand doesn't alter well-formed input.
      const { stdout, stderr } = await execFileAsync("gh", args, {
        env,
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      const durationMs = Date.now() - startedAt;
      console.log(
        new Date().toISOString(),
        "gh OK",
        JSON.stringify({ durationMs, args }),
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
    }
  })
  .listen(GH_PROXY_PORT || 3003, () => {
    console.log(
      new Date().toISOString(),
      `gh-proxy listening on :${GH_PROXY_PORT || 3003}`,
    );
  });
