#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALID_FIXTURE="$ROOT_DIR/scripts/smoke/pi-runtime-smoke-hooks.yaml"
INVALID_FIXTURE="$ROOT_DIR/scripts/smoke/pi-runtime-smoke-invalid-hooks.yaml"
MODE="manual"
MANUAL_DIR=""

case "${1:-}" in
  --automated)
    MODE="automated"
    shift
    ;;
  --manual)
    shift
    MANUAL_DIR="${1:-}"
    ;;
  -h|--help)
    cat <<'EOF'
Usage:
  bash scripts/smoke/pi-runtime-smoke.sh --automated
  bash scripts/smoke/pi-runtime-smoke.sh [--manual] [smoke-directory]

--automated packs the package, installs it through Pi's native package/settings
flow in an isolated HOME, drives RPC and PTY sessions, asserts runtime evidence,
and removes all temporary state. Manual mode prepares an isolated project and a
checklist without modifying the real Pi configuration.
EOF
    exit 0
    ;;
  "")
    ;;
  *)
    MANUAL_DIR="$1"
    ;;
esac

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_dir() {
  [[ -d "$1" ]] || fail "expected directory: $1"
}

assert_contains() {
  local file="$1"
  local needle="$2"
  grep -F -- "$needle" "$file" >/dev/null 2>&1 || fail "expected $(printf '%q' "$needle") in $file"
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -F -- "$needle" "$file" >/dev/null 2>&1; then
    fail "unexpected $(printf '%q' "$needle") in $file"
  fi
}

assert_not_contains_regex() {
  local file="$1"
  local pattern="$2"
  if grep -E -- "$pattern" "$file" >/dev/null 2>&1; then
    fail "unexpected pattern $(printf '%q' "$pattern") in $file"
  fi
}

json_array_contains_path() {
  node --input-type=module - "$1" "$2" <<'NODE'
import fs from "node:fs";
const [file, expected] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(value) || !value.includes(expected)) process.exit(1);
NODE
}

parse_fixtures() {
  node --input-type=module - "$VALID_FIXTURE" "$INVALID_FIXTURE" <<'NODE'
import fs from "node:fs";
import YAML from "yaml";
for (const file of process.argv.slice(2)) YAML.parse(fs.readFileSync(file, "utf8"));
NODE
}

prepare_manual() {
  require_command node
  require_command pi
  local smoke_dir="${MANUAL_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pi-yaml-hooks-runtime-manual.XXXXXX")}"
  local isolated_home="$smoke_dir/home"
  local project_dir="$smoke_dir/project"
  local agent_dir="$isolated_home/.pi/agent"
  local hook_dir="$project_dir/.pi/hook"
  local evidence_dir="$project_dir/.pi/hooks-smoke"
  mkdir -p "$agent_dir/hook" "$hook_dir" "$evidence_dir" "$smoke_dir/artifact"
  cp "$VALID_FIXTURE" "$hook_dir/hooks.yaml"
  parse_fixtures

  cat > "$evidence_dir/evidence.md" <<EOF
# pi-yaml-hooks manual runtime smoke evidence

- Checkout: $ROOT_DIR
- Isolated HOME: $isolated_home
- Isolated Pi agent dir: $agent_dir
- Smoke project: $project_dir
- Project hooks: $hook_dir/hooks.yaml
- Trust store: $agent_dir/trusted-projects.json
- Default log: $agent_dir/logs/pi-yaml-hooks.ndjson
- Override log: $evidence_dir/override.ndjson

## Native packed-package flow

