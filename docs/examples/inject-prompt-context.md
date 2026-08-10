# Inject prompt context

Use `user.prompt.submit` when the agent needs extra context for the prompt it is about to handle.

This example adds a database rule only when the expanded prompt mentions a database or migration:

```yaml
hooks:
  - id: database-prompt-context
    event: user.prompt.submit
    actions:
      - bash: >-
          node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk);
          process.stdin.on("end", () => { const { prompt = "" } = JSON.parse(input);
          if (/\b(database|migration)\b/i.test(prompt))
          process.stdout.write("Use a reversible migration and preserve existing data."); });'
```

The hook receives this stdin shape:

```json
{
  "event": "user.prompt.submit",
  "session_id": "session-123",
  "cwd": "/Users/me/project",
  "prompt": "Create a migration for the accounts table"
}
```

Successful, non-empty stdout is added to the current turn as system context. Multiple hooks and actions keep configuration order. Each output becomes its own context block.

## Limits and failure behavior

- The event runs after prompt expansion and before the agent loop.
- It is synchronous and bash-only. Slow commands delay every matching prompt.
- The prompt is text only. Attached images are not included.
- The hook cannot tell whether input came from TUI, RPC, or another extension.
- The hook cannot rewrite or block the prompt, and it does not create another user message.
- Failed, timed-out, blocked, or truncated executions contribute no context. The turn continues.
- Empty stdout contributes no context.
- Injected context is capped at 64 KiB of UTF-8 text per submission. A contribution that does not fit is skipped rather than cut.
- `PI_YAML_HOOKS_PROMPT_AWARENESS=0` disables only the awareness note. It does not disable this YAML event.

## Privacy

The bash action receives the expanded prompt. Project trust is the authorization boundary, with no separate environment flag. Only trust hooks that may read sensitive prompts and run shell commands.

`pi-yaml-hooks` does not log the submitted prompt. Normal bash result logging still applies to stdout and stderr, so do not echo sensitive prompt text from the script.
