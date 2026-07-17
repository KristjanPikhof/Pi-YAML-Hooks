# pi-yaml-hooks

Run `bash` around tool calls, block risky commands, and post UI notifications, confirmations, and status entries from one `hooks.yaml` file. The same `pi-yaml-hooks` package installs natively in the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi).

This repo is the Pi and OMP port of [OpenCode-Hooks](https://github.com/KristjanPikhof/OpenCode-Hooks). The hook model is familiar, each host uses its native package manifest, and there is no extension path to wire manually.

## What it does

- Run hooks on `tool.before.*`, `tool.after.*`, `file.changed`, `session.created`, `session.idle`, and `session.deleted`
- Use `bash`, `tool`, `notify`, `confirm`, and `setStatus` actions
- Filter hooks with `matchesCodeFiles`, `matchesAnyPath`, and `matchesAllPaths`
- Load one global root config and one trusted project root config; imports are gated by trust and opt-in env vars
- Show built-in diagnostics with `/hooks-status`, `/hooks-validate`, `/hooks-trust`, `/hooks-reload`, and `/hooks-tail-log`
- Persist diagnostics as context-free custom entries on Pi 0.80-capable TUI hosts, with custom-message fallback on older or non-TUI hosts
- Inject a short hook-awareness note before agent start (disable with `PI_YAML_HOOKS_PROMPT_AWARENESS=0`)

## Quick start

Choose the host you use. Both native installs load the same package and the same YAML.

**Pi**

```bash
pi install npm:pi-yaml-hooks

mkdir -p ~/.pi/agent/hook
cat > ~/.pi/agent/hook/hooks.yaml <<'YAML'
hooks:
  - event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

pi
```

**OMP, default profile**

```bash
omp plugin install pi-yaml-hooks

mkdir -p ~/.omp/agent/hook
cat > ~/.omp/agent/hook/hooks.yaml <<'YAML'
hooks:
  - event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

omp
```

In the agent, run:

```text
/hooks-status
```

The status output identifies the active global file. Startup also reports:

```text
[pi-yaml-hooks] Loaded 1 hook (global: 1, project: 0).
```

If a trusted project also has project hooks, the summary includes both scopes:

```text
[pi-yaml-hooks] Loaded 3 hooks (global: 1, project: 2).
```

## Requirements

- macOS or Linux
- Node.js `>=22.19.0`
- `bash` on `$PATH` (override with `PI_YAML_HOOKS_BASH_EXECUTABLE`)
- Pi with the verified SDK compatibility pairs described below, or OMP

The Pi SDK matrix verifies the retained 0.74.0 floor and current 0.79.3 pair. The end-to-end runtime smoke was run with Pi 0.80.7 and OMP 17.0.1. These are tested versions, not a broader support claim.

Windows is unsupported.

## Install

Use the native package command for your host:

```bash
pi install npm:pi-yaml-hooks
omp plugin install pi-yaml-hooks
```

One published package contains both host manifests. Neither install needs `-e` or `--extension`, a manual extension path, a symlink, or an environment override. See [`docs/setup.md`](./docs/setup.md) for named OMP profiles, updates, removal, and local development.

The existing Pi alternatives remain available:

```bash
pi install https://github.com/KristjanPikhof/pi-yaml-hooks   # latest unreleased
pi -e npm:pi-yaml-hooks                                     # one-off run
```

Add `-l` to `pi install` to write to project settings (`.pi/settings.json`) instead of global settings (`~/.pi/agent/settings.json`).

### SDK compatibility matrix

Before widening Pi peer support or merging SDK-sensitive changes, run:

```bash
npm run compat:sdk-matrix
```

The matrix checks both the legacy 0.74.0 SDK floor and the current Pi 0.79.3 SDK pair (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`). It creates a temporary copy of the repository, installs each SDK pair in that copy only, then runs `npm run typecheck` and `npm run test:internal`. The working checkout's `package.json`, `package-lock.json`, and normal `node_modules` are not mutated.

`npm test` remains a consumer-facing no-op. Use `npm run test:internal` directly in the working checkout for full validation.

To preview the matrix workflow without installing anything:

```bash
npm run compat:sdk-matrix:dry-run
```

The runtime smoke checklist covers surfaces unit tests cannot fully emulate:

```bash
scripts/smoke/pi-runtime-smoke.sh
scripts/smoke/omp-runtime-smoke.sh
```

Maintainer-facing details live in [`docs/maintaining.md`](./docs/maintaining.md). Future Pi SDK lines remain gated. Try them explicitly with `npm run compat:sdk-matrix:future`, and do not widen compatibility claims until the future matrix and runtime smoke pass.

## How it works

`pi-yaml-hooks` discovers at most one global root config and one project root config. Project hooks and project-root imports load only when the repo or worktree trust anchor is trusted through `/hooks-trust`, the active host's `trusted-projects.json`, or `PI_YAML_HOOKS_TRUST_PROJECT=1`. This hook trust is separate from host package trust. Global-root imports require `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1`, package imports require `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1`, and project imports outside the trust anchor require `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`. The project root is repo/worktree-aware, not exact-cwd-only.

When an event matches, `pi-yaml-hooks` evaluates conditions and runs the configured actions. `bash` actions receive hook context JSON on stdin plus injected `PI_*` environment variables such as `PI_PROJECT_DIR`, `PI_WORKTREE_DIR`, `PI_SESSION_ID`, and `PI_GIT_COMMON_DIR`. At agent start, the extension also appends a short hook-awareness note to the system prompt so the host has the current hook and trust context while it works.

## Native PI surface

### Events

| Event | Meaning |
|---|---|
| `tool.before.*` | Before a tool call |
| `tool.after.*` | After a tool call |
| `file.changed` | Synthesized after recognized file mutations |
| `session.created` | PI startup or a genuinely new session |
| `session.idle` | Agent turn has settled with no retry, compaction retry, or queued continuation remaining on capable hosts; older Pi falls back to `agent_end` behavior |
| `session.deleted` | Best-effort cleanup on shutdown or session switch; includes PI's reason (`quit`, `reload`, `new`, `resume`, or `fork`) when available |

### Actions

| Action | PI behavior |
|---|---|
| `bash` | Runs a shell command with injected context |
| `tool` | Sends a follow-up prompt into the current PI session |
| `notify` | Shows a PI notification when `ctx.hasUI` and the UI method exist, including RPC UI contexts in Pi 0.79+ |
| `confirm` | Shows a confirmation dialog before a tool runs when UI exists; headless/no-UI contexts fail closed |
| `setStatus` | Sets a PI status-bar/status entry keyed to the hook when the UI method exists |

### Slash commands

| Command | What it shows |
|---|---|
| `/hooks-status` | Active hooks, config paths, trust state, and log path |
| `/hooks-validate` | Validation results for active hooks and skipped untrusted project hooks |
| `/hooks-trust` | Adds the current repo/worktree anchor to `~/.pi/agent/trusted-projects.json` |
| `/hooks-reload` | Asks PI to reload extensions; edited hooks also refresh lazily on the next relevant event |
| `/hooks-tail-log` | Log path plus a ready-to-run `tail -F` command; `--follow` starts a detached live tail, and `--path` prints only the path |

`/hooks-status`, `/hooks-validate`, and hook-load validation errors persist as custom entries on the Pi 0.80-capable TUI path. These entries do not enter model context. Older Pi and non-TUI paths retain the custom-message fallback.

PI exposes `ctx.ui.addAutocompleteProvider` in the TUI editor, so `pi-yaml-hooks` layers guarded `/hooks` autocomplete only when `ctx.mode` is `"tui"` (or absent on older SDKs) and the method exists. Suggestions include the command names plus contextual hook IDs, event names, config paths, and log-tail options where useful. Hook IDs are loaded lazily and memoized by hook-snapshot signature, not fixed at extension registration time.

## Important limitations

These are the PI-specific constraints that matter most:

- `command:` actions are unsupported on PI and are rejected at load time
- `tool:` is prompt injection, not imperative tool execution
- `action: stop` only has real effect on `tool.before.*`
- `runIn: main` is unsupported for non-`bash` actions
- `session.deleted` is best-effort and intentionally lossy: PI fires it for shutdown and for session switches like `/new`, `/resume`, and `/fork`, and `pi-yaml-hooks` forwards PI's `reason` (`quit`, `reload`, `new`, `resume`, or `fork`) on the envelope so hooks can disambiguate
- `user_bash` interception is opt-in with `PI_YAML_HOOKS_ENABLE_USER_BASH=1`

Keep those rules in mind when authoring hooks. They explain most surprising behavior.

### What trust grants when user_bash is enabled

When `PI_YAML_HOOKS_ENABLE_USER_BASH=1` is set, every human `!` / `!!` shell command typed in PI is routed through `tool.before.bash` hooks before PI executes it. This expands the trust surface significantly:

- **Observation**: hooks receive the typed command in stdin JSON as `tool_args.command`, so a trusted-project bash hook can read the full text of every command you type.
- **Blocking**: a `tool.before.bash` hook that exits with code `2` will prevent the command from running. A misconfigured or malicious hook can silently block commands.
- **Exfiltration risk**: the same bash hook can forward `tool_args.command` to an external service. Only enable `PI_YAML_HOOKS_ENABLE_USER_BASH=1` if you trust every hook in every trusted project.

`pi-yaml-hooks` emits a one-time stderr warning on startup listing which trusted projects will have access when this env var is set, and shows a PI UI warning on the first intercepted command when a UI is available. The warning fires once per process and names the projects currently in `~/.pi/agent/trusted-projects.json`.

This mode is disabled by default. Agent-generated `bash` tool calls are always intercepted regardless of this setting.

## Config paths and trust

The preferred root config paths are:

| Host | Global | Project |
|---|---|---|
| Pi | `~/.pi/agent/hook/hooks.yaml` | `<project>/.pi/hook/hooks.yaml` |
| OMP default profile | `~/.omp/agent/hook/hooks.yaml` | `<project>/.omp/hook/hooks.yaml` |
| OMP named profile | `~/.omp/profiles/<profile>/agent/hook/hooks.yaml` | `<project>/.omp/hook/hooks.yaml` |

The same YAML works in every listed location. Each host loads at most one global root and one project root. OMP checks its native `.omp` location before the legacy `.pi` fallback, so it never combines native and legacy roots within one scope.

Project hooks are gated by pi-yaml-hooks trust because they can run arbitrary `bash` with your user permissions. Trust is evaluated against the repo or worktree trust anchor, not an arbitrary nested directory string. `trusted-projects.json` entries must be absolute paths; relative entries such as `.` are ignored.

Run `/hooks-trust` in the active host to trust the current project. Pi writes `~/.pi/agent/trusted-projects.json`. OMP writes the active profile's trust store, either `~/.omp/agent/trusted-projects.json` or `~/.omp/profiles/<profile>/agent/trusted-projects.json`. OMP does not inherit Pi trust, including when OMP loads a legacy `.pi` project config.

The temporary `PI_YAML_HOOKS_TRUST_PROJECT=1` opt-in remains available on both hosts. All `PI_YAML_HOOKS_*` environment variable names are retained for compatibility.

## Examples

Example workflows live under [`examples/`](./examples/). Start with [`examples/README.md`](./examples/README.md) for complete example packs, including pre-tool developer guards and post-tool developer feedback hooks.

These packs are opt-in examples, not built-in PI features.

## Docs

Full reference and reading order live in [`docs/README.md`](./docs/README.md).

## License

MIT.
