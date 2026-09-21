# Hooks reference

This page describes the YAML contract shared by Pi and OMP.

## File shape

```yaml
imports:
  - ./hooks.d

hooks:
  - id: example
    event: file.changed
    scope: all
    conditions:
      - matchesAnyPath:
          - "src/**"
    actions:
      - notify: "Source changed"
```

`hooks` must be an array. `imports` is optional and is covered in [Setup](./setup.md#import-hook-files). Active and replacement hooks need a non-empty `actions` array. A disable-only override does not. Each action entry must contain exactly one action key.

## Hook fields

| Field | Required | Values | Behavior |
|---|---|---|---|
| `event` | yes | Supported event name | Selects when the hook runs |
| `actions` | yes | Non-empty action array | Runs actions in order |
| `id` | no | Non-empty string | Gives overrides and logs a stable name |
| `scope` | no | `all`, `main`, `child` | Filters the session lineage; default is `all` |
| `conditions` | no | Condition array | Requires every condition to pass |
| `action` | no | `stop`, `modify` | Accepted only on `tool.before.*` |
| `async` | no | boolean or queue object | Runs supported bash-only hooks in a background queue |
| `runIn` | no | `current`, `main` | Compatibility metadata; default is `current` |
| `override` | no | Earlier hook `id` | Replaces or disables an earlier hook |
| `disable` | no | boolean | Use with `override` to remove the earlier hook |

The `event` and `actions` fields are not required on `{ override: id, disable: true }` entries.

Prefer `scope` for routing. `runIn: main` is rejected for non-bash actions and does not change a bash process's session context.

## Events

| Event | When it runs | Notes |
|---|---|---|
| `user.prompt.submit` | After text expansion, before the agent loop | Bash-only; successful stdout becomes same-turn system context |
| `tool.before.*` | Before every tool call | The only event family that can block a tool |
| `tool.before.<name>` | Before the named tool | Tool names come from the host |
| `tool.after.*` | After every tool result | Cannot block the completed tool |
| `tool.after.<name>` | After the named tool result | May include changed paths for recognized mutation tools |
| `file.changed` | After a recognized file mutation | Synthesized by the extension, after post-tool hooks |
| `session.created` | At startup or a new session | Resume and fork signals are excluded |
| `session.idle` | After the turn settles with no queued continuation | Collected file changes are available here |
| `session.deleted` | During shutdown or session switch | Best-effort and deduplicated |

Custom tool names work with exact and wildcard tool events. Built-in tool names are not a closed set.

### Prompt context

`user.prompt.submit` hooks run synchronously in config order. They accept only `bash` actions and cannot use `async` or `action: stop`.

Each successful, non-empty stdout value becomes a system-context block for the current turn. Failed, timed-out, blocked, truncated, or empty output is ignored. The turn continues if a hook fails. Total accepted output is capped at 64 KiB per prompt; a block that does not fit is skipped in full.

The input contains expanded text only. Hooks cannot rewrite or reject the prompt, inspect attachments, or identify whether the prompt came from TUI, RPC, or another extension.

On Pi `0.86` and later, hook context is appended through the host's prompt sections instead of replacing `systemPrompt`, which keeps the host's prompt cache warm. Older hosts receive the same blocks appended to the system prompt string.

### File changes

`file.changed` is synthesized from recognized mutation results. Stock Pi and OMP support direct `write` and `edit` calls plus mutation-shaped bash commands using `rm`, `git rm`, `mv`, `git mv`, `cp`, `git cp`, `touch`, or `mkdir`.

Custom tools named `multiedit`, `patch`, or `apply_patch` can also provide mutation paths. Unknown and non-mutating tools are pathless.

### Session deletion

`session.deleted` is a cleanup signal, not proof that a session was permanently removed. Duplicate switch and shutdown signals collapse into one dispatch. If the host supplies a reason, the extension forwards it as opaque telemetry. Do not match against a fixed reason list.

## Conditions

All conditions must pass.

### `matchesCodeFiles`

```yaml
conditions:
  - matchesCodeFiles
```

This passes when the event contains at least one known code or config extension. It fails on pathless events.

### `matchesAnyPath`

```yaml
conditions:
  - matchesAnyPath:
      - "src/**/*.ts"
      - "package.json"
```

This passes when any changed path matches any listed glob.

### `matchesAllPaths`

```yaml
conditions:
  - matchesAllPaths: "docs/**"
```

This passes when every changed path matches at least one listed glob. The patterns form an allowlist. Use separate conditions for an intersection:

```yaml
conditions:
  - matchesAllPaths: "src/**"
  - matchesAllPaths: "**/*.ts"
```

Path conditions work on `file.changed`, `session.idle`, and `tool.after.*` events that contain changed paths. Paths inside the project are normalized to project-relative paths with forward slashes. Absolute paths outside the project stay absolute.

## Actions

### `bash`

```yaml
actions:
  - bash:
      command: "./scripts/check.sh"
      timeout: 15000
```

The short form is `bash: "command"`. Commands run through `bash -c` with a default 60-second timeout. JSON context is written to stdin, and stdout and stderr are captured separately.

On `tool.before.*`, exit code `2` blocks the tool. Other non-zero codes report a failed hook but do not block. Timeout uses code `124`; a spawn failure uses `127`.

### `tool`

```yaml
actions:
  - tool:
      name: bash
      args:
        command: "npm test"
```

This sends the current Pi or OMP session a follow-up prompt asking it to use the named tool. It does not execute the tool and cannot target another session.

### `notify`

```yaml
actions:
  - notify:
      text: "Build finished"
      level: info
```

The short form is `notify: "message"`. Levels are `info`, `success`, `warning`, and `error`; hosts map `success` to `info`. Without the required UI method, the action logs a degradation and continues.

### `confirm`

```yaml
actions:
  - confirm:
      title: "Run command?"
      message: "Approve this bash call."
```

`message` is required. Rejection blocks only on `tool.before.*`. Without UI, confirmation denies unless `PI_YAML_HOOKS_CONFIRM_AUTO_APPROVE=1` is set.

### `setStatus`

```yaml
actions:
  - setStatus: "Checking changes"
```

This writes a status entry keyed to the hook when the host exposes a status method. Without that method, it logs a degradation and continues.

### Unsupported `command`

`command:` actions are rejected while loading the hook. Use `bash:` to run a command or `tool:` to request a follow-up.

## Blocking

A hook can block only a `tool.before.*` event. Use a bash action that exits `2`, a rejected `confirm`, or `action: stop` with a blocking result.

```yaml
hooks:
  - id: guard-bash
    event: tool.before.bash
    action: stop
    actions:
      - bash: "./scripts/check-command.sh"
```

`action: stop` does not make a successful action block. It marks the hook's intended behavior; the action still needs to return a blocking result.

## Rewriting tool arguments

A `tool.before.*` hook can replace the arguments for the current call with `action: modify`. The bash action prints a JSON object on stdout:

```json
{ "tool_args": { "command": "ls -la" } }
```

```yaml
hooks:
  - id: normalize-bash-args
    event: tool.before.bash
    action: modify
    actions:
      - bash: "./scripts/rewrite-bash-args.sh"
```

- `action: modify` is accepted only on `tool.before.*`, and it cannot be combined with `async`.
- The stdout contract is an object with a top-level `tool_args` object. Empty stdout is ignored; invalid JSON, non-object JSON, or a non-object `tool_args` logs a warning and leaves the original arguments untouched.
- A block wins. When the same call also blocks, the replacement is dropped and the tool does not run.
- Multiple `modify` hooks merge in config order, with later hooks overwriting earlier keys.
- Pi `0.84` and later and OMP `18` and later apply the replacement. Older hosts run the original arguments and log a one-time skip.

## Async hooks

```yaml
hooks:
  - id: upload-result
    event: tool.after.write
    async:
      group: uploads
      concurrency: 2
    actions:
      - bash: "./scripts/upload.sh"
```

Async hooks accept only bash actions. They are not allowed on `tool.before.*`, `session.idle`, or `user.prompt.submit`.

`async: true` creates a serialized queue per event and session. A named `group` lets hooks share a queue. `concurrency` must be a positive integer and applies to that group. The pending cap defaults to 1,000 per lane; excess work is dropped with a warning.

The optional watchdog logs slow runs but does not cancel them. See `PI_YAML_HOOKS_ASYNC_WATCHDOG_MS` in [Setup](./setup.md#environment-variables).

## Overrides

A project file can replace a global hook by `id`:

```yaml
hooks:
  - override: idle-notify
    event: session.idle
    actions:
      - notify: "Project idle"
```

Or disable it:

```yaml
hooks:
  - override: idle-notify
    disable: true
```

The target must have loaded earlier. Duplicate IDs and missing targets fail validation.

## Bash input

Every bash action receives a JSON object on stdin:

```json
{
  "session_id": "session-123",
  "event": "tool.before.bash",
  "cwd": "/Users/me/project",
  "tool_name": "bash",
  "tool_args": {
    "command": "npm test"
  }
}
```

Optional fields are `prompt`, `files`, `changes`, `tool_name`, and `tool_args`. `changes` entries use these shapes:

```json
{ "operation": "create", "path": "src/new.ts" }
{ "operation": "modify", "path": "src/index.ts" }
{ "operation": "delete", "path": "src/old.ts" }
{ "operation": "rename", "fromPath": "old.ts", "toPath": "new.ts" }
```

Before serialization, `tool_args` is redacted and capped at 64 KiB. The full stdin payload defaults to a 256 KiB cap. An oversized payload becomes a reduced placeholder with truncation metadata.

## Bash environment

| Variable | Value |
|---|---|
| `PI_PROJECT_DIR` | Project directory for the event |
| `PI_WORKTREE_DIR` | Resolved worktree directory |
| `PI_SESSION_ID` | Current session ID |
| `PI_GIT_COMMON_DIR` | Shared Git directory when available |

Legacy `OPENCODE_*` aliases are also injected for compatibility. By default, the process inherits the host environment. Set `PI_YAML_HOOKS_ENV_ALLOWLIST` to restrict inherited variables; required hook context variables are always added.

## Optional human bash interception

Set `PI_YAML_HOOKS_ENABLE_USER_BASH=1` to route human `!` and `!!` commands through `tool.before.bash` hooks. This mode is off by default.

It runs pre-bash hooks only. It does not emit `tool.after.*` or `file.changed`. Trusted project hooks can read, block, or leak the typed command, so enable it only when every loaded hook is trusted.

## Limits

| Limit | Value |
|---|---|
| Root or imported YAML file | 1 MiB |
| Import depth | 32 |
| Prompt context per submission | 64 KiB |
| Serialized `tool_args` | 64 KiB |
| Bash stdin | 256 KiB by default |
| Bash stdout and stderr | 1 MiB each by default |
| Bash timeout | 60 seconds by default |
| Async pending work | 1,000 per lane by default |

Configurable defaults are listed in [Setup](./setup.md#environment-variables).

## Host UI and diagnostics

UI actions require `ctx.hasUI` and the matching method. RPC may expose UI methods; headless contexts may not. The extension capability-checks notifications, confirmation, status, custom diagnostics, and TUI autocomplete separately.

At agent start, it adds a short hook-awareness note to the system prompt. Set `PI_YAML_HOOKS_PROMPT_AWARENESS=0` to disable that note without disabling `user.prompt.submit` hooks.

For runtime traces and skip reasons, see [Debugging hooks](./debugging-hooks.md).
