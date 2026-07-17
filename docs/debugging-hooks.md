# Debugging hooks

`pi-yaml-hooks` can write persistent NDJSON debug logs for either host:

```bash
PI_YAML_HOOKS_DEBUG=1 pi
PI_YAML_HOOKS_DEBUG=1 omp
```

Even without debug logging, hook execution failures and adapter dispatch failures print concise stderr errors. Debug mode adds persistent NDJSON traces and action-level detail.

## Find the active files

Run `/hooks-status` inside Pi or OMP first. It reports the current project directory, selected global and project configs, project trust state, active trust store, and current log path. Trust checks themselves use the canonical repo/worktree anchor.

| Host | Active agent directory | Global candidates, first existing wins | Project candidates at the nearest project root | Trust store | Default log |
|---|---|---|---|---|---|
| Pi | `~/.pi/agent` | `~/.pi/agent/hook/hooks.yaml`, then `~/.pi/agent/hooks.yaml` | `.pi/hook/hooks.yaml`, then `.pi/hooks.yaml` | `~/.pi/agent/trusted-projects.json` | `~/.pi/agent/logs/pi-yaml-hooks.ndjson` |
| OMP default profile | `~/.omp/agent` | `<agentDir>/hook/hooks.yaml`, then `<agentDir>/hooks.yaml`, then the two Pi global candidates | `.omp/hook/hooks.yaml`, then `.omp/hooks.yaml`, then the two `.pi` candidates | `~/.omp/agent/trusted-projects.json` | `~/.omp/agent/logs/pi-yaml-hooks.ndjson` |
| OMP named profile | `~/.omp/profiles/<profile>/agent` | Same order under the active named `agentDir`, then the two Pi global candidates | Same project order as OMP default | `~/.omp/profiles/<profile>/agent/trusted-projects.json` | `~/.omp/profiles/<profile>/agent/logs/pi-yaml-hooks.ndjson` |

OMP gets its active `agentDir` from the running host. Do not infer a named profile path from `HOME` alone. `/hooks-status`, prompt awareness, autocomplete, trust warnings, and `/hooks-tail-log` all use that active directory.

### Diagnose trust and fallback

Project trust is stored as absolute canonical repo/worktree anchors. Use these commands against the running host:

- `/hooks-status` shows the selected native or fallback project file and its trust state.
- `/hooks-validate` reports validation errors for the selected paths without replacing the last-known-good hook set with an invalid config.
- `/hooks-trust` writes only the active host's trust store, using an atomic mode-`0600` replacement on POSIX.

OMP considers legacy `.pi` project candidates only when no native `.omp` candidate wins. A legacy project file still requires the repo/worktree anchor in the active OMP trust store. `~/.pi/agent/trusted-projects.json` never authorizes OMP project hooks, and `/hooks-trust` under OMP does not create or update Pi trust state. Global fallback is visible because `/hooks-status` prints the selected global path.

Malformed or missing trust files fail closed. The warning names the active trust store, and a malformed file is left unchanged. `PI_YAML_HOOKS_TRUST_PROJECT=1` is an explicit per-process bypass and logs a trust-boundary warning.

## Structured in-session diagnostics

`pi-yaml-hooks` emits structured host diagnostics for `/hooks-status`, `/hooks-validate`, and hook-load validation problems.

| Surface | Diagnostics and UI behavior |
|---|---|
| TUI | On capable hosts, diagnostic entries render inline without entering model context. `/hooks` autocomplete is registered only when the TUI autocomplete method exists. Pi PTY and OMP tmux smoke tests exercise this path. |
| RPC | No TUI autocomplete is registered. RPC may still expose `ctx.hasUI`; when it does, `notify`, `confirm`, and `setStatus` use those UI methods. |
| Headless or no UI | Diagnostics remain available as plain text, custom messages where supported, stderr, and logs. `notify` and `setStatus` degrade with one warning. `confirm` denies by default unless `PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE=1` explicitly opts in. |

A stale or replaced session does not receive queued output from an earlier hook. `tool:` asks the active Pi or OMP session to handle a follow-up prompt; if the captured session no longer matches, delivery degrades instead of leaking the prompt into the replacement session.

## Tail the active log

From inside the running host:

```text
/hooks-tail-log
/hooks-tail-log --path
```

With no arguments, the command prints the active log and a copy-pasteable `tail -F` command. `--path` prints only the resolved path, which is the safest choice for scripts and named OMP profiles.

Raw host defaults:

```bash
tail -F ~/.pi/agent/logs/pi-yaml-hooks.ndjson
tail -F ~/.omp/agent/logs/pi-yaml-hooks.ndjson
```

The standalone helper defaults to the Pi path unless `PI_YAML_HOOKS_LOG_FILE` or `--file` is supplied. For OMP, get the active path from `/hooks-tail-log --path`, then pass it explicitly:

```bash
./scripts/tail-hook-log.sh --file /path/from/hooks-tail-log
```

Useful filters:

```bash
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --hook my-hook
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --event session.idle --session abc123
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --kind action_result --level info
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --hook my-hook --raw
```

Override every host default with:

```bash
PI_YAML_HOOKS_LOG_FILE=/tmp/pi-yaml-hooks.ndjson PI_YAML_HOOKS_DEBUG=1 pi
PI_YAML_HOOKS_LOG_FILE=/tmp/pi-yaml-hooks.ndjson PI_YAML_HOOKS_DEBUG=1 omp
```

The live file rotates after `PI_YAML_HOOKS_LOG_MAX_BYTES` (default 10 MiB). It becomes `<path>.1`, replacing any prior `.1`; only one rotated copy is kept.

## Read the trace

Debug logs include:

- config loads, reloads, selected source paths, validation failures, and trust decisions
- dispatches for `tool.before.*`, `tool.after.*`, `file.changed`, and session events
- each considered hook, match or skip result, and exact skip reason
- each action start/result
- the exact follow-up prompt requested by a `tool:` action and whether the host accepted or degraded delivery
- bash exit status, duration, stdout/stderr, and timeout cleanup
- UI action acceptance, degradation, or failure
- `session.deleted` reason when the host supplied one; the value is opaque telemetry

These entries come from the extension runtime, not the host session transcript. Pi session JSONL and OMP transcripts are not the canonical hook trail. Use the active log path printed by `/hooks-status` or `/hooks-tail-log`.

## Useful environment variables

The canonical environment-variable table lives in [`setup.md`](./setup.md#environment-variables). The debugging controls are:

- `PI_YAML_HOOKS_DEBUG=1`: enable debug-level persistent logging
- `PI_YAML_HOOKS_LOG_FILE=/path/file.ndjson`: override the active host default
- `PI_YAML_HOOKS_LOG_LEVEL=debug|info|warn|error`: set the log level
- `PI_YAML_HOOKS_LOG_STDERR=1`: mirror structured entries to stderr
