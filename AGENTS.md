# AGENTS.md

Agent contract for `pi-yaml-hooks`. Facts only; tutorials live in `docs/`. Keep this file compact and implementation-oriented.

## Facts

- Runtime: `pi-yaml-hooks` PI extension. Type-only: `pi-yaml-hooks/types` re-exports `HookConfig`, `HookEvent`, `BashHookContext`, `SessionDeletedReason`; smoke: `src/public-types-smoke.test.ts`.
- Node `>=22.19.0`; macOS/Linux only (`src/pi/register-adapter.ts` guards win32).
- Pi host peers: `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` as `*`; dev-tested at `0.79.3`; matrix still covers `0.74.0`.
- Never add direct `@mariozechner/*` host deps; transitive `@mariozechner/clipboard` may appear under Pi SDK packages in `package-lock.json`.
- `package-lock.json` is canonical; do not add `bun.lock`.

## Layout

| Path | Notes |
|---|---|
| `src/index.ts` | PI extension entry; registers PI policy, adapter, commands, autocomplete, diagnostics, prompt support. |
| `src/core/` | Host-agnostic. `runtime.ts` owns per-runtime state; `load-hooks.ts` is a barrel; hook loading is in `core/hooks/*`; dispatch/actions/path/async are in `core/runtime/*`. Never import `src/pi/*` or PI SDK types from core. |
| `src/pi/` | PI adapter, register/lifecycle/registry, event mappers, commands, autocomplete, diagnostics, prompt, `user_bash`, session lineage, unsupported policy. `adapter.ts` is a barrel. |
| `extensions/` | TS entrypoints loaded by PI/jiti; `extensions/index.ts` -> `extensions/pi-yaml-hooks/index.ts` -> `src/index.ts`; local-dev symlink target. |
| `examples/` | Shipped: `pre-tool-developer-guards`, `post-tool-developer-feedback`, `README.md`. Repo-only: `atomic-commit-snapshot-worker`, snapshot helpers; do not call them built-ins. |
| `scripts/` | Test runner, SDK matrix, tail-log helper, manual PI smoke helpers. |
| `dist/` | Generated; do not edit. `build`/`build:publish` regenerate extension stubs. |

## Runtime contracts

- Events: `tool.before.*`, `tool.after.*`, `file.changed`, `session.{created,idle,deleted}`.
- Actions: `bash`, `tool`, `notify`, `confirm`, `setStatus`.
- Commands: `/hooks-{status,validate,trust,reload,tail-log}`.
- Diagnostics use PI custom messages when available; hook-awareness prompt injection runs at agent start.
- `command:` actions are rejected at load.
- `tool:` injects a follow-up prompt into the current PI session; it does not imperatively execute tools or target other sessions.
- `runIn: main` is rejected for non-`bash`; for bash it does not change process/session context. Prefer `scope` for main-vs-child routing.
- `action: stop` only affects `tool.before.*`; `async: true` + `action: stop` is rejected at parse time and runtime warns once per source/runtime.
- `session.deleted.reason` is an optional opaque string; known PI values include `quit|reload|new|resume|fork`.
- UI actions (`notify`, `confirm`, `setStatus`) gate on `ctx.hasUI` + the UI method. RPC may expose UI in Pi 0.79+; no-UI/headless degrades and `confirm` fails closed.
- `/hooks` autocomplete is TUI-only: register only when `ctx.mode === "tui"` or older SDKs omit `mode`, and `ctx.ui.addAutocompleteProvider` exists.
- `user_bash` opt-in: `PI_YAML_HOOKS_ENABLE_USER_BASH=1`.
- `tool_args` are redacted by `sanitizeToolArgsForSerialization` before bash stdin (`src/core/runtime/actions.ts`).

## Paths and conditions

