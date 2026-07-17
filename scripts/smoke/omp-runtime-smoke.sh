#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VALID_FIXTURE="$ROOT_DIR/scripts/smoke/omp-runtime-smoke-hooks.yaml"
INVALID_FIXTURE="$ROOT_DIR/scripts/smoke/omp-runtime-smoke-invalid-hooks.yaml"
PROFILE="omp-runtime-smoke"
TMP_BASE="${TMPDIR:-/tmp}"
SMOKE_ROOT="$(mktemp -d "${TMP_BASE%/}/pi-yaml-hooks-omp-runtime.XXXXXX")"
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
TMUX_BIN="${TMUX_BIN:-}"
TMUX_OVERRIDE="$TMUX_BIN"
TMUX_SOCKET="$SMOKE_ROOT/tmux.sock"
SERVER_PID=""
CLEANED=0
TMUX_ACTIVE=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  if [[ "$TMUX_ACTIVE" -eq 1 ]]; then
    "$TMUX_BIN" -S "$TMUX_SOCKET" kill-server 2>/dev/null || true
    TMUX_ACTIVE=0
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  sleep 0.2
  rm -rf "$SMOKE_ROOT" || true
  sleep 0.2
  rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT INT TERM

for command in omp bun npm node; do
  command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done
if [[ -n "$TMUX_BIN" ]]; then
  TMUX_BIN="$(command -v "$TMUX_OVERRIDE" 2>/dev/null)" || fail "tmux override is unavailable: $TMUX_OVERRIDE"
else
  TMUX_BIN="$(command -v tmux 2>/dev/null)" || fail "required command is unavailable: tmux (set TMUX_BIN to override)"
fi

