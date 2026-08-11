# Setup

## Requirements

- macOS or Linux
- Node.js `>=22.19.0`
- `bash` on `PATH`
- Pi or OMP

Windows is unsupported.

## Install

```bash
# Pi
pi install npm:pi-yaml-hooks

# OMP
omp plugin install pi-yaml-hooks
```

For a named OMP profile, use the same profile when installing and running:

```bash
omp --profile work plugin install pi-yaml-hooks
omp --profile work
```

| Task | Pi | OMP |
|---|---|---|
| Update | `pi update npm:pi-yaml-hooks` | `omp plugin install --force pi-yaml-hooks` |
| Remove | `pi uninstall npm:pi-yaml-hooks` | `omp plugin uninstall pi-yaml-hooks` |
| Local checkout | `pi install ./` | `omp plugin link .` |

Pi also supports a one-off run with `pi -e npm:pi-yaml-hooks`. Add `-l` to Pi install or uninstall commands to use the current project's `.pi/settings.json`.

## Create a hook file

Choose one path:

| Host and scope | Preferred path |
|---|---|
| Pi global | `~/.pi/agent/hook/hooks.yaml` |
| Pi project | `<project>/.pi/hook/hooks.yaml` |
| OMP default global | `~/.omp/agent/hook/hooks.yaml` |
| OMP named-profile global | `~/.omp/profiles/<profile>/agent/hook/hooks.yaml` |
| OMP project | `<project>/.omp/hook/hooks.yaml` |

Add a small hook first:

```yaml
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
```

Start Pi or OMP, then run `/hooks-status`. It should list the file and one active hook.

## File discovery

The extension loads the first existing global candidate and the first project candidate. It never merges multiple roots from the same scope.

### Pi

Global candidates:

1. `~/.pi/agent/hook/hooks.yaml`
2. `~/.pi/agent/hooks.yaml`

Project candidates:

1. `<project>/.pi/hook/hooks.yaml`
2. `<project>/.pi/hooks.yaml`

### OMP

Global candidates under the active OMP agent directory:

1. `<agent-dir>/hook/hooks.yaml`
2. `<agent-dir>/hooks.yaml`

Project candidates in each directory, from the current directory up to the repo or worktree root:

1. `.omp/hook/hooks.yaml`
2. `.omp/hooks.yaml`
3. `.pi/hook/hooks.yaml`
4. `.pi/hooks.yaml`

The first directory containing a candidate wins. A nearby legacy `.pi` file can therefore win over a parent `.omp` file. OMP still requires OMP trust for a legacy `.pi` project file.

## Trust project hooks

Project hooks can run shell commands with your user permissions. They load only when the repo or worktree anchor is trusted.

Run this once inside the active host:

```text
/hooks-trust
```

Trust stores are separate:

| Host | Trust store |
|---|---|
| Pi | `~/.pi/agent/trusted-projects.json` |
| OMP default | `~/.omp/agent/trusted-projects.json` |
| OMP named profile | `~/.omp/profiles/<profile>/agent/trusted-projects.json` |

For temporary trust, start the host with `PI_YAML_HOOKS_TRUST_PROJECT=1`. Host package trust does not replace hook trust.

## Import hook files

A root file may load files or directories before its own hooks:

```yaml
imports:
  - ./hooks.d
  - ./shared.yaml

hooks:
  - event: session.created
    actions:
      - notify: "Ready"
```

Imports follow these rules:

- relative paths resolve from the importing file
- directory imports load `.yaml` and `.yml` files in lexical order
- duplicate canonical paths load once
- missing imports and cycles fail validation
- imported files inherit the root's global or project scope
- global root imports require `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1`
- package imports require `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1`
- project imports outside the trust anchor require `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`

The extension loads global imports and hooks first, then trusted project imports and hooks. A later hook replaces an earlier hook only through an explicit `override:` by `id`.

## Reload and commands

The extension watches the selected files. A later event reloads them when size or modification time changes. If the new config is invalid, the last valid set stays active.

| Command | Use |
|---|---|
| `/hooks-status` | Show selected files, hook counts, trust, and log path |
| `/hooks-validate` | Validate selected files and explain skipped project hooks |
| `/hooks-trust` | Trust the current repo or worktree anchor |
| `/hooks-reload` | Ask the host to reload extensions |
| `/hooks-tail-log` | Print or follow the active structured log |

## Environment variables

This is the canonical environment-variable table.

| Variable | Effect |
|---|---|
| `PI_YAML_HOOKS_ENABLE_USER_BASH=1` | Route human `!` and `!!` commands through `tool.before.bash` hooks |
| `PI_YAML_HOOKS_TRUST_PROJECT=1` | Trust the current project for this process |
| `PI_YAML_HOOKS_PROMPT_AWARENESS=0` | Disable the agent-start hook summary |
| `PI_YAML_HOOKS_BASH_EXECUTABLE` | Set the bash executable; default is `bash` |
| `PI_YAML_HOOKS_MAX_OUTPUT_BYTES` | Set each stdout and stderr capture cap; default is 1 MiB |
| `PI_YAML_HOOKS_MAX_STDIN_BYTES` | Set the bash stdin payload cap; default is 256 KiB |
| `PI_YAML_HOOKS_ENV_ALLOWLIST` | Pass only the listed inherited environment variables, plus required hook context variables |
| `PI_YAML_HOOKS_ASYNC_MAX_PENDING` | Set the pending limit per async lane; default is `1000` |
| `PI_YAML_HOOKS_ASYNC_WATCHDOG_MS` | Log a warning when an async run exceeds this time; it does not cancel the run |
| `PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE=1` | Approve `confirm:` without UI; intended for tests |
| `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1` | Allow imports from a global root file |
| `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1` | Allow package imports through Node resolution |
| `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1` | Allow project imports outside the trusted anchor |
| `PI_YAML_HOOKS_DEBUG=1` | Enable debug-level persistent logging |
| `PI_YAML_HOOKS_LOG_LEVEL` | Set `debug`, `info`, `warn`, or `error` |
| `PI_YAML_HOOKS_LOG_FILE` | Override the active profile's log path |
| `PI_YAML_HOOKS_LOG_MAX_BYTES` | Rotate the log at this size; default is 10 MiB |
| `PI_YAML_HOOKS_LOG_STDERR=1` | Mirror structured logs to stderr |

## Direct imports

Most users should let Pi or OMP load the package. Embedders may import the compiled entries and public types:

```ts
import PiHooks from "pi-yaml-hooks"
import OmpHooks from "pi-yaml-hooks/extensions/omp-yaml-hooks"
import type { BashHookContext, HookConfig } from "pi-yaml-hooks/types"
```

Continue with [Examples](./examples.md) or the [Hooks reference](./hooks-reference.md).
