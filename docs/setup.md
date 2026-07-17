# Setup

This guide installs `pi-yaml-hooks` natively in Pi or OMP, then gives you a safe place to put the same `hooks.yaml`.

## Requirements

- macOS or Linux
- Node.js `>= 22.19.0`
- `bash` on `PATH`
- Pi or OMP

Windows is unsupported because the hook runner expects a POSIX `bash`.

The package lists both hosts' SDK packages as optional peer dependencies and as dev dependencies for local typechecking only. The retained Pi compatibility checks use SDK 0.74.0 and 0.79.3. End-to-end runtime behavior was tested with Pi 0.80.7 and OMP 17.0.1. Do not read those runtime versions as a broader support range.

## Install the extension

One published package contains native manifests for Pi and OMP. Use the command for your host.

```bash
# Pi
pi install npm:pi-yaml-hooks

# OMP
omp plugin install pi-yaml-hooks
```

These commands discover the correct entry point. Do not add `-e` or `--extension`, create an extension symlink, set an extension-path environment variable, or copy an entry-point file.

For a named OMP profile, install and run under the same profile:

```bash
omp --profile work plugin install pi-yaml-hooks
omp --profile work
```

OMP supplies the active agent directory to the extension. The default profile uses `~/.omp/agent`; a named profile such as `work` uses `~/.omp/profiles/work/agent`.

### Manage an installed package

| Task | Pi | OMP |
|---|---|---|
| Install | `pi install npm:pi-yaml-hooks` | `omp plugin install pi-yaml-hooks` |
| Update | `pi update npm:pi-yaml-hooks` | `omp plugin install --force pi-yaml-hooks` |
| Remove | `pi uninstall npm:pi-yaml-hooks` | `omp plugin uninstall pi-yaml-hooks` |

Pi writes a normal install to `~/.pi/agent/settings.json`. Add `-l` to `pi install` or `pi uninstall` to operate on the current project's `.pi/settings.json`.

To install unreleased Pi changes from git:

```bash
# SSH
pi install git:git@github.com:KristjanPikhof/pi-yaml-hooks

# HTTPS
pi install https://github.com/KristjanPikhof/pi-yaml-hooks
```

For a one-off Pi run that does not change settings:

```bash
pi -e npm:pi-yaml-hooks
```

### Add the Pi package through `packages`

If you prefer to edit Pi settings directly, add the npm source to the `packages` array.

**Global**, in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-yaml-hooks"
  ]
}
```

**Project-local**, in `.pi/settings.json`:

```json
{
  "packages": [
    "npm:pi-yaml-hooks"
  ]
}
```

Pi auto-installs missing project packages on startup. Global packages still need an explicit `pi install`.

### Work from a local checkout

Run the host's native local-development command from the repository root:

```bash
# Pi records the local package source
pi install ./

# OMP links the package working tree
omp plugin link .
```

OMP reads the package's `omp.extensions` manifest, so edits continue to use `extensions/omp-yaml-hooks/index.ts` without a hand-created extension path. Use the normal remove command when you finish.

### Import it as an npm library

Use direct imports only when embedding the library in another tool rather than letting Pi or OMP manage the install:

```ts
import PiHooks from 'pi-yaml-hooks';
import OmpHooks from 'pi-yaml-hooks/extensions/omp-yaml-hooks';
import type { HookConfig, BashHookContext } from 'pi-yaml-hooks/types';
```

The package exposes:

- `.` to the compiled Pi extension and public type re-exports
- `./types` to the public type surface
- `./extensions/pi-yaml-hooks` to the compiled Pi entry point
- `./extensions/omp-yaml-hooks` to the compiled OMP entry point

The published `pi.extensions` and `omp.extensions` manifests select their respective TypeScript entry points. The tarball also ships compiled `dist/` modules for direct import consumers. `npm install pi-yaml-hooks` requires Node.js `>= 22.19.0`; standalone TypeScript consumers must provide the SDK packages needed by the host entry point they import.

## Create your first hook file

The following global quick starts use identical YAML.

### Pi global config

```bash
mkdir -p ~/.pi/agent/hook
cat > ~/.pi/agent/hook/hooks.yaml <<'YAML'
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

pi
```

### OMP global config

For the default profile:

```bash
mkdir -p ~/.omp/agent/hook
cat > ~/.omp/agent/hook/hooks.yaml <<'YAML'
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

omp
```

For a named profile, replace `~/.omp/agent` with `~/.omp/profiles/<profile>/agent` and start OMP with `omp --profile <profile>`.

In either host, validate discovery from the agent:

```text
/hooks-status
```

The global path in the status output should match the file you created. Startup also reports:

```text
[pi-yaml-hooks] Loaded 1 hook (global: 1, project: 0).
```

### Project config

Project hooks are opt-in and require trust. These two examples again use identical YAML.

**Pi**

```bash
mkdir -p .pi/hook
cat > .pi/hook/hooks.yaml <<'YAML'
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

