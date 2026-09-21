# pi-yaml-hooks

`pi-yaml-hooks` runs YAML-configured hooks in [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi). Use it to guard tool calls, react to file and session events, add context to a prompt, or show UI feedback.

The same package and hook format work in both hosts.

## Quick start

Install the package for your host:

```bash
# Pi
pi install npm:pi-yaml-hooks

# OMP
omp plugin install pi-yaml-hooks
```

Create a global hook file:

```bash
# Pi
mkdir -p ~/.pi/agent/hook

# OMP default profile
mkdir -p ~/.omp/agent/hook
```

Save this as `~/.pi/agent/hook/hooks.yaml` for Pi or `~/.omp/agent/hook/hooks.yaml` for OMP:

```yaml
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
```

Start the host and run:

```text
/hooks-status
```

The command shows which files loaded, the project trust state, and the active log path.

## What you can configure

| Surface | Supported values |
|---|---|
| Events | `user.prompt.submit`, `tool.before.*`, `tool.after.*`, `file.changed`, `session.created`, `session.idle`, `session.deleted` |
| Actions | `bash`, `tool`, `notify`, `confirm`, `setStatus` |
| Conditions | `matchesCodeFiles`, `matchesAnyPath`, `matchesAllPaths` |
| Session scope | `all`, `main`, `child` |
| Commands | `/hooks-status`, `/hooks-validate`, `/hooks-trust`, `/hooks-reload`, `/hooks-tail-log` |

`bash` actions receive JSON on stdin and `PI_*` context variables. A `tool.before.*` bash action can block a tool call by exiting with code `2`. A `user.prompt.submit` bash action can return system context for the same turn on stdout.

See [examples](./docs/examples.md) for copyable hooks and [the reference](./docs/hooks-reference.md) for the full schema.

## Config files and trust

`pi-yaml-hooks` loads at most one global root file and one project root file.

| Host | Global root | Project root |
|---|---|---|
| Pi | `~/.pi/agent/hook/hooks.yaml` | `<project>/.pi/hook/hooks.yaml` |
| OMP default profile | `~/.omp/agent/hook/hooks.yaml` | `<project>/.omp/hook/hooks.yaml` |
| OMP named profile | `~/.omp/profiles/<profile>/agent/hook/hooks.yaml` | `<project>/.omp/hook/hooks.yaml` |

Project hooks can execute shell commands, so they do not load until you trust the repo or worktree anchor. Run `/hooks-trust` in the matching host. Pi and OMP keep separate trust stores.

Root files may import other YAML files. Global imports, package imports, and project imports outside the trust anchor each require an explicit environment opt-in. [Setup](./docs/setup.md) explains paths, trust, imports, and all environment variables.

## Important behavior

- `tool:` sends a follow-up prompt to the current session. It does not call a tool directly.
- `command:` is unsupported and rejected while loading hooks.
- `action: stop` works only on `tool.before.*`.
- `action: modify` also works only on `tool.before.*`. A bash hook prints `{"tool_args": {...}}` on stdout to replace the arguments for the current call. Hosts without argument rewriting run the original arguments and log a skip.
- `user.prompt.submit` is synchronous, bash-only, and fail-open. It cannot rewrite or block the prompt.
- `runIn: main` does not change bash process context. Prefer `scope` for routing.
- UI actions run only when the current host context exposes the required UI method. `confirm` denies by default without UI.
- `session.deleted` is best-effort. Treat its optional host reason as an opaque string.
- Human `!` and `!!` commands are intercepted only when `PI_YAML_HOOKS_ENABLE_USER_BASH=1` is set. Trusted hooks can then read and block those commands.
- Pi `0.86` and later append hook awareness and `user.prompt.submit` context through the host's prompt sections, which keeps the prompt cache warm. Older hosts get the same text appended to the system prompt string.

## Requirements and compatibility

- macOS or Linux
- Node.js `>=22.19.0`
- `bash` on `PATH`

The compatibility matrix tests exact Pi SDK pairs `0.74.0`, `0.79.3`, `0.80.10`, `0.84.1`, `0.85.1`, and `0.86.1`. Runtime smoke testing uses Pi `0.86.1`. OMP compile, test, and runtime rows cover exact `17.0.1`, `17.2.12`, and `18.2.6`. The `0.74.0` and `0.79.3` rows are the supported floor. These are verified versions, not an open-ended support range.

Windows is unsupported.

## Documentation

| Need | Read |
|---|---|
| Install, paths, trust, imports, environment | [Setup](./docs/setup.md) |
| Events, fields, actions, payloads | [Hooks reference](./docs/hooks-reference.md) |
| Copyable configurations | [Examples](./docs/examples.md) |
| Diagnose loading and runtime behavior | [Debugging hooks](./docs/debugging-hooks.md) |
| Release and compatibility checks | [Maintaining](./docs/maintaining.md) |

Complete script-backed examples live in [`examples/`](./examples/).

## License

MIT
