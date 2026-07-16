#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALID_FIXTURE="$ROOT_DIR/scripts/smoke/omp-runtime-smoke-hooks.yaml"
INVALID_FIXTURE="$ROOT_DIR/scripts/smoke/omp-runtime-smoke-invalid-hooks.yaml"
PROFILE="omp-runtime-smoke"
SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-yaml-hooks-omp-runtime.XXXXXX")"
HOME_DIR="$SMOKE_ROOT/home"
PROJECT_DIR="$SMOKE_ROOT/project"
PACK_DIR="$SMOKE_ROOT/pack"
AGENT_DIR="$HOME_DIR/.omp/profiles/$PROFILE/agent"
PLUGIN_DIR="$HOME_DIR/.omp/profiles/$PROFILE/plugins/node_modules/pi-yaml-hooks"
GLOBAL_CONFIG="$AGENT_DIR/hook/hooks.yaml"
PROJECT_CONFIG="$PROJECT_DIR/.omp/hook/hooks.yaml"
TRUST_FILE="$AGENT_DIR/trusted-projects.json"
LOG_FILE="$AGENT_DIR/logs/pi-yaml-hooks.ndjson"
EVENT_FILE="$PROJECT_DIR/.omp/hooks-smoke/events.ndjson"
RPC_TRANSCRIPT="$SMOKE_ROOT/rpc-frames.ndjson"
RPC_STDERR="$SMOKE_ROOT/rpc-stderr.log"
TUI_TRANSCRIPT="$SMOKE_ROOT/tui.log"
SERVER_PID=""
CLEANED=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT INT TERM

for command in omp bun npm node expect; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

OMP_VERSION="$(omp --version 2>&1 | sed -n '1p')"
BUN_VERSION="$(bun --version)"
PLUGIN_VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
[[ "$OMP_VERSION" == "omp/17.0.1" ]] || fail "expected omp/17.0.1, got $OMP_VERSION"

mkdir -p "$HOME_DIR" "$PROJECT_DIR/.omp/hook" "$PACK_DIR" "$AGENT_DIR/hook"
export HOME="$HOME_DIR"
export USERPROFILE="$HOME_DIR"
export OMP_PROFILE="$PROFILE"
unset PI_CODING_AGENT_DIR PI_PACKAGE_DIR PI_YAML_HOOKS_TRUST_PROJECT PI_YAML_HOOKS_ENABLE_USER_BASH PI_YAML_HOOKS_LOG_FILE

cp "$VALID_FIXTURE" "$PROJECT_CONFIG"
cat > "$GLOBAL_CONFIG" <<'YAML'
hooks:
  - id: omp-global-smoke
    event: session.created
    actions:
      - notify:
          text: "omp global smoke loaded"
          level: info
YAML

node --input-type=module - "$VALID_FIXTURE" "$INVALID_FIXTURE" <<'NODE'
import fs from "node:fs";
import YAML from "yaml";
for (const file of process.argv.slice(2)) YAML.parse(fs.readFileSync(file, "utf8"));
NODE

(
  cd "$ROOT_DIR"
  npm pack --pack-destination "$PACK_DIR" > "$SMOKE_ROOT/npm-pack.out"
)
TARBALL="$(find "$PACK_DIR" -maxdepth 1 -name 'pi-yaml-hooks-*.tgz' -print -quit)"
[[ -n "$TARBALL" && -f "$TARBALL" ]] || fail "npm pack did not create the plugin tarball"

cat > "$SMOKE_ROOT/server.ts" <<'SERVER'
const tarball = process.argv[2];
const readyFile = process.argv[3];
const requestFile = process.argv[4];
let tarballRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/pi-yaml-hooks.tgz") {
      tarballRequests += 1;
      await Bun.write(requestFile, String(tarballRequests));
      return new Response(Bun.file(tarball), { headers: { "content-type": "application/gzip" } });
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
});
await Bun.write(readyFile, String(server.port));
SERVER
bun "$SMOKE_ROOT/server.ts" "$TARBALL" "$SMOKE_ROOT/server.port" "$SMOKE_ROOT/server.requests" > "$SMOKE_ROOT/server.out" 2> "$SMOKE_ROOT/server.err" &
SERVER_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$SMOKE_ROOT/server.port" ]] && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "local tarball server exited before readiness"
  sleep 0.05