pi
```

**OMP**

```bash
mkdir -p .omp/hook
cat > .omp/hook/hooks.yaml <<'YAML'
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
YAML

omp
```

Run `/hooks-trust` once in the matching host, then run `/hooks-status`. The status output should show the project file as trusted and active.

## Hook file locations

`pi-yaml-hooks` selects at most one global root file and one project root file. Within each scope, the first existing candidate wins.

### Pi precedence

Global:

1. `~/.pi/agent/hook/hooks.yaml`
2. `~/.pi/agent/hooks.yaml`

Project:

1. `<project>/.pi/hook/hooks.yaml`
2. `<project>/.pi/hooks.yaml`

### OMP precedence

Let `<active-agent-dir>` be `~/.omp/agent` for the default profile or `~/.omp/profiles/<profile>/agent` for a named profile.

Global:

1. `<active-agent-dir>/hook/hooks.yaml`
2. `<active-agent-dir>/hooks.yaml`

Project:

1. `<project>/.omp/hook/hooks.yaml`
2. `<project>/.omp/hooks.yaml`
3. `<project>/.pi/hook/hooks.yaml`
4. `<project>/.pi/hooks.yaml`

OMP's project-level `.pi` entries are legacy fallbacks. Project discovery walks upward from the working directory and checks `.omp` before `.pi` within each directory, so a nearer `.pi` file wins over a parent directory's `.omp` file. Only one project file loads. Global discovery stays inside the active OMP profile's agent directory.

Windows is not a supported runtime, even if some internal path discovery code recognizes Windows-style locations.

A root file may declare top-level imports when the relevant gate allows it:

```yaml
imports:
  - ./hooks.d
  - ./base.yaml
  - my-shared-hooks
hooks:
  - event: session.created
    actions:
      - notify: "ready"
