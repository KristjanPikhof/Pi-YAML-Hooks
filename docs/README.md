# pi-yaml-hooks documentation

Hook bash, follow-up prompts, and host UI actions onto tool calls and session events from one `hooks.yaml` file. The same package runs in Pi and OMP. This directory is the full reference; the top-level README covers native installs and a 60-second tour.

## Start here

- [`setup.md`](./setup.md): install in Pi or OMP, choose hook file locations, trust project hooks, and read the canonical environment-variable table
- [`hooks-reference.md`](./hooks-reference.md): exact hook fields, events, conditions, actions, and host behavior
- [`agent-authoring-guide.md`](./agent-authoring-guide.md): practical rules for people and agents writing `hooks.yaml`
- [`debugging-hooks.md`](./debugging-hooks.md): persistent hook logs, tailing, and debugging workflow
- [`examples/`](./examples/): copy-paste examples for each major capability
- [`maintaining.md`](./maintaining.md): maintainer-only compatibility matrices and runtime smoke checklists

## What pi-yaml-hooks can do

- Run `bash` before or after tool calls
- Block pre-tool calls from `bash` hooks with exit code `2` and `action: stop`
- Ask for user confirmation before a tool runs
- Show UI notifications and status entries when the active host exposes the required UI capability
- Send follow-up prompts back into the current host session with `tool:` actions
- React to session lifecycle events: `session.created`, `session.idle`, and `session.deleted`
- React to `file.changed`, which PI synthesizes after recognized file mutations, including `cp`/`git cp`, `mv`/`git mv`, `rm`/`git rm`, `touch`, and `mkdir`
- Filter hooks by file extension or glob patterns, including post-tool mutation hooks with changed paths
- Restrict hooks to `all`, `main`, or `child` sessions
- Queue selected hooks asynchronously so they do not block the agent turn
- Layer one host-native global root hook file and one trusted project root hook file, with a trust-gated legacy `.pi` project fallback on OMP

## Important host realities

These are the details that matter most when authoring hooks in Pi or OMP:

- The Pi SDK compatibility matrix retains 0.74.0 and 0.79.3. Runtime smoke testing used Pi 0.80.7 and OMP 17.0.1; this does not claim support for a wider version range.
- Only one global root config and one project root config are discovered.
- Project-root imports require pi-yaml-hooks project-hook trust. Host package trust is separate and does not activate project hooks here. Global-root imports require `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1`; package imports require `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1`; project imports outside the trust anchor require `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`.
- OMP uses the active profile's agent directory and separate trust store. Global discovery stays inside that agent directory. For project config, native `.omp` wins before a legacy `.pi` fallback, and the fallback still requires OMP trust.
- Later files stay compatible with the same explicit `override:` / `disable:` behavior by `id`.
- Project hook files are ignored until the repo or worktree trust anchor is trusted through `/hooks-trust`, the active host's `trusted-projects.json`, or `PI_YAML_HOOKS_TRUST_PROJECT=1`.
- `command:` actions are rejected at load time.
- `tool:` does not imperatively invoke a tool. Pi or OMP receives a follow-up prompt in the current session.
- `confirm:` blocks only on `tool.before.*` hooks.
- `session.deleted` is best-effort and intentionally lossy: PI fires it for shutdown and for session switches like `/new`, `/resume`, and `/fork`; `pi-yaml-hooks` forwards PI's `reason` (`quit`, `reload`, `new`, `resume`, or `fork`) on the envelope so hooks can disambiguate.
- `file.changed` is synthesized from recognized mutation tools. On stock PI that means `write`, `edit`, and some `bash` commands such as `cp`, `mv`, `rm`, `touch`, and `mkdir`.
- Type-only consumers can `import type { HookConfig, HookEvent, BashHookContext, SessionDeletedReason } from "pi-yaml-hooks/types"`. The subpath ships only types; runtime imports go through `pi-yaml-hooks`.

## Recommended reading order

This is the canonical reading order. The top-level README links here.

If you are new to the project:

1. Read [`setup.md`](./setup.md)
2. Skim [`hooks-reference.md`](./hooks-reference.md)
3. Copy from [`examples/`](./examples/)
4. Keep [`agent-authoring-guide.md`](./agent-authoring-guide.md) open while writing new hooks

If you are releasing or widening SDK support, also work through [`maintaining.md`](./maintaining.md).
