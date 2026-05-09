# Example hook packs

These folders include complete example packs. Copy the `hooks.yaml` snippets
into a global or trusted project hook file, and keep any referenced scripts at
the paths used by the YAML or update those paths.

## Complete packs

- [`pre-tool-developer-guards`](./pre-tool-developer-guards/) — block risky shell commands and protected-file edits before tools run
- [`post-tool-developer-feedback`](./post-tool-developer-feedback/) — log useful post-tool context, update status, and nudge follow-up checks after developer-facing changes

These are examples only. They are not built-in `pi-yaml-hooks` product features.

## Repository-only examples

These are not shipped in the npm tarball. Clone
[the GitHub repository](https://github.com/KristjanPikhof/pi-yaml-hooks)
to use them:

- [`atomic-commit-snapshot-worker`](https://github.com/KristjanPikhof/pi-yaml-hooks/tree/main/examples/atomic-commit-snapshot-worker) — Python snapshot worker that auto-commits every recognized `file.changed` event into a per-worktree SQLite queue.