```

Import rules:

- project-root imports require the repo or worktree trust anchor to be trusted
- global-root imports require `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1`
- package imports require `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1`
- project imports outside the trust anchor require `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`
- imports load before the importing file's own hooks
- relative imports resolve from the importing file
- non-relative imports resolve through Node module resolution when package imports are enabled
- directory imports expand files in stable lexical order
- repeated imports are deduped by canonical path
- import cycles and missing imports are load errors
- imported files inherit the root file scope (`global` or `project`)
- trust is still decided only at the discovered project root file

## Trust project hooks

Project hooks are opt-in because they can run arbitrary `bash` with your user permissions. Trust is evaluated against the repo or worktree trust anchor.

### Trust for one session

The retained environment variable works with either host:

```bash
PI_YAML_HOOKS_TRUST_PROJECT=1 pi
PI_YAML_HOOKS_TRUST_PROJECT=1 omp
```

### Save trust

The simplest method is to run this command inside the active host:

```text
/hooks-trust
```

Each host has a separate trust store:

| Host | Trust store |
|---|---|
| Pi | `~/.pi/agent/trusted-projects.json` |
| OMP default profile | `~/.omp/agent/trusted-projects.json` |
| OMP named profile | `~/.omp/profiles/<profile>/agent/trusted-projects.json` |

The file contains absolute trust-anchor paths:

```json
[
  "/Users/me/code/my-project"
]
```

Pi trust does not activate OMP project hooks, and OMP trust does not activate Pi project hooks. An OMP legacy `.pi` project fallback still requires trust in the active OMP profile's store. OMP does not read Pi's trust store for that fallback.

If a project hook file exists but its trust anchor is not trusted by the active host, `pi-yaml-hooks` prints a warning once and skips that file. Host package trust is separate and does not activate project hooks here.

For nested packages, monorepos, and linked worktrees, `pi-yaml-hooks` resolves the nearest project hook root up to the current git worktree root and evaluates trust against that repo or worktree anchor, not just the current cwd string.

## How loading works

The load order is:

1. enabled global root file imports, then global root hooks
2. trusted project root file imports, then project root hooks

That means:

- roots and enabled imports can contribute active hooks
- global-root imports are refused with a validation error unless `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1` is set
- package imports are refused with a validation error unless `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1` is set
- project imports outside the trust anchor are refused with a validation error unless `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1` is set
- the project root does not automatically replace the global root
- replacement only happens when the later file uses `override:` against a hook `id`

For exact override behavior, see [`hooks-reference.md`](./hooks-reference.md).

## Hook file reload behavior

`pi-yaml-hooks` re-checks discovered hook files on later events. If file size or modification time changes, it reloads the active hook set automatically.

In practice this means:

- edit `hooks.yaml`
- trigger another host event
- the new hook set is picked up without reinstalling the extension

If reload fails, the host keeps the last known good hook set and logs the parse errors.

## Native `/hooks-*` commands

Once the extension is loaded, Pi and OMP expose these helper commands:

- `/hooks-status`: inspect the active hook summary, paths, trust state, and log file
- `/hooks-validate`: validate active hooks and explain whether the project file is valid but untrusted
- `/hooks-trust`: trust the current project without manually editing `trusted-projects.json`
- `/hooks-reload`: asks the host to reload extensions; edited hooks also refresh lazily on the next relevant event, while in-flight hooks finish under the previous config
- `/hooks-tail-log`: show the log file path and a ready-made tail command; pass `--follow` to start a detached live tail, or `--path` to print only the log file path

## Environment variables

This is the canonical environment-variable reference for `pi-yaml-hooks`. The existing `PI_YAML_HOOKS_*` names are retained in both Pi and OMP. Other docs link here.

| Variable | Effect |
|---|---|
| `PI_YAML_HOOKS_ENABLE_USER_BASH` | `=1` routes human `!` / `!!` shell commands through `tool.before.bash` hooks |
| `PI_YAML_HOOKS_TRUST_PROJECT` | `=1` temporarily trusts the current project for the session |
| `PI_YAML_HOOKS_PROMPT_AWARENESS` | `=0` disables the hook-awareness note appended to the system prompt |
| `PI_YAML_HOOKS_BASH_EXECUTABLE` | Override the bash executable path |
| `PI_YAML_HOOKS_MAX_OUTPUT_BYTES` | Per-stream stdout/stderr capture cap. Default `1048576` (1 MiB). |
| `PI_YAML_HOOKS_MAX_STDIN_BYTES` | Stdin payload cap to bash hooks. Default `262144` (256 KiB). |
| `PI_YAML_HOOKS_ENV_ALLOWLIST` | Optional comma-separated inherited-env allowlist for bash hooks. When set, only listed inherited variables (for example `PATH,HOME,NPM_TOKEN`) are passed, plus required PI/OPENCODE context variables. |
| `PI_YAML_HOOKS_ASYNC_MAX_PENDING` | Per-lane async hook pending cap. Default `1000`; extra queued runs are dropped with a warning. |
| `PI_YAML_HOOKS_ASYNC_WATCHDOG_MS` | Optional per-run async hook watchdog. When set to a positive integer, a still-running async hook logs a `watchdog_timeout` warning after this many milliseconds; it is not canceled and its lane remains occupied until it settles. |
| `PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE` | `=1` auto-accepts `confirm:` instead of denying in headless mode (testing only) |
| `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS` | `=1` allows top-level `imports:` in the global root config |
| `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS` | `=1` allows bare-specifier imports resolved through `node_modules` |
| `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR` | `=1` allows project imports whose target falls outside the project's trust anchor |
| `PI_YAML_HOOKS_DEBUG` | `=1` enables verbose, persistent NDJSON logging |
| `PI_YAML_HOOKS_LOG_LEVEL` | Set the log level explicitly: `debug`, `info`, `warn`, or `error` |
| `PI_YAML_HOOKS_LOG_FILE` | Set a non-empty log file override; empty or whitespace-only values are treated as unset. The default is `<active-agent-dir>/logs/pi-yaml-hooks.ndjson`: `~/.pi/agent/...` for Pi, `~/.omp/agent/...` for OMP's default profile, or `~/.omp/profiles/<profile>/agent/...` for a named OMP profile. |
| `PI_YAML_HOOKS_LOG_MAX_BYTES` | Rotate the structured log file once it exceeds this many bytes (positive integer). Default `10485760` (10 MiB). On rotation the live file is renamed to `<path>.1`, replacing any prior `.1`. |
| `PI_YAML_HOOKS_LOG_STDERR` | `=1` mirrors structured log entries to stderr |

## First troubleshooting steps

1. Check Node: `node --version`
2. Check bash: `which bash`
3. Start Pi or OMP and look for `[pi-yaml-hooks] Loaded ...`
4. Run `/hooks-status` and confirm the selected global and project paths
5. If using project hooks, confirm the active host's trust store contains the trust anchor
6. If using UI actions, make sure the host is running with a UI surface

## Maintainer-only checks

The Pi and OMP runtime smoke checklists and Pi SDK compatibility matrix details live in [`maintaining.md`](./maintaining.md). Skip that file unless you are releasing or widening SDK support.

## Next step

Once the extension loads, continue with [`hooks-reference.md`](./hooks-reference.md) or copy from [`examples/`](./examples/).
