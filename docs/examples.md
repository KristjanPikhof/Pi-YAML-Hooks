# Hook examples

Copy the closest example into a global or trusted project `hooks.yaml`, then adapt the command and paths. See [Setup](./setup.md) for file locations and trust.

## Add context to the current prompt

This hook adds a database rule only when the expanded prompt mentions a database or migration:

```yaml
hooks:
  - id: database-prompt-context
    event: user.prompt.submit
    actions:
      - bash: >-
          node -e 'let input = ""; process.stdin.on("data", c => input += c);
          process.stdin.on("end", () => { const { prompt = "" } = JSON.parse(input);
          if (/\b(database|migration)\b/i.test(prompt))
          process.stdout.write("Use a reversible migration and preserve existing data."); });'
```

Successful stdout becomes system context for the same turn. Keep prompt hooks fast and local because they run synchronously. The hook receives the expanded prompt as sensitive text and cannot rewrite or block it.

## Confirm every bash tool call

```yaml
hooks:
  - id: confirm-bash
    event: tool.before.bash
    actions:
      - confirm:
          title: "Run bash command?"
          message: "Approve this bash tool call."
```

Approval lets the call continue. Rejection blocks it. Without UI, confirmation denies by default.

## Block a destructive command

```yaml
hooks:
  - id: block-hard-reset
    event: tool.before.bash
    actions:
      - bash: >-
          payload=$(cat);
          case "$payload" in
            *"git reset --hard"*) echo "Blocked git reset --hard" >&2; exit 2;;
          esac
```

Exit code `2` blocks a pre-tool call. For a real policy, parse the stdin JSON in a script instead of matching the serialized payload with shell patterns. The [pre-tool guard pack](../examples/pre-tool-developer-guards/) provides a script-backed version.

## Log file changes

```yaml
hooks:
  - id: log-file-changes
    event: file.changed
    actions:
      - bash: 'mkdir -p .pi-hook-logs && cat >> .pi-hook-logs/file-changed.ndjson'
```

Each matching event appends its stdin JSON. This is a simple way to inspect actual `files` and `changes` payloads before writing a larger automation.

## Filter by path

Run when any changed path is a TypeScript source file:

```yaml
hooks:
  - id: source-changed
    event: file.changed
    conditions:
      - matchesAnyPath:
          - "src/**/*.ts"
          - "src/**/*.tsx"
    actions:
      - notify: "Source changed"
```

Run only when every changed path is both under `src/` and TypeScript:

```yaml
hooks:
  - id: only-source-typescript
    event: session.idle
    conditions:
      - matchesAllPaths: "src/**"
      - matchesAllPaths: "**/*.ts"
    actions:
      - notify: "Only source TypeScript changed"
```

Use `file.changed` when the workflow should work across mutation tools. Use `tool.after.<name>` when the specific tool matters.

## Run work in the background

```yaml
hooks:
  - id: async-upload
    event: tool.after.write
    async:
      group: uploads
      concurrency: 2
    actions:
      - bash: "./scripts/upload-artifact.sh"
```

Async hooks are bash-only and cannot run on pre-tool, idle, or prompt events. Hooks with the same group share a bounded queue.

## Run only in main or child sessions

```yaml
hooks:
  - id: main-idle
    event: session.idle
    scope: main
    actions:
      - setStatus: "Main session idle"

  - id: child-created
    event: session.created
    scope: child
    actions:
      - notify: "Child session created"
```

`scope` filters where the hook fires. Omit it or use `all` for every session.

## Replace a global hook in one project

Define the global hook with an `id`:

```yaml
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Global idle"
```

Replace it in the trusted project file:

```yaml
hooks:
  - override: idle-notify
    event: session.idle
    actions:
      - notify: "Project idle"
```

To remove it for the project:

```yaml
hooks:
  - override: idle-notify
    disable: true
```

## Ask the agent to follow up

```yaml
hooks:
  - id: test-after-package-change
    event: file.changed
    conditions:
      - matchesAnyPath:
          - "package.json"
          - "package-lock.json"
    actions:
      - tool:
          name: bash
          args:
            command: "npm test"
```

The current session receives a prompt asking it to run the tool. The action is advisory; it does not invoke `bash` directly.

## Notify when a turn settles

```yaml
hooks:
  - id: idle-notify
    event: session.idle
    actions:
      - notify: "Agent is idle"
```

This is the smallest UI-visible smoke test. In a context without the notification method, it logs a degradation instead.

## Complete example packs

| Pack | Use |
|---|---|
| [Pre-tool developer guards](../examples/pre-tool-developer-guards/) | Block risky shell commands, protected-file edits, and dependency installs |
| [Post-tool developer feedback](../examples/post-tool-developer-feedback/) | Log source changes, update status, and request checks after dependency changes |
| [Snapshot autocommit worker](../examples/atomic-commit-snapshot-worker/) | Explore a repository-only Python queue and commit worker |

The first two packs ship in the npm package. The snapshot worker is repository-only and is not a built-in feature.

## Test an example

1. Add one hook.
2. Run `/hooks-validate` and `/hooks-status`.
3. Trigger the smallest matching event.
4. Check the UI, side effect, or [structured log](./debugging-hooks.md).

Do not rely on a hook until you have observed its intended match and one non-match.