Run from the checkout, record the tarball path, and install it into the isolated
Pi settings. The package must appear in both \`pi list\` and
\`$agent_dir/settings.json\`.

\`\`\`bash
HOME="$isolated_home" USERPROFILE="$isolated_home" npm_config_cache="$smoke_dir/npm-cache" npm pack --pack-destination "$smoke_dir/artifact"
HOME="$isolated_home" USERPROFILE="$isolated_home" PI_CODING_AGENT_DIR="$agent_dir" \\
  pi install "npm:pi-yaml-hooks@file:$smoke_dir/artifact/<packed-tarball>.tgz"
HOME="$isolated_home" USERPROFILE="$isolated_home" PI_CODING_AGENT_DIR="$agent_dir" pi list
\`\`\`

Start Pi from \`$project_dir\` first without a trust entry and confirm that the
project hook file is rejected. Run \`/hooks-trust\`, restart Pi, then exercise
\`/hooks-status\`, \`/hooks-validate\`, \`/hooks-reload\`, and
\`/hooks-tail-log --path\`. Enable user bash only in the isolated process:

\`\`\`bash
cd "$project_dir"
HOME="$isolated_home" USERPROFILE="$isolated_home" PI_CODING_AGENT_DIR="$agent_dir" \\
PI_YAML_HOOKS_DEBUG=1 PI_YAML_HOOKS_ENABLE_USER_BASH=1 pi --offline
\`\`\`

Record tool before/after/file.changed events, session lifecycle events, prompt
awareness, diagnostics, UI confirmation/notification/status actions, and TUI
autocomplete. Temporarily replace the project hooks with
\`$INVALID_FIXTURE\` to verify structured validation, then restore the valid
fixture. Delete \`$smoke_dir\` when evidence collection is complete.
EOF

  cat <<EOF
Prepared manual Pi runtime smoke without touching the real Pi configuration.

Smoke root:       $smoke_dir
Isolated HOME:    $isolated_home
Pi agent dir:     $agent_dir
Project:          $project_dir
Project hooks:    $hook_dir/hooks.yaml
Evidence:         $evidence_dir/evidence.md

Follow the native packed-package flow in the evidence file. No explicit
extension path is used.
EOF
}

snapshot_pi_mutation_surfaces() {
  node --input-type=module - "$1" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const home = process.argv[2];
const targets = [
  path.join(home, ".pi", "agent", "settings.json"),
  path.join(home, ".pi", "agent", "trusted-projects.json"),
  path.join(home, ".pi", "agent", "npm", "node_modules", "pi-yaml-hooks"),
  path.join(home, ".pi", "agent", "logs", "pi-yaml-hooks.ndjson"),
  path.join(home, ".npm", "_logs"),
  path.join(home, ".npm", "_update-notifier-last-checked"),
];
const hash = crypto.createHash("sha256");
function add(target, relative = "") {
  let stat;
  try { stat = fs.lstatSync(target); } catch { hash.update(`missing:${relative}\n`); return; }
  hash.update(`${relative}:${stat.mode}:${stat.size}:${stat.mtimeMs}\n`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) add(path.join(target, name), path.join(relative, name));
  } else if (stat.isFile()) {
    hash.update(fs.readFileSync(target));
  } else if (stat.isSymbolicLink()) {
    hash.update(fs.readlinkSync(target));
  }
}
for (const target of targets) add(target, target.slice(home.length));
process.stdout.write(hash.digest("hex"));
NODE
}

write_rpc_driver() {
  cat > "$1" <<'NODE'
import fs from "node:fs";
import { spawn } from "node:child_process";

const [piBin, projectDir, transcriptPath, stderrPath, mode, sessionDir, eventsPath] = process.argv.slice(2);
const transcript = fs.createWriteStream(transcriptPath, { flags: "a" });
const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
const child = spawn(piBin, [
  "--mode", "rpc",
  "--offline",
  "--provider", "smoke",
  "--model", "smoke-model",
  "--api-key", "smoke-key",
  "--session-dir", sessionDir,
  "--no-context-files",
], { cwd: projectDir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });

let nextId = 0;
let stdoutBuffer = "";
const pending = new Map();
const observed = [];
let exited = false;
let exitCode = null;
let exitSignal = null;

function writeMessage(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function handleLine(line) {
  if (!line.trim()) return;
  transcript.write(`${line}\n`);
  let message;
  try { message = JSON.parse(line); } catch { return; }
  observed.push(message);
  if (message.type === "extension_ui_request" && message.method === "confirm") {
    writeMessage({ type: "extension_ui_response", id: message.id, confirmed: true });
  } else if (message.type === "extension_ui_request" && ["select", "input", "editor"].includes(message.method)) {
    writeMessage({ type: "extension_ui_response", id: message.id, cancelled: true });
  }
  if (message.type === "response" && message.id && pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    if (message.success) resolve(message);
    else reject(new Error(`${message.command}: ${message.error}`));
  }
}

child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  for (;;) {
    const index = stdoutBuffer.indexOf("\n");
    if (index < 0) break;
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    handleLine(line);
  }
});
child.stderr.on("data", (chunk) => stderr.write(chunk));
child.on("exit", (code, signal) => {
  exited = true;
  exitCode = code;
  exitSignal = signal;
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(`pi exited before RPC response (code=${code}, signal=${signal})`));
  }
  pending.clear();
});
child.on("error", (error) => {
  stderr.write(`${error.stack ?? error}\n`);
});

function rpc(type, payload = {}) {
  const id = `smoke-${++nextId}`;
  const message = { id, type, ...payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${type}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    writeMessage(message);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function countExactEvent(eventName) {
  let text;
  try {
    text = fs.readFileSync(eventsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  return text.trim().split("\n").filter(Boolean).reduce((count, line, index) => {
    let row;
    try { row = JSON.parse(line); }
    catch (error) { throw new Error(`invalid event NDJSON row ${index + 1}: ${error.message}`); }
    return count + (row?.event === eventName ? 1 : 0);
  }, 0);
}
async function waitForNewExactEvent(eventName, previousCount, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = countExactEvent(eventName);
    if (count > previousCount) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for new exact ${eventName} NDJSON row after count=${previousCount}`);
}
async function waitUntilIdle() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await rpc("get_state");
    if (!response.data.isStreaming && response.data.pendingMessageCount === 0) {
      await sleep(500);
      return;
    }
    await sleep(100);
  }
  throw new Error("Pi did not become idle");
}
async function slash(message) {
  await rpc("prompt", { message });
  await sleep(150);
}
async function shutdown() {
  child.stdin.end();
  for (let attempt = 0; attempt < 50 && !exited; attempt += 1) await sleep(100);
  if (!exited) {
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 20 && !exited; attempt += 1) await sleep(100);
    if (!exited) child.kill("SIGKILL");
    throw new Error("Pi RPC process did not exit after stdin closed");
  }
  transcript.end();
  stderr.end();
  if (exitSignal !== null || exitCode !== 0) {
    throw new Error(`Pi RPC process exited unexpectedly (code=${exitCode}, signal=${exitSignal})`);
  }
}

