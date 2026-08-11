# Debugging hooks

Start with the running host, not a guessed path.

## Check loading and trust

Run these inside Pi or OMP:

```text
/hooks-status
/hooks-validate
```

`/hooks-status` shows selected files, active hook counts, the repo or worktree trust anchor, trust store, and log path. `/hooks-validate` reports schema and import errors, including a valid project file skipped because it is untrusted.

If a project file is skipped, run `/hooks-trust` in the same host and profile. Pi trust never authorizes OMP hooks, and OMP trust never authorizes Pi hooks.

## Read the structured log

Enable persistent debug logging when starting the host:

```bash
PI_YAML_HOOKS_DEBUG=1 pi
PI_YAML_HOOKS_DEBUG=1 omp
```

Then use the active path from the host:

```text
/hooks-tail-log
/hooks-tail-log --path
/hooks-tail-log --follow
```

The default paths are:

| Host | Log path |
|---|---|
| Pi | `~/.pi/agent/logs/pi-yaml-hooks.ndjson` |
| OMP default | `~/.omp/agent/logs/pi-yaml-hooks.ndjson` |
| OMP named profile | `~/.omp/profiles/<profile>/agent/logs/pi-yaml-hooks.ndjson` |

An explicit `PI_YAML_HOOKS_LOG_FILE` overrides these paths.

The packaged helper can filter an existing log:

```bash
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --hook my-hook
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --event session.idle
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --kind action_result --level info
./scripts/tail-hook-log.sh --file /path/to/pi-yaml-hooks.ndjson --raw
```

The helper cannot infer a named OMP profile by itself. Pass `--file` or launch it through `/hooks-tail-log --follow`.

## Interpret a trace

Look for this sequence:

1. `dispatch_event` shows that the host event reached the runtime.
2. `hook_match` or `hook_skip` explains the condition and scope decision.
3. `action_start` shows which action began.
4. `action_result` records success, failure, blocking, or UI degradation.

Common skip reasons include `scope_mismatch`, `matchesAnyPath_failed`, `matchesAllPaths_failed`, and the corresponding `*_no_paths` forms.

## Common problems

| Symptom | Check |
|---|---|
| No hooks load | Selected path, YAML shape, and `/hooks-validate` |
| Project hooks are absent | Active host's trust store and repo or worktree anchor |
| Path filter never matches | Whether the event has recognized changed paths |
| Confirmation always rejects | Whether the current context exposes UI |
| Notification or status is missing | `ctx.hasUI` and the matching UI capability |
| Follow-up prompt is missing | Whether the captured session was replaced before delivery |
| Edited hooks keep old behavior | Validation errors; invalid reloads preserve the last valid set |
| Prompt context is missing | Bash exit status, stdout, truncation, and 64 KiB aggregate limit |

UI support is capability-based. RPC may provide UI, while a headless context may not. Without UI, `notify` and `setStatus` degrade; `confirm` denies by default.

The log rotates at 10 MiB by default and keeps one `.1` file. See the canonical [environment-variable table](./setup.md#environment-variables) for overrides.