OMP_VERSION="$(omp --version 2>&1 | sed -n '1p')"
BUN_VERSION="$(bun --version)"
PLUGIN_VERSION="$(node --input-type=module - "$ROOT_DIR/package.json" <<'NODE'
import { readFileSync } from "node:fs";
process.stdout.write(JSON.parse(readFileSync(process.argv[2], "utf8")).version);
NODE
)"
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
const normalizePathText = (value) => String(value).replaceAll("/private/var/", "/var/").replace(/\/+/g, "/");

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
  let output = "";
  let exited = false;
  let exitCode;
  let exitSignal;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

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

  const stdoutLines = readline.createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    output += `${line}\n`;
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
    output += text;
    appendFileSync(stderrFile, text);
  });
  child.on("close", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    resolveClosed();
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`OMP RPC exited before ${waiter.label}; code=${code}; signal=${signal}`));
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
  const waitForClose = async (timeoutMs) => {
    if (exited) return true;
    let timer;
    const timedOut = await Promise.race([
      closed.then(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    clearTimeout(timer);
    return !timedOut;
  };
  const close = async () => {
    let forcedSignal;
    try {
      if (!child.stdin.destroyed) child.stdin.end();
      if (!(await waitForClose(3000))) {
        forcedSignal = "SIGTERM";
        child.kill(forcedSignal);
        if (!(await waitForClose(2000))) {
          forcedSignal = "SIGKILL";
          child.kill(forcedSignal);
          if (!(await waitForClose(2000))) throw new Error("OMP RPC did not close after SIGKILL");
        }
      }
      assert(forcedSignal === undefined, `OMP RPC required ${forcedSignal} during close; code=${exitCode}; signal=${exitSignal}`);
      assert(exitCode === 0 && exitSignal === null, `OMP RPC exit was code=${exitCode}; signal=${exitSignal}`);
    } finally {
      stdoutLines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("OMP RPC closed while waiting for a frame"));
      }
    }
  };
  return { child, frames, get output() { return output; }, waitFor, send, prompt, close };
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

const allFrames = readFileSync(transcript, "utf8").trim().split("\n").flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
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
sed 's/omp-lazy-initial/omp-lazy-refreshed/' "$VALID_FIXTURE" > "$SMOKE_ROOT/refreshed-hooks.yaml"

cat > "$SMOKE_ROOT/deferred-idle.mjs" <<'IDLE'
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [entry, agentDir, projectDir, eventFile, projectConfig, validFixture, refreshedFixture] = process.argv.slice(2);
const handlers = new Map();
const notifications = [];
const statuses = [];
const autocompleteFactories = [];
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
let idle = false;
let pendingMessages = true;
const ctx = {
  cwd: projectDir,
  hasUI: true,
  mode: "tui",
  isIdle: () => idle,
  hasPendingMessages: () => pendingMessages,
  sessionManager: {
    getSessionId: () => "deferred-idle-session",
    getSessionFile: () => undefined,
    getEntries: () => [],
  },
  ui: {
    addAutocompleteProvider: (factory) => autocompleteFactories.push(factory),
    notify: (message) => notifications.push(message),
    setStatus: (_key, text) => statuses.push(text),
    confirm: async () => true,
  },
};
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
if (autocompleteFactories.length !== 1) throw new Error(`OMP TUI autocomplete registration count mismatch: ${autocompleteFactories.length}`);
const provider = autocompleteFactories[0]({
  getSuggestions: async () => null,
  applyCompletion: (lines) => ({ lines, cursorLine: 0, cursorCol: lines[0]?.length ?? 0 }),
});
const suggestionsFor = async (prefix) => provider.getSuggestions(
  [`/hooks-status ${prefix}`],
  0,
  `/hooks-status ${prefix}`.length,
  { signal: new AbortController().signal },
);
const initialSuggestions = await suggestionsFor("omp-lazy-i");
if (!initialSuggestions?.items?.some((item) => item.label === "omp-lazy-initial")) {
  throw new Error("OMP TUI autocomplete did not expose the initial installed hook id");
}
copyFileSync(refreshedFixture, projectConfig);
const refreshedSuggestions = await suggestionsFor("omp-lazy-r");
if (!refreshedSuggestions?.items?.some((item) => item.label === "omp-lazy-refreshed")) {
  throw new Error("OMP TUI autocomplete did not lazily refresh the installed hook id");
}
copyFileSync(validFixture, projectConfig);
const extensionErrors = [];
const promptResults = [];
for (const handler of handlers.get("before_agent_start") ?? []) {
  try {
    const result = await handler({
      type: "before_agent_start",
      prompt: "inspect installed OMP hook awareness",
      systemPrompt: ["base system prompt"],
    }, ctx);
    if (result !== undefined) promptResults.push(result);
  } catch (error) {
    extensionErrors.push({ type: "extension_error", event: "before_agent_start", error: String(error) });
  }
}
if (extensionErrors.length !== 0) throw new Error(`OMP prompt lifecycle emitted extension_error: ${JSON.stringify(extensionErrors)}`);
if (promptResults.length !== 1 || !Array.isArray(promptResults[0].systemPrompt)) {
  throw new Error(`OMP before_agent_start did not preserve array-shaped systemPrompt ABI: ${JSON.stringify(promptResults)}`);
}
if (promptResults[0].systemPrompt[0] !== "base system prompt" ||
    !promptResults[0].systemPrompt.some((part) => String(part).includes("active hook host: OMP"))) {
  throw new Error(`OMP before_agent_start prompt evidence mismatch: ${JSON.stringify(promptResults[0])}`);
}
appendFileSync(eventFile, `${JSON.stringify({
  evidence: "before_agent_start",
  session: "deferred-idle-session",
  systemPromptShape: "array",
})}\n`);

const readEventRows = () => {
  if (!existsSync(eventFile)) return [];
  return readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
};
const idleCountBefore = readEventRows().filter((row) => row.event === "session.idle").length;
const assertNoNewIdle = async (phase) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const count = readEventRows().filter((row) => row.event === "session.idle").length;
  if (count !== idleCountBefore) throw new Error(`OMP session.idle dispatched before authoritative final agent_end (${phase})`);
};

for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
for (const handler of handlers.get("session_stop") ?? []) await handler({}, ctx);
for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
await assertNoNewIdle("session stop/shutdown control phase");
pendingMessages = false;
for (const handler of handlers.get("agent_end") ?? []) await handler({}, ctx);
await assertNoNewIdle("non-idle agent_end");
idle = true;
for (const handler of handlers.get("agent_end") ?? []) await handler({}, ctx);
const finalIdleCount = readEventRows().filter((row) => row.event === "session.idle").length;
if (finalIdleCount !== idleCountBefore + 1) {
  throw new Error(`OMP final idle agent_end did not dispatch exactly once: before=${idleCountBefore} after=${finalIdleCount}`);
}
if (!notifications.includes("omp smoke deferred idle")) throw new Error("authoritative idle notify action missing");
if (!statuses.includes("omp smoke deferred idle")) throw new Error("authoritative idle setStatus action missing");
appendFileSync(eventFile, `${JSON.stringify({ evidence: "deferred-macrotask", session: "deferred-idle-session" })}\n`);
IDLE
[[ -d "$ROOT_DIR/node_modules/@earendil-works/pi-tui" ]] || fail "local pi-tui dependency is unavailable for the deferred-idle harness"
mkdir -p "$PLUGIN_DIR/node_modules/@earendil-works"
ln -s "$ROOT_DIR/node_modules/@earendil-works/pi-tui" "$PLUGIN_DIR/node_modules/@earendil-works/pi-tui"
bun "$SMOKE_ROOT/deferred-idle.mjs" \
  "$PLUGIN_DIR/dist/extensions/omp-yaml-hooks/index.js" "$AGENT_DIR" "$PROJECT_DIR" "$EVENT_FILE" \
  "$PROJECT_CONFIG" "$VALID_FIXTURE" "$SMOKE_ROOT/refreshed-hooks.yaml"