try {
  if (mode === "untrusted") {
    await rpc("get_commands");
    await slash("/hooks-status");
    await slash("/hooks-validate");
    await slash("/hooks-trust");
  } else if (mode === "trusted") {
    await rpc("get_commands");
    await slash("/hooks-status");
    await slash("/hooks-validate");
    await slash("/hooks-tail-log --path");
    await slash("/hooks-reload");
    await slash("/hooks-status");
    await rpc("bash", { command: "printf 'rpc-bash\\n' > .pi/hooks-smoke/rpc-bash.txt" });
    const idleRowsBeforePrompt = countExactEvent("session.idle");
    await rpc("prompt", { message: "Run the deterministic runtime smoke tool sequence now." });
    await waitUntilIdle();
    await waitForNewExactEvent("session.idle", idleRowsBeforePrompt);
    const newSession = await rpc("new_session");
    if (newSession.data.cancelled !== false) throw new Error(`new_session cancelled: ${JSON.stringify(newSession.data)}`);
    await sleep(500);
  } else if (mode === "invalid") {
    await rpc("get_commands");
    await slash("/hooks-validate");
    await slash("/hooks-status");
  } else if (mode === "override") {
    await rpc("get_commands");
    await slash("/hooks-status");
    await slash("/hooks-tail-log --path");
    await slash("/hooks-validate");
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  await shutdown();
} catch (error) {
  stderr.write(`${error.stack ?? error}\n`);
  if (!exited) child.kill("SIGTERM");
  await sleep(250);
  process.exitCode = 1;
}
NODE
}

