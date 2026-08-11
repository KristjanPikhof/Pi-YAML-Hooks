# Post-tool developer feedback

This pack demonstrates three post-tool patterns:

- append source mutation context to `.pi-hook-logs/tool-events.ndjson`
- set a status entry when dependency metadata changes
- ask the current agent session to run `npm test` after a dependency-file change

The final action uses `tool:`. It sends a follow-up prompt; it does not invoke the test command directly.

## Install

Copy this directory into your project, or keep it at the same repo-relative path. Merge [`hooks.yaml`](./hooks.yaml) into `.pi/hook/hooks.yaml` or `.omp/hook/hooks.yaml`, then run `/hooks-trust` and `/hooks-validate`.

The YAML expects the logger at:

```text
./examples/post-tool-developer-feedback/post-tool-log.mjs
```

Update the path and the follow-up test command for your project.

## Verify

1. Edit a file under `src/`, `test/`, or `tests/` through the host.
2. Check `.pi-hook-logs/tool-events.ndjson` for the event.
3. Edit a supported package or lock file.
4. Check the status entry and confirm that the current session receives the test request.