rm "$PLUGIN_DIR/node_modules/@earendil-works/pi-tui"
rmdir "$PLUGIN_DIR/node_modules/@earendil-works" "$PLUGIN_DIR/node_modules" 2>/dev/null || true

cp "$VALID_FIXTURE" "$PROJECT_CONFIG"
printf -v TMUX_COMMAND \
  'env HOME=%q USERPROFILE=%q OMP_PROFILE=%q PI_YAML_HOOKS_ENABLE_USER_BASH=0 omp --profile %q --cwd %q --no-title' \
  "$HOME_DIR" "$HOME_DIR" "$PROFILE" "$PROFILE" "$PROJECT_DIR"
"$TMUX_BIN" -S "$TMUX_SOCKET" new-session -d -s omp-smoke -x 160 -y 50 "$TMUX_COMMAND"
TMUX_ACTIVE=1

sleep 6
for _ in $(seq 1 5); do
  "$TMUX_BIN" -S "$TMUX_SOCKET" send-keys -t omp-smoke Escape
  sleep 0.5
done
for _ in $(seq 1 100); do
  "$TMUX_BIN" -S "$TMUX_SOCKET" capture-pane -p -t omp-smoke > "$SMOKE_ROOT/tmux-startup.txt"
  if grep -q "/ for commands" "$SMOKE_ROOT/tmux-startup.txt"; then
    break
  fi
  sleep 0.1
done
if ! grep -q "/ for commands" "$SMOKE_ROOT/tmux-startup.txt"; then
  cat "$SMOKE_ROOT/tmux-startup.txt" >&2
  fail "OMP tmux TUI did not leave isolated-profile setup"
fi

"$TMUX_BIN" -S "$TMUX_SOCKET" send-keys -t omp-smoke -l "/hooks-status omp-lazy-i"
for _ in $(seq 1 50); do
  "$TMUX_BIN" -S "$TMUX_SOCKET" capture-pane -p -S - -t omp-smoke > "$SMOKE_ROOT/tmux-initial.txt"
  if grep -q "omp-lazy-initial" "$SMOKE_ROOT/tmux-initial.txt"; then
    break
  fi
  sleep 0.1
done
if ! grep -q "omp-lazy-initial" "$SMOKE_ROOT/tmux-initial.txt"; then
  cat "$SMOKE_ROOT/tmux-initial.txt" >&2
  fail "real OMP tmux TUI did not render the initial hook-ID completion"
fi

cp "$SMOKE_ROOT/refreshed-hooks.yaml" "$PROJECT_CONFIG"
"$TMUX_BIN" -S "$TMUX_SOCKET" send-keys -t omp-smoke C-u
sleep 0.2
"$TMUX_BIN" -S "$TMUX_SOCKET" send-keys -t omp-smoke -l "/hooks-status omp-lazy-r"
for _ in $(seq 1 50); do
  "$TMUX_BIN" -S "$TMUX_SOCKET" capture-pane -p -t omp-smoke > "$SMOKE_ROOT/tmux-refreshed.txt"
  if grep -q "omp-lazy-refreshed" "$SMOKE_ROOT/tmux-refreshed.txt"; then
    break
  fi
  sleep 0.1
done
grep -q "omp-lazy-refreshed" "$SMOKE_ROOT/tmux-refreshed.txt" || fail "real OMP tmux TUI did not render the lazily refreshed hook-ID completion"
cat "$SMOKE_ROOT/tmux-initial.txt" "$SMOKE_ROOT/tmux-refreshed.txt" > "$TUI_TRANSCRIPT"
"$TMUX_BIN" -S "$TMUX_SOCKET" kill-server
if "$TMUX_BIN" -S "$TMUX_SOCKET" has-session 2>/dev/null; then
  fail "private tmux server remained after TUI capture"