write_mock_server() {
  cat > "$1" <<'NODE'
import fs from "node:fs";
import http from "node:http";
const [portFile, requestLog] = process.argv.slice(2);
let completionCount = 0;
function chunk(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}
const server = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (part) => { body += part; });
  request.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body || "{}"); } catch { parsed = { raw: body }; }
    fs.appendFileSync(requestLog, `${JSON.stringify({ url: request.url, body: parsed })}\n`);
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    completionCount += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = { id: `smoke-${completionCount}`, object: "chat.completion.chunk", created: 1, model: "smoke-model" };
    if (completionCount === 1) {
      chunk(response, { ...base, choices: [{ index: 0, delta: {
        role: "assistant",
        tool_calls: [
          { index: 0, id: "smoke-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: ".pi/hooks-smoke/seed.txt" }) } },
          { index: 1, id: "smoke-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: ".pi/hooks-smoke/generated.txt", content: "generated by Pi runtime smoke\n" }) } },
          { index: 2, id: "smoke-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf 'model-bash\\n' > .pi/hooks-smoke/model-bash.txt" }) } },
        ],
      }, finish_reason: null }] });
      chunk(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      chunk(response, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Runtime smoke tool sequence complete." }, finish_reason: null }] });
      chunk(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(portFile, `${address.port}\n`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
NODE
}

write_pty_driver() {
  cat > "$1" <<'PY'
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

pi_bin, project_dir, raw_path, plain_path, session_dir = sys.argv[1:]
try:
    pid, fd = pty.fork()
except (AttributeError, OSError) as error:
    print(f"PTY unavailable: {error}", file=sys.stderr)
    sys.exit(75)
if pid == 0:
    os.chdir(project_dir)
    args = [pi_bin, "--offline", "--provider", "smoke", "--model", "smoke-model", "--api-key", "smoke-key", "--session-dir", session_dir, "--no-context-files"]
    os.execvpe(pi_bin, args, os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
os.set_blocking(fd, False)
data = bytearray()
def collect(seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        readable, _, _ = select.select([fd], [], [], 0.1)
        if fd in readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            data.extend(chunk)
collect(2.0)
os.write(fd, b"/hooks-st")
collect(1.0)
os.write(fd, b"\t")
collect(0.5)
os.write(fd, b"\r")
collect(0.5)
os.write(fd, b"\r")
collect(1.5)
os.write(fd, b"!printf 'tui-user-bash\\n' > .pi/hooks-smoke/tui-user-bash.txt")
os.write(fd, b"\r")
collect(1.0)
os.write(fd, b"\r")
user_bash_marker = os.path.join(project_dir, ".pi", "hooks-smoke", "tui-user-bash.txt")
for _ in range(25):
    collect(0.2)
    if os.path.isfile(user_bash_marker):
        break
os.write(fd, b"\x03")
collect(0.2)
os.write(fd, b"\x04")
collect(2.0)
waited = 0
status = 0
driver_terminated = False
try:
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited == 0:
        driver_terminated = True
        os.kill(pid, signal.SIGTERM)
        waited, status = os.waitpid(pid, 0)
except ChildProcessError:
    waited = pid
if driver_terminated:
    clean_exit = os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
    expected_signal = os.WIFSIGNALED(status) and os.WTERMSIG(status) == signal.SIGTERM
    if not clean_exit and not expected_signal:
        print(f"Pi TUI cleanup had unexpected wait status {status}", file=sys.stderr)
        sys.exit(1)
elif os.WIFSIGNALED(status):
    print(f"Pi TUI crashed from signal {os.WTERMSIG(status)}", file=sys.stderr)
    sys.exit(1)
elif os.WIFEXITED(status) and os.WEXITSTATUS(status) != 0:
    print(f"Pi TUI exited with status {os.WEXITSTATUS(status)}", file=sys.stderr)
    sys.exit(1)
raw = bytes(data)
with open(raw_path, "wb") as output:
    output.write(raw)
text = raw.decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
text = "".join(character for character in text if character in "\n\r\t" or ord(character) >= 32)
with open(plain_path, "w", encoding="utf-8") as output:
    output.write(text)
if "hooks-status" not in text or "Hooks status for" not in text:
    print("Tab completion did not execute /hooks-status", file=sys.stderr)
    sys.exit(1)
PY
}

run_automated() {
  require_command node
  require_command npm
  require_command pi
  require_command python3

  local real_home="${HOME:?HOME must be set}"
  local pi_bin
  pi_bin="$(command -v pi)"
  local smoke_root
  smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-yaml-hooks-pi-automated.XXXXXX")"
  smoke_root="$(cd "$smoke_root" && pwd -P)"
  local isolated_home="$smoke_root/home"
  local agent_dir="$isolated_home/.pi/agent"
  local project_dir="$smoke_root/project"
  local global_config="$agent_dir/hook/hooks.yaml"
  local project_config="$project_dir/.pi/hook/hooks.yaml"
  local evidence_dir="$project_dir/.pi/hooks-smoke"
  local artifact_dir="$smoke_root/artifact"
  local transcript_dir="$smoke_root/transcripts"
  local sessions_dir="$smoke_root/sessions"
  local default_log="$agent_dir/logs/pi-yaml-hooks.ndjson"
  local override_log="$evidence_dir/override-log.ndjson"
  local trust_file="$agent_dir/trusted-projects.json"
  local mock_pid=""
  local pass_count=0
  local interactive_row=""
  local cleanup_complete=0

  cleanup() {
    if [[ -n "$mock_pid" ]] && kill -0 "$mock_pid" >/dev/null 2>&1; then
      kill "$mock_pid" >/dev/null 2>&1 || true
      wait "$mock_pid" >/dev/null 2>&1 || true
    fi
    if [[ "$cleanup_complete" -eq 0 ]]; then
      rm -rf "$smoke_root"
    fi
  }
  trap cleanup EXIT INT TERM

  mkdir -p "$agent_dir/hook" "$(dirname "$project_config")" "$evidence_dir" "$artifact_dir" "$transcript_dir" "$sessions_dir"
  printf 'seed for Pi read tool\n' > "$evidence_dir/seed.txt"
  cp "$VALID_FIXTURE" "$project_config"
  cat > "$global_config" <<'YAML'
hooks:
  - id: smoke-global-session-created
    event: session.created
    actions:
      - notify:
          text: "pi-yaml-hooks global smoke loaded"
          level: info
      - bash: |
          mkdir -p .pi/hooks-smoke
          printf '{"event":"global.session.created","session":"%s"}\n' "$PI_SESSION_ID" >> .pi/hooks-smoke/events.ndjson
YAML
  parse_fixtures

  local real_home_before
  local real_home_after
  real_home_before="$(snapshot_pi_mutation_surfaces "$real_home")"

  local pack_json="$transcript_dir/npm-pack.json"
  (
    cd "$ROOT_DIR"
    HOME="$isolated_home" USERPROFILE="$isolated_home" npm_config_cache="$smoke_root/npm-cache" \
      npm_config_userconfig="$smoke_root/npmrc" npm pack --json --pack-destination "$artifact_dir"
  ) > "$pack_json"
  local packed_name
  local packed_version
  local tarball_name
  local packed_integrity
  IFS=$'\t' read -r packed_name packed_version tarball_name packed_integrity < <(node --input-type=module - "$pack_json" <<'NODE'
import fs from "node:fs";
const parsed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const item = Array.isArray(parsed) ? parsed[0] : undefined;
if (!item?.name || !item?.version || !item?.filename || !item?.integrity) process.exit(1);
process.stdout.write([item.name, item.version, item.filename, item.integrity].join("\t") + "\n");
NODE
)
  local tarball="$artifact_dir/$tarball_name"
  assert_file "$tarball"
  local package_source="npm:pi-yaml-hooks@file:$tarball"
  local install_out="$transcript_dir/pi-install.txt"
  (
    cd "$project_dir"
    HOME="$isolated_home" USERPROFILE="$isolated_home" PI_CODING_AGENT_DIR="$agent_dir" \
      "$pi_bin" install "$package_source"
  ) > "$install_out" 2>&1
  assert_contains "$install_out" "Installed $package_source"
  local list_out="$transcript_dir/pi-list.txt"
  (
    cd "$project_dir"
    HOME="$isolated_home" USERPROFILE="$isolated_home" PI_CODING_AGENT_DIR="$agent_dir" \
      "$pi_bin" list
  ) > "$list_out" 2>&1
  assert_contains "$list_out" "$package_source"
  local installed_package="$agent_dir/npm/node_modules/pi-yaml-hooks"
  assert_dir "$installed_package"
  assert_file "$installed_package/package.json"
  local installed_name
  local installed_version
  read -r installed_name installed_version < <(node --input-type=module - "$installed_package/package.json" <<'NODE'
import fs from "node:fs";
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!manifest.name || !manifest.version) process.exit(1);
process.stdout.write(`${manifest.name} ${manifest.version}\n`);
NODE
)
  [[ "$packed_name" == "pi-yaml-hooks" && "$installed_name" == "$packed_name" ]] || fail "packed/installed package name mismatch"
  [[ "$installed_version" == "$packed_version" ]] || fail "packed/installed package version mismatch"
  local root_version
  root_version="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
  [[ "$packed_version" == "$root_version" ]] || fail "packed version does not match checkout package.json"
  local artifact_sha256
  artifact_sha256="$(node --input-type=module - "$tarball" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"));
NODE
)"
  [[ ${#artifact_sha256} -eq 64 ]] || fail "packed artifact SHA-256 is not exact"
  assert_file "$agent_dir/settings.json"
  assert_contains "$agent_dir/settings.json" "$package_source"
  if grep -R -E -- '(^|[[:space:]])-e([[:space:]]|$)|--extension' "$agent_dir/settings.json" "$transcript_dir/pi-install.txt" "$transcript_dir/pi-list.txt" >/dev/null 2>&1; then
    fail "native install evidence contains an explicit extension flag"
  fi

  local pi_version
  local coding_agent_version
  local tui_version
  local node_version
  pi_version="$($pi_bin --version 2>&1 | sed -n '1p')"
  node_version="$(node --version)"
  read -r coding_agent_version tui_version < <(node --input-type=module - "$pi_bin" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const realPi = fs.realpathSync(process.argv[2]);
const codingPackage = path.join(path.dirname(realPi), "..", "package.json");
const coding = JSON.parse(fs.readFileSync(codingPackage, "utf8"));
const require = createRequire(codingPackage);
const tuiEntry = require.resolve("@earendil-works/pi-tui");
let cursor = path.dirname(tuiEntry);
let tui;
for (;;) {
  const candidate = path.join(cursor, "package.json");
  if (fs.existsSync(candidate)) {
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    if (parsed.name === "@earendil-works/pi-tui") { tui = parsed; break; }
  }
  const parent = path.dirname(cursor);
  if (parent === cursor) break;
  cursor = parent;
}
if (!coding.version || !tui?.version) process.exit(1);
process.stdout.write(`${coding.version} ${tui.version}\n`);
NODE
)
  [[ -n "$pi_version" && "$pi_version" != *unknown* ]] || fail "Pi version is not exact"
  [[ -n "$coding_agent_version" && -n "$tui_version" ]] || fail "SDK versions are not exact"
  [[ "$node_version" == v* ]] || fail "Node version is not exact"

  local mock_server="$smoke_root/mock-server.mjs"
  local mock_port_file="$smoke_root/mock-port"
  local mock_requests="$transcript_dir/mock-requests.ndjson"
  write_mock_server "$mock_server"
  node "$mock_server" "$mock_port_file" "$mock_requests" > "$transcript_dir/mock-server.stdout" 2> "$transcript_dir/mock-server.stderr" &
  mock_pid=$!
  local wait_attempt
  for wait_attempt in $(seq 1 100); do
    [[ -s "$mock_port_file" ]] && break
    kill -0 "$mock_pid" >/dev/null 2>&1 || fail "mock model server exited before readiness"
    sleep 0.05
  done
  assert_file "$mock_port_file"
  local mock_port
  mock_port="$(tr -d '[:space:]' < "$mock_port_file")"
  [[ "$mock_port" =~ ^[0-9]+$ ]] || fail "invalid mock server port: $mock_port"
  cat > "$agent_dir/models.json" <<EOF
{
  "providers": {
    "smoke": {
      "baseUrl": "http://127.0.0.1:$mock_port/v1",
      "api": "openai-completions",
      "apiKey": "smoke-key",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "smoke-model", "name": "Pi Runtime Smoke Model" }
      ]
    }
  }
}
EOF

  local rpc_driver="$smoke_root/rpc-driver.mjs"
  write_rpc_driver "$rpc_driver"
  local common_env=(
    HOME="$isolated_home"
    USERPROFILE="$isolated_home"
    PI_CODING_AGENT_DIR="$agent_dir"
    PI_YAML_HOOKS_DEBUG=1
    PI_YAML_HOOKS_ENABLE_USER_BASH=1
    PI_OFFLINE=1
    TERM=xterm-256color
  )

  local events_file="$evidence_dir/events.ndjson"
  local untrusted_rpc="$transcript_dir/untrusted-rpc.ndjson"
  local untrusted_err="$transcript_dir/untrusted-stderr.txt"
  env "${common_env[@]}" node "$rpc_driver" "$pi_bin" "$project_dir" "$untrusted_rpc" "$untrusted_err" untrusted "$sessions_dir/untrusted" "$events_file"
  assert_contains "$untrusted_err" "Skipping untrusted project hooks"
  assert_contains "$untrusted_rpc" "Project trusted: no"
  assert_contains "$untrusted_rpc" "Project hooks exist but are not active"
  assert_contains "$untrusted_rpc" "Project hook file is valid but untrusted"
  assert_contains "$untrusted_rpc" "hooks-status"
  assert_file "$events_file"
  local untrusted_events="$transcript_dir/untrusted-events.ndjson"
  cp "$events_file" "$untrusted_events"
  assert_contains "$untrusted_events" '"event":"global.session.created"'
  assert_not_contains "$untrusted_events" '"event":"session.created"'
  assert_file "$trust_file"
  local canonical_project
  canonical_project="$(cd "$project_dir" && pwd -P)"
  json_array_contains_path "$trust_file" "$canonical_project" || fail "trust file does not explicitly approve $canonical_project"

  local trusted_rpc="$transcript_dir/trusted-rpc.ndjson"
  local trusted_err="$transcript_dir/trusted-stderr.txt"
  env "${common_env[@]}" node "$rpc_driver" "$pi_bin" "$project_dir" "$trusted_rpc" "$trusted_err" trusted "$sessions_dir/trusted" "$events_file"
  assert_contains "$trusted_rpc" "Project trusted: yes"
  assert_contains "$trusted_rpc" "$global_config"
  assert_contains "$trusted_rpc" "$project_config"
  assert_contains "$trusted_rpc" "Active hooks are valid"
  assert_contains "$trusted_rpc" "$default_log"
  assert_contains "$trusted_rpc" "Reloading PI extensions"
  assert_contains "$trusted_rpc" "pi-yaml-hooks-diagnostics"
  assert_contains "$trusted_rpc" '"method":"confirm"'
  assert_contains "$trusted_rpc" '"method":"notify"'
  assert_contains "$trusted_rpc" '"method":"setStatus"'
  assert_contains "$trusted_rpc" '"command":"new_session"'
  assert_contains "$trusted_rpc" '"cancelled":false'
  assert_file "$default_log"
  assert_file "$evidence_dir/rpc-bash.txt"
  assert_file "$evidence_dir/generated.txt"
  assert_file "$evidence_dir/model-bash.txt"
  assert_contains "$mock_requests" "pi-yaml-hooks loaded"
  assert_contains "$mock_requests" "$global_config"
  assert_contains "$mock_requests" "$project_config"

  assert_file "$events_file"
  local event_sequence
  event_sequence="$(node --input-type=module - "$events_file" <<'NODE'
import fs from "node:fs";

function parseNdjson(text, source) {
  return text.trim().split("\n").filter(Boolean).map((line, index) => {
    try {
      const row = JSON.parse(line);
      if (!row || Array.isArray(row) || typeof row !== "object") throw new Error("row is not an object");
      return row;
    } catch (error) {
      throw new Error(`${source} row ${index + 1} is not valid object NDJSON: ${error.message}`);
    }
  });
}

function validateEventRows(rows) {
  const requiredEvents = [
    "global.session.created",
    "session.created",
    "tool.before.bash",
    "tool.after.read",
    "tool.after.write",
    "file.changed",
    "session.idle",
    "session.deleted",
  ];
  for (const event of requiredEvents) {
    if (!rows.some((row) => row.event === event)) throw new Error(`missing separate exact event row: ${event}`);
  }

  const sessionFor = (row) => typeof row.session === "string" && row.session.length > 0 ? row.session : undefined;
  for (const row of rows.filter((candidate) =>
    ["global.session.created", "session.created", "tool.after.read", "file.changed", "session.idle", "session.deleted"].includes(candidate.event))) {
    if (!sessionFor(row)) throw new Error(`event row is missing session correlation: ${JSON.stringify(row)}`);
  }
  const beforeRows = rows.filter((row) => row.event === "tool.before.bash");
  if (!beforeRows.some((row) => typeof row.tool_args?.command === "string")) {
    throw new Error(`tool.before.bash rows lack structured bash tool_args: ${JSON.stringify(beforeRows)}`);
  }
  const afterWriteRows = rows.filter((row) => row.event === "tool.after.write");
  if (!afterWriteRows.some((row) => Array.isArray(row.changes) && Array.isArray(row.files))) {
    throw new Error(`tool.after.write rows lack structured changes/files: ${JSON.stringify(afterWriteRows)}`);
  }

  const createdSessions = [...new Set(rows.filter((row) => row.event === "session.created").map(sessionFor).filter(Boolean))];
  if (createdSessions.length < 2) throw new Error(`expected startup and new-session creation, got ${JSON.stringify(createdSessions)}`);
  const lifecycle = createdSessions.map((session) => {
    const created = rows.findIndex((row) => row.event === "session.created" && row.session === session);
    const globalCreated = rows.findIndex((row) => row.event === "global.session.created" && row.session === session);
    const idle = rows.findIndex((row) => row.event === "session.idle" && row.session === session);
    const deletionIndexes = rows
      .map((row, index) => row.event === "session.deleted" && row.session === session ? index : -1)
      .filter((index) => index >= 0);
    const deletedAfterIdle = deletionIndexes.find((index) => idle >= 0 && index > idle);
    const deleted = deletedAfterIdle ?? deletionIndexes.find((index) => index > created) ?? -1;
    return { session, globalCreated, created, idle, deleted, deletionIndexes };
  });
  const active = lifecycle.find(({ globalCreated, created, idle, deleted }) =>
    globalCreated >= 0 && globalCreated < created && created < idle && idle < deleted);
  if (!active) throw new Error(`no session has correlated global/create/idle/delete ordering: ${JSON.stringify(lifecycle)}`);
  for (const { session, created, deleted } of lifecycle) {
    if (deleted < created) throw new Error(`created session was not deleted in order: ${JSON.stringify({ session, created, deleted })}`);
  }

  const orderedToolIndex = (event, predicate = () => true, after = active.created) =>
    rows.findIndex((row, index) => index > after && index < active.idle && row.event === event && predicate(row));
  const before = orderedToolIndex("tool.before.bash", (row) => typeof row.tool_args?.command === "string");
  const afterRead = orderedToolIndex("tool.after.read", (row) => row.session === active.session);
  const afterWrite = orderedToolIndex("tool.after.write", (row) => Array.isArray(row.changes) && Array.isArray(row.files));
  const fileChanged = orderedToolIndex("file.changed", (row) => row.session === active.session, before);
  if ([before, afterRead, afterWrite, fileChanged].some((index) => index < 0)) {
    throw new Error(`tool/file rows lack created-before-tools-before-idle order: ${JSON.stringify({ active, before, afterRead, afterWrite, fileChanged })}`);
  }
  return `session=${active.session};global=${active.globalCreated};created=${active.created};before=${before};afterRead=${afterRead};afterWrite=${afterWrite};fileChanged=${fileChanged};idle=${active.idle};deleted=${active.deleted}`;
}

let combinedRowRejected = false;
try {
  validateEventRows([{
    event: "global.session.created session.created tool.before.bash tool.after.read tool.after.write file.changed session.idle session.deleted",
    session: "combined-fake",
    tool_args: { command: "fake" },
    changes: [],
    files: [],
  }]);
} catch {
  combinedRowRejected = true;
}
if (!combinedRowRejected) throw new Error("negative self-check failed: one combined row faked distinct structured evidence");

const rows = parseNdjson(fs.readFileSync(process.argv[2], "utf8"), process.argv[2]);
process.stdout.write(`${validateEventRows(rows)};combined-row=REJECTED`);
NODE
)"

  cp "$INVALID_FIXTURE" "$project_config"
  local invalid_rpc="$transcript_dir/invalid-rpc.ndjson"
  local invalid_err="$transcript_dir/invalid-stderr.txt"
  env "${common_env[@]}" node "$rpc_driver" "$pi_bin" "$project_dir" "$invalid_rpc" "$invalid_err" invalid "$sessions_dir/invalid" "$events_file"
  assert_contains "$invalid_rpc" "Project hook errors"
  assert_contains "$invalid_rpc" "command: actions are not supported on PI"
  assert_contains "$invalid_rpc" "pi-yaml-hooks-diagnostics"
  cp "$VALID_FIXTURE" "$project_config"

  local override_rpc="$transcript_dir/override-rpc.ndjson"
  local override_err="$transcript_dir/override-stderr.txt"
  env "${common_env[@]}" PI_YAML_HOOKS_LOG_FILE="$override_log" \
    node "$rpc_driver" "$pi_bin" "$project_dir" "$override_rpc" "$override_err" override "$sessions_dir/override" "$events_file"
  assert_contains "$override_rpc" "$override_log"
  assert_contains "$override_rpc" "Active hooks are valid"
  assert_file "$override_log"

  local combined_host_output="$transcript_dir/combined-host-output.txt"
  cat "$untrusted_rpc" "$untrusted_err" "$trusted_rpc" "$trusted_err" "$invalid_rpc" "$invalid_err" "$override_rpc" "$override_err" > "$combined_host_output"
  assert_not_contains_regex "$combined_host_output" 'Failed to load extension|Error loading extension|Cannot load extension|ERR_MODULE_NOT_FOUND|SyntaxError.*extensions/pi-yaml-hooks'

  local pty_driver="$smoke_root/pty-driver.py"
  local pty_raw="$transcript_dir/pi-tui.raw"
  local pty_plain="$transcript_dir/pi-tui.txt"
  write_pty_driver "$pty_driver"
  set +e
  env "${common_env[@]}" python3 "$pty_driver" "$pi_bin" "$project_dir" "$pty_raw" "$pty_plain" "$sessions_dir/tui" 2> "$transcript_dir/pi-tui.stderr"
  local pty_exit=$?
  set -e
  if [[ "$pty_exit" -eq 75 ]]; then
    interactive_row="BLOCKED: platform PTY unavailable ($(tr '\n' ' ' < "$transcript_dir/pi-tui.stderr"))"
  elif [[ "$pty_exit" -ne 0 ]]; then
    fail "Pi TUI assertion failed: $(tr '\n' ' ' < "$transcript_dir/pi-tui.stderr")"
  else
    assert_contains "$pty_plain" "hooks-status"
    assert_file "$evidence_dir/tui-user-bash.txt"
    assert_contains "$events_file" "tui-user-bash"
    interactive_row="PASS: PTY/TUI completed /hooks-st to /hooks-status"
  fi

  real_home_after="$(snapshot_pi_mutation_surfaces "$real_home")"
  [[ "$real_home_before" == "$real_home_after" ]] || fail "real HOME Pi mutation surfaces changed"

  pass_count=$((pass_count + 1))
  printf 'A23P PASS — packed artifact installed by native Pi package/settings flow; package=%s@%s sha256=%s source=%s installed=%s\n' "$packed_name" "$packed_version" "$artifact_sha256" "$package_source" "$installed_package"
  pass_count=$((pass_count + 1))
  printf 'A24P PASS — commands, trust, configs, logs, tools, lifecycle, user_bash, prompt, diagnostics, and UI evidence asserted\n'
  printf 'A24P INTERACTIVE %s\n' "$interactive_row"

  if [[ -n "$mock_pid" ]] && kill -0 "$mock_pid" >/dev/null 2>&1; then
    kill "$mock_pid" >/dev/null 2>&1 || true
    wait "$mock_pid" >/dev/null 2>&1 || true
  fi
  mock_pid=""
  rm -rf "$smoke_root"
  cleanup_complete=1
  trap - EXIT INT TERM
  [[ ! -e "$smoke_root" ]] || fail "temporary smoke root remains after cleanup: $smoke_root"
  [[ "$real_home_before" == "$real_home_after" ]] || fail "real HOME changed"

  pass_count=$((pass_count + 1))
  printf 'A25P PASS — cleanup removed temp HOME/install/processes; real_HOME_snapshot=%s temp_removed=%s\n' "$real_home_after" "$smoke_root"
  pass_count=$((pass_count + 1))
  printf 'A26P PASS — package=%s@%s Pi=%s SDK(pi-coding-agent)=%s SDK(pi-tui)=%s Node=%s\n' "$packed_name" "$packed_version" "$pi_version" "$coding_agent_version" "$tui_version" "$node_version"
  printf 'EVIDENCE paths: global=%s project=%s trust=%s default_log=%s override_log=%s events=%s\n' \
    "$global_config" "$project_config" "$trust_file" "$default_log" "$override_log" "$events_file"
  printf 'EVIDENCE events: %s; names=global.session.created,session.created,tool.before.bash,tool.after.read,tool.after.write,file.changed,session.idle,session.deleted\n' "$event_sequence"
  printf 'PASS count: %d/4 acceptance rows; cleanup proof: %s absent; real HOME mutation surfaces unchanged\n' "$pass_count" "$smoke_root"
}

if [[ "$MODE" == "automated" ]]; then
  run_automated
else
  prepare_manual
fi