done
[[ -s "$SMOKE_ROOT/server.port" ]] || fail "local tarball server did not become ready"
SERVER_PORT="$(cat "$SMOKE_ROOT/server.port")"
PLUGIN_SPEC="pi-yaml-hooks@http://127.0.0.1:$SERVER_PORT/pi-yaml-hooks.tgz"

omp plugin install --dry-run "$PLUGIN_SPEC" --json > "$SMOKE_ROOT/install-dry-run.json"
omp plugin install "$PLUGIN_SPEC" --json > "$SMOKE_ROOT/install.json"
omp plugin list --json > "$SMOKE_ROOT/plugin-list.json"
[[ -s "$SMOKE_ROOT/server.requests" ]] || fail "normal plugin install did not fetch the served tarball"
[[ "$(cat "$SMOKE_ROOT/server.requests")" -ge 1 ]] || fail "local tarball request count was zero"

SMOKE_DRY="$SMOKE_ROOT/install-dry-run.json" \
SMOKE_INSTALL="$SMOKE_ROOT/install.json" \
SMOKE_LIST="$SMOKE_ROOT/plugin-list.json" \
SMOKE_PLUGIN_DIR="$PLUGIN_DIR" \
SMOKE_PLUGIN_VERSION="$PLUGIN_VERSION" \
bun --eval '
  import { readFileSync, realpathSync } from "node:fs";
  const dry = JSON.parse(readFileSync(process.env.SMOKE_DRY, "utf8"));
  const installed = JSON.parse(readFileSync(process.env.SMOKE_INSTALL, "utf8"));
  const listed = JSON.parse(readFileSync(process.env.SMOKE_LIST, "utf8"));
  const expectedPath = process.env.SMOKE_PLUGIN_DIR;
  const expectedVersion = process.env.SMOKE_PLUGIN_VERSION;
  const samePath = (actual) => realpathSync(actual) === realpathSync(expectedPath);
  if (!String(dry.name).startsWith("pi-yaml-hooks@http://127.0.0.1:")) throw new Error("dry-run did not use named HTTP tarball spec");
  if (installed.name !== "pi-yaml-hooks" || installed.version !== expectedVersion || !samePath(installed.path)) throw new Error(`unexpected install: ${JSON.stringify(installed)}`);
  if (JSON.stringify(installed.manifest?.extensions) !== JSON.stringify(["./extensions/omp-yaml-hooks/index.ts"])) throw new Error("native OMP manifest extension was not discovered");
  const plugin = listed.npm?.find((entry) => entry.name === "pi-yaml-hooks");
  if (!plugin || plugin.version !== expectedVersion || !samePath(plugin.path) || plugin.enabled !== true) throw new Error(`plugin list mismatch: ${JSON.stringify(listed)}`);
'

[[ -f "$PLUGIN_DIR/package.json" ]] || fail "installed plugin package.json is missing"
[[ ! -e "$HOME_DIR/.pi" && ! -e "$PROJECT_DIR/.pi" ]] || fail "legacy .pi state leaked into the isolated smoke"