fi
TMUX_ACTIVE=0
cp "$VALID_FIXTURE" "$PROJECT_CONFIG"

TUI_EVIDENCE="$(TUI_LOG="$TUI_TRANSCRIPT" bun --eval '
  const raw = await Bun.file(process.env.TUI_LOG).text();
  const text = raw
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const expected of ["/hooks-status", "omp-lazy-initial", "omp-lazy-refreshed"]) {
    if (!text.includes(expected)) throw new Error(`real OMP TUI autocomplete evidence missing: ${expected}`);
  }
  if (/extension error|failed to load extension|cannot find module/i.test(text)) throw new Error("TUI transcript contains extension/load error");
  console.log("tmux-pty:/hooks-status,omp-lazy-initial->omp-lazy-refreshed");
')"

[[ -f "$EVENT_FILE" ]] || fail "hook event trace was not created"
EVENT_TRACE="$(EVENT_FILE="$EVENT_FILE" bun --eval '
  const text = await Bun.file(process.env.EVENT_FILE).text();
  const rows = text.trim().split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`invalid event NDJSON row ${index + 1}: ${error.message}`); }
  });
  const label = (row) => row.event ?? row.evidence;
  const required = [
    ["event", "session.created"],
    ["event", "session.deleted"],
    ["event", "tool.before.bash"],
    ["event", "session.idle"],
    ["evidence", "before_agent_start"],
    ["evidence", "deferred-macrotask"],
  ];
  for (const [key, value] of required) {
    if (!rows.some((row) => row[key] === value)) throw new Error(`event trace missing exact ${key}=${value}`);
  }
  for (const row of rows.filter((candidate) => required.some(([key, value]) => candidate[key] === value))) {
    if (typeof row.session !== "string" || row.session.length === 0) {
      throw new Error(`structured event evidence is missing session: ${JSON.stringify(row)}`);
    }
  }

  const deferredSession = "deferred-idle-session";
  const indexOf = (key, value, session) => rows.findIndex((row) => row[key] === value && row.session === session);
  const promptIndex = indexOf("evidence", "before_agent_start", deferredSession);
  const createdIndex = indexOf("event", "session.created", deferredSession);
  const deletedIndex = indexOf("event", "session.deleted", deferredSession);
  const idleIndex = indexOf("event", "session.idle", deferredSession);
  const deferredIndex = indexOf("evidence", "deferred-macrotask", deferredSession);
  if (!(createdIndex < promptIndex && promptIndex < deletedIndex && deletedIndex < idleIndex && idleIndex < deferredIndex)) {
    throw new Error(`deferred lifecycle order mismatch: ${JSON.stringify({ promptIndex, createdIndex, deletedIndex, idleIndex, deferredIndex })}`);
  }
  const promptRow = rows[promptIndex];
  if (promptRow.systemPromptShape !== "array") throw new Error(`before_agent_start ABI evidence mismatch: ${JSON.stringify(promptRow)}`);

  const userBashRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.event === "tool.before.bash");
  const correlatedUserBash = userBashRows.find(({ row, index }) => {
    const created = rows.findIndex((candidate) => candidate.event === "session.created" && candidate.session === row.session);
    const deleted = rows.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.event === "session.deleted" && candidate.session === row.session);
    return created >= 0 && created < index && deleted > index;
  });
  if (!correlatedUserBash) {
    throw new Error(`tool.before.bash lacks created/tool/deleted session ordering: ${JSON.stringify(userBashRows)}`);
  }
  console.log(rows.map(label).filter(Boolean).join("->"));
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
printf 'A24 PASS: commands, valid/invalid config, paths, UI RPC, lifecycle, authoritative idle, user_bash, and reload\n'
printf 'A25 PASS: assertion-driven RPC headless degradation, packed-entry before_agent_start array ABI, and tmux PTY autocomplete/lazy refresh; no real model call\n'

cleanup
trap - EXIT INT TERM
[[ ! -e "$SMOKE_ROOT" ]] || fail "smoke root remained after cleanup: $SMOKE_ROOT"
if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
  fail "local tarball server remained after cleanup"
fi
printf 'A26 PASS: versions and evidence printed; PASS count=4; cleanup proof=root-absent,server-stopped,tmux-stopped\n'