- `matchesCodeFiles`: legacy single-file events.
- `matchesAnyPath` / `matchesAllPaths`: only on `file.changed`, `session.idle`, and `tool.after.*` when paths exist.
- Path filters never match pathless/non-mutating tool events.
- Mutation paths come from `src/core/tool-paths.ts`: `write|edit|multiedit|patch|apply_patch|bash`; treat unknown tools as pathless.

## Config, trust, imports

- At most one global root config + one project root config.
- Project discovery is repo/worktree-aware, not exact-cwd-only.
- Hook trust is separate from Pi package/project trust; project hooks/imports are ignored until the repo/worktree anchor is trusted by pi-yaml-hooks.
- Persistent trust: `~/.pi/agent/trusted-projects.json`; entries must be absolute canonical repo/worktree anchors.
- Shortcuts: `/hooks-trust` or `PI_YAML_HOOKS_TRUST_PROJECT=1`.
- Global-root imports need `PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS=1`; package imports need `PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS=1`.
- Project imports must canonicalize inside the trusted anchor; bypass with `PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR=1`.
- `HookPolicy` (`src/core/types.ts`) plugs host diagnostics into the loader; core ships `NOOP_POLICY`; `src/pi/unsupported.ts` registers the PI policy via `setActiveHookPolicy`.

## Caps

Key caps: YAML 1 MiB; import/canonicalize depth 32; snapshot LRU 16; runtime registry per-cwd LRU 8; recursion depth 32; per-pattern glob LRU 256; pending tool calls 1000 with 5 min TTL/FIFO; `tool_args` 64 KiB; session lineage cache 64 / depth 64 / header 64 KiB. Check constants/docs when changing limits.

## Commands

| Command | Use |
|---|---|
| `npm install` | Install/update deps. |
| `npm run typecheck` | After TS changes. |
| `npm run build` | Compile and generate `dist/extensions/*`; run before direct `dist/**/*.test.js`. |
| `npm run test:internal` | Full internal suite: build + `node scripts/run-tests.mjs`. Known flake: `timed out bash hooks kill descendant background processes on POSIX`. |
| `npm test` | Consumer no-op; not validation. |
| `npm run compat:sdk-matrix` | Temp-copy matrix for SDK `0.74.0` + `0.79.3`; runs typecheck + internal tests. |
| `npm run compat:sdk-matrix:dry-run` | Print matrix workflow only. |
| `npm run compat:sdk-matrix:future` | Advisory `0.80.x` probe; does not change claims. |
| `bash scripts/check-sdk-matrix.sh --versions "0.74.0 0.79.3"` | Override SDK specs. |
| `scripts/smoke/pi-runtime-smoke.sh` | Prepares temp smoke project/evidence and prints manual `pi -e <checkout>/extensions/index.ts`; interactive smoke is still manual. |

No lint script exists; validate with typecheck/tests/matrix as needed.

## Generated output and publishing

- `dist/` is generated; never hand-edit.
- `prepack` runs clean `build:publish` via `tsconfig.publish.json`.
- Package contents follow `package.json#files`; update it when adding shipped examples/scripts.
- `scripts/tail-hook-log.sh` backs `/hooks-tail-log` and is packaged.

## Docs

- Env vars canonical source: [`docs/setup.md#environment-variables`](docs/setup.md#environment-variables). Do not duplicate env tables here.
- Built-ins ≠ examples.
- Say `action: stop`, not `behavior: stop`.
- Mark opt-in features explicitly.
- Name trust anchors: cwd, project root, or repo/worktree anchor.
- `tool:` docs must say PI receives a follow-up prompt.
- Keep runtime smoke and SDK-widening evidence with release notes/SDK-widening PRs.

## Pitfalls

- Local atomic-commit hook may auto-commit per Edit/Write; expect one commit per edit in this environment.
- Future SDK pass is advisory; widening support also needs runtime smoke evidence for slash commands, custom messages, RPC/TUI UI actions, TUI autocomplete, lifecycle hooks, and no-builtin-tools behavior.
- Future matrix may fail on stale session-bound regex wording; inspect `scripts/check-sdk-matrix.sh` before broadening claims.