cat > "$SMOKE_ROOT/rpc-driver.mjs" <<'RPC'
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const [home, profile, project, validFixture, invalidFixture, projectConfig, trustFile, logFile, transcript, stderrFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const normalizePathText = (value) => String(value).replaceAll("/private/var/", "/var/");

function startRpc(enableUserBash, confirmations = []) {
  const child = spawn("omp", ["--profile", profile, "--mode", "rpc", "--cwd", project, "--no-title"], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMP_PROFILE: profile,
      PI_YAML_HOOKS_DEBUG: "1",
      ...(enableUserBash ? { PI_YAML_HOOKS_ENABLE_USER_BASH: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = [];
  const waiters = [];
  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitCode;

  const settle = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      const match = frames.find(waiter.predicate);
      if (match) {
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        waiter.resolve(match);
      }
    }
  };

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    stdout += `${line}\n`;
    appendFileSync(transcript, `${line}\n`);
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    frames.push(frame);
    if (frame.type === "extension_ui_request" && frame.method === "confirm") {
      const confirmed = confirmations.shift();
      if (confirmed === undefined) throw new Error(`unexpected confirmation request: ${line}`);
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: frame.id, confirmed })}\n`);
    }
    settle();
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    appendFileSync(stderrFile, text);
  });
  child.on("close", (code) => {
    exited = true;
    exitCode = code;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`OMP RPC exited before ${waiter.label}; code=${code}`));
    }
  });

  const waitFor = (predicate, label, timeoutMs = 20000) => {
    const existing = frames.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (exited) return Promise.reject(new Error(`OMP RPC already exited before ${label}; code=${exitCode}`));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, label, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const prompt = async (id, message) => {
    send({ id, type: "prompt", message });
    const response = await waitFor((frame) => frame.type === "response" && frame.id === id, `${id} response`);
    assert(response.success === true && response.command === "prompt", `${id} prompt failed: ${JSON.stringify(response)}`);
    await waitFor((frame) => frame.type === "prompt_result" && frame.id === id && frame.agentInvoked === false, `${id} local completion`);
  };
  const close = async () => {
    child.stdin.end();
    if (!exited) await new Promise((resolve) => child.once("close", resolve));
    assert(exitCode === 0, `OMP RPC exit code was ${exitCode}`);
  };
  return { child, frames, get output() { return stdout + stderr; }, waitFor, send, prompt, close };
}

writeFileSync(transcript, "");
writeFileSync(stderrFile, "");
const first = startRpc(false);
await first.waitFor((frame) => frame.type === "ready", "first ready");
const commands = await first.waitFor((frame) => frame.type === "available_commands_update", "extension commands");
for (const name of ["hooks-status", "hooks-validate", "hooks-trust", "hooks-reload", "hooks-tail-log"]) {
  assert(commands.commands?.some((entry) => entry.name === name && entry.source === "extension"), `missing extension command ${name}`);
}
await first.prompt("status-untrusted", "/hooks-status");
assert(first.output.includes("Project trusted: no"), "hooks-status did not report the untrusted project");
const untrustedStatus = normalizePathText(first.output);
const missingStatusPaths = [projectConfig, trustFile, logFile].filter((file) => !untrustedStatus.includes(normalizePathText(file)));
assert(missingStatusPaths.length === 0, `hooks-status did not report native OMP paths; missing=${missingStatusPaths.join(",")}; output=${untrustedStatus}`);
await first.prompt("validate-untrusted", "/hooks-validate");
assert(/valid but untrusted/i.test(first.output), "hooks-validate did not explain valid-but-untrusted config");
await first.prompt("trust", "/hooks-trust");
assert(first.frames.some((frame) => frame.type === "extension_ui_request" && frame.method === "notify" && normalizePathText(frame.message).includes(normalizePathText(trustFile))), "hooks-trust notification is missing");
await first.prompt("status-trusted", "/hooks-status");
assert(first.output.includes("Project trusted: yes"), "trusted status was not observed");
await first.prompt("tail-log", "/hooks-tail-log --path");
assert(first.frames.some((frame) => frame.type === "extension_ui_request" && frame.method === "notify" && normalizePathText(frame.message) === normalizePathText(logFile)), "hooks-tail-log did not return the default OMP log path");

copyFileSync(invalidFixture, projectConfig);
const invalidStart = first.output.length;
await first.prompt("validate-invalid", "/hooks-validate");
assert(/command: actions are not supported|validation issue|invalid/i.test(first.output.slice(invalidStart)), "invalid config was not rejected by hooks-validate");
copyFileSync(validFixture, projectConfig);
const validStart = first.output.length;
await first.prompt("validate-valid", "/hooks-validate");
assert(/valid/i.test(first.output.slice(validStart)) && !/command: actions are not supported/i.test(first.output.slice(validStart)), "restored valid config did not validate");
await first.prompt("reload", "/hooks-reload");
await sleep(150);
assert(first.frames.some((frame) => frame.type === "extension_ui_request" && frame.method === "notify" && /Reloading PI extensions/.test(String(frame.message))), "hooks-reload notification is missing");

const optOutStart = first.frames.length;
first.send({ id: "bash-optout", type: "bash", command: "printf optout-ok" });
const optOut = await first.waitFor((frame) => frame.type === "response" && frame.id === "bash-optout", "opt-out bash");
assert(optOut.success === true && optOut.data?.cancelled === false && optOut.data?.output === "optout-ok", `user_bash opt-out failed: ${JSON.stringify(optOut)}`);
assert(!first.frames.slice(optOutStart).some((frame) => frame.type === "extension_ui_request" && frame.method === "confirm"), "user_bash intercepted without opt-in");

const newStart = first.frames.length;
first.send({ id: "new-session", type: "new_session" });
const newSession = await first.waitFor((frame) => frame.type === "response" && frame.id === "new-session", "new session");
assert(newSession.success === true, `new_session failed: ${JSON.stringify(newSession)}`);
await sleep(250);
const newFrames = first.frames.slice(newStart);
assert(newFrames.some((frame) => frame.type === "extension_ui_request" && frame.method === "notify" && frame.message === "omp smoke session deleted"), "new_session did not dispatch session.deleted");
assert(newFrames.some((frame) => frame.type === "extension_ui_request" && frame.method === "notify" && frame.message === "omp smoke session created"), "new_session did not dispatch session.created");
assert(newFrames.some((frame) => frame.type === "extension_ui_request" && frame.method === "setStatus" && frame.statusText === "omp smoke session created"), "session.created setStatus request is missing");
assert(!first.frames.some((frame) => frame.type === "extension_error"), "first RPC run emitted extension_error");
await first.close();

const second = startRpc(true, [false, true]);
await second.waitFor((frame) => frame.type === "ready", "second ready");
await second.waitFor((frame) => frame.type === "available_commands_update", "second extension commands");
second.send({ id: "bash-block", type: "bash", command: "printf should-not-run" });
const blocked = await second.waitFor((frame) => frame.type === "response" && frame.id === "bash-block", "blocked bash");
assert(blocked.success === true && blocked.data?.cancelled === true && /user_bash blocked/.test(String(blocked.data?.output)), `user_bash block failed: ${JSON.stringify(blocked)}`);
second.send({ id: "bash-allow", type: "bash", command: "printf allow-ok" });
const allowed = await second.waitFor((frame) => frame.type === "response" && frame.id === "bash-allow", "allowed bash");
assert(allowed.success === true && allowed.data?.cancelled === false && allowed.data?.output === "allow-ok", `user_bash allow failed: ${JSON.stringify(allowed)}`);
assert(second.frames.filter((frame) => frame.type === "extension_ui_request" && frame.method === "confirm").length === 2, "RPC confirm request count mismatch");
assert(second.frames.some((frame) => frame.type === "extension_ui_request" && frame.method === "notify"), "RPC notify request is missing");
assert(second.frames.some((frame) => frame.type === "extension_ui_request" && frame.method === "setStatus"), "RPC setStatus request is missing");
assert(!second.frames.some((frame) => frame.type === "extension_error"), "second RPC run emitted extension_error");
assert(!second.frames.some((frame) => /autocomplete/i.test(String(frame.type))), "RPC unexpectedly exposed the TUI autocomplete provider");
await second.close();

const allFrames = readFileSync(transcript, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
assert(!allFrames.some((frame) => frame.type === "extension_error"), "RPC transcript contains extension_error");
assert(!/failed to load extension|cannot find module|extension load error/i.test(readFileSync(stderrFile, "utf8")), "RPC stderr contains an extension load error");
RPC

bun "$SMOKE_ROOT/rpc-driver.mjs" \
  "$HOME_DIR" "$PROFILE" "$PROJECT_DIR" "$VALID_FIXTURE" "$INVALID_FIXTURE" \
  "$PROJECT_CONFIG" "$TRUST_FILE" "$LOG_FILE" "$RPC_TRANSCRIPT" "$RPC_STDERR"

[[ -f "$TRUST_FILE" ]] || fail "OMP trust file was not created"
TRUST_FILE="$TRUST_FILE" PROJECT_DIR="$PROJECT_DIR" bun --eval '
  import { readFileSync, realpathSync } from "node:fs";
  const entries = JSON.parse(readFileSync(process.env.TRUST_FILE, "utf8"));
  const expected = realpathSync(process.env.PROJECT_DIR);
  if (JSON.stringify(entries) !== JSON.stringify([expected])) throw new Error(`isolated OMP trust mismatch: ${JSON.stringify(entries)}`);
'
[[ ! -e "$HOME_DIR/.pi" && ! -e "$PROJECT_DIR/.pi" ]] || fail "Pi trust/config state appeared during OMP RPC"

cat > "$SMOKE_ROOT/deferred-idle.mjs" <<'IDLE'
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [entry, agentDir, projectDir, eventFile] = process.argv.slice(2);
const handlers = new Map();
const notifications = [];
const statuses = [];
const api = {
  pi: { getAgentDir: () => agentDir },
  on(name, handler) {
    const current = handlers.get(name) ?? [];
    current.push(handler);
    handlers.set(name, current);
  },
  registerCommand() {},
  registerMessageRenderer() {},
  sendMessage() {},
  sendUserMessage() {},
};
const extension = (await import(pathToFileURL(entry).href)).default;
extension(api);
const ctx = {
  cwd: projectDir,
  hasUI: true,
  isIdle: () => true,
  hasPendingMessages: () => false,
  sessionManager: {
    getSessionId: () => "deferred-idle-session",
    getSessionFile: () => undefined,
    getEntries: () => [],
  },
  ui: {
    notify: (message) => notifications.push(message),
    setStatus: (_key, text) => statuses.push(text),
    confirm: async () => true,
  },
};
for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
for (const handler of handlers.get("session_stop") ?? []) await handler({}, ctx);
const immediate = existsSync(eventFile) ? readFileSync(eventFile, "utf8") : "";
if (immediate.includes("session.idle")) throw new Error("OMP session.idle was not deferred to a macrotask");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const text = existsSync(eventFile) ? readFileSync(eventFile, "utf8") : "";
  if (text.includes("session.idle")) {
    if (!notifications.includes("omp smoke deferred idle")) throw new Error("deferred idle notify action missing");
    if (!statuses.includes("omp smoke deferred idle")) throw new Error("deferred idle setStatus action missing");
    appendFileSync(eventFile, `${JSON.stringify({ evidence: "deferred-macrotask" })}\n`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
throw new Error("timed out waiting for installed OMP adapter deferred idle dispatch");
IDLE
bun "$SMOKE_ROOT/deferred-idle.mjs" \
  "$PLUGIN_DIR/extensions/omp-yaml-hooks/index.ts" "$AGENT_DIR" "$PROJECT_DIR" "$EVENT_FILE"

cp "$VALID_FIXTURE" "$PROJECT_CONFIG"
sed 's/omp-lazy-initial/omp-lazy-refreshed/' "$VALID_FIXTURE" > "$SMOKE_ROOT/refreshed-hooks.yaml"
export OMP_SMOKE_PROJECT="$PROJECT_DIR"
export OMP_SMOKE_REFRESHED="$SMOKE_ROOT/refreshed-hooks.yaml"
export OMP_SMOKE_TUI_LOG="$TUI_TRANSCRIPT"

cat > "$SMOKE_ROOT/tui.exp" <<'EXPECT'
#!/usr/bin/expect -f
set timeout 20
log_file -noappend $env(OMP_SMOKE_TUI_LOG)
proc send_text {value} {
  send -- "\033\[200~"
  send -- $value
  send -- "\033\[201~"
}
proc drain {seconds} {
  set previous $::timeout
  set ::timeout $seconds
  expect {
    timeout {}
    eof {}
  }
  set ::timeout $previous
}
set kittyQuery "\033\[?u"
set kittyResponse "\033\[?1u"
set deviceQuery "\033\[c"
set deviceResponse "\033\[?1;2c"
set colorQuery "\033\]11;?\007"
set colorResponse "\033\]11;rgb:0000/0000/0000\007"
set syncQuery "\033\[?2026\$p"
set syncResponse "\033\[?2026;2\$y"
set unicodeQuery "\033\[?2048\$p"
set unicodeResponse "\033\[?2048;2\$y"
set appearanceQuery "\033\[?2031\$p"
set appearanceResponse "\033\[?2031;2\$y"
set notificationsQuery "\033\[?1010\$p"
set notificationsResponse "\033\[?1010;2\$y"
set notificationsFilterQuery "\033\[?1011\$p"
set notificationsFilterResponse "\033\[?1011;2\$y"
set cellSizeQuery "\033\[16t"
set cellSizeResponse "\033\[6;16;8t"
spawn -noecho omp --profile $env(OMP_PROFILE) --cwd $env(OMP_SMOKE_PROJECT) --no-title
expect -exact $kittyQuery
send -- $kittyResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $colorQuery
send -- $colorResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $syncQuery
send -- $syncResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $unicodeQuery
send -- $unicodeResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $appearanceQuery
send -- $appearanceResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $notificationsQuery
send -- $notificationsResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $notificationsFilterQuery
send -- $notificationsFilterResponse
expect -exact $deviceQuery
send -- $deviceResponse
expect -exact $cellSizeQuery
send -- $cellSizeResponse
expect -re "Welcome back"
after 1000
send_text "/hooks-st"
drain 2
send -- "\033\[117;5u"
send_text "/hooks-status omp-lazy-i"
drain 2
exec cp $env(OMP_SMOKE_REFRESHED) $env(OMP_SMOKE_PROJECT)/.omp/hook/hooks.yaml
send -- "\033\[117;5u"
send_text "/hooks-status omp-lazy-r"
drain 2
close
wait
EXPECT
expect -f "$SMOKE_ROOT/tui.exp" > "$SMOKE_ROOT/tui-expect.out" 2> "$SMOKE_ROOT/tui-expect.err"
cp "$VALID_FIXTURE" "$PROJECT_CONFIG"

TUI_EVIDENCE="$(TUI_LOG="$TUI_TRANSCRIPT" bun --eval '
  const raw = await Bun.file(process.env.TUI_LOG).text();
  const text = raw
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const expected of ["/hooks-status", "omp-lazy-initial", "omp-lazy-refreshed"]) {
    if (!text.includes(expected)) throw new Error(`TUI autocomplete evidence missing: ${expected}`);
  }
  if (/extension error|failed to load extension|cannot find module/i.test(text)) throw new Error("TUI transcript contains extension/load error");
  console.log("/hooks-status,omp-lazy-initial->omp-lazy-refreshed");
')"

[[ -f "$EVENT_FILE" ]] || fail "hook event trace was not created"
EVENT_TRACE="$(EVENT_FILE="$EVENT_FILE" bun --eval '
  const text = await Bun.file(process.env.EVENT_FILE).text();
  const rows = text.trim().split("\n").filter(Boolean).map(JSON.parse);
  const events = [...new Set(rows.map((row) => row.event ?? row.evidence).filter(Boolean))];
  for (const required of ["session.created", "session.deleted", "tool.before.bash", "session.idle", "deferred-macrotask"]) {
    if (!events.includes(required)) throw new Error(`event trace missing ${required}: ${events.join(",")}`);
  }
  console.log(events.join("->"));
')"

[[ -f "$LOG_FILE" ]] || fail "default OMP hook log was not created"
if grep -Eq 'extension_error|failed to load extension|cannot find module' "$RPC_STDERR" "$TUI_TRANSCRIPT"; then
  fail "load or extension error found in runtime evidence"
fi
[[ ! -e "$HOME_DIR/.pi" && ! -e "$PROJECT_DIR/.pi" ]] || fail "legacy .pi state leaked after all host runs"

printf 'Versions: OMP=%s Bun=%s pi-yaml-hooks=%s\n' "$OMP_VERSION" "$BUN_VERSION" "$PLUGIN_VERSION"
printf 'Paths: profile=%s plugin=%s global=%s project=%s trust=%s log=%s\n' \
  "$PROFILE" "$PLUGIN_DIR" "$GLOBAL_CONFIG" "$PROJECT_CONFIG" "$TRUST_FILE" "$LOG_FILE"
printf 'Event trace: %s\n' "$EVENT_TRACE"
printf 'TUI trace: %s\n' "$TUI_EVIDENCE"
printf 'A23 PASS: isolated HOME/profile, packed HTTP install, native manifest discovery, and OMP trust\n'
printf 'A24 PASS: commands, valid/invalid config, paths, UI RPC, lifecycle, deferred idle, user_bash, and reload\n'
printf 'A25 PASS: assertion-driven RPC headless degradation plus PTY autocomplete/lazy refresh; no real model call\n'

cleanup
trap - EXIT INT TERM
[[ ! -e "$SMOKE_ROOT" ]] || fail "smoke root remained after cleanup: $SMOKE_ROOT"
if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
  fail "local tarball server remained after cleanup"
fi
printf 'A26 PASS: versions and evidence printed; PASS count=4; cleanup proof=root-absent,server-stopped\n'
