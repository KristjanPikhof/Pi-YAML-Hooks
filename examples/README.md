# Example hook packs

These folders include complete opt-in example packs for Pi and OMP. Copy a pack's `hooks.yaml` into one global or trusted project hook file, and keep referenced scripts at the paths used by the YAML or update those paths.

## Where to copy a pack

The YAML is identical across hosts:

| Scope | Pi | OMP |
|---|---|---|
| Global, default profile | `~/.pi/agent/hook/hooks.yaml` | `~/.omp/agent/hook/hooks.yaml` |
| Global, named OMP profile | Not applicable | `~/.omp/profiles/<profile>/agent/hook/hooks.yaml` |
| Project | `<project>/.pi/hook/hooks.yaml` | `<project>/.omp/hook/hooks.yaml` |

After copying a project pack, start the matching host, run `/hooks-trust`, then run `/hooks-status`. OMP saves trust in its active profile, separate from Pi, even if OMP falls back to a legacy `.pi` project config.

## Complete packs

| Pack | What it does |
|---|---|
| [`pre-tool-developer-guards`](./pre-tool-developer-guards/) | Block risky shell commands and protected-file edits before tools run |
| [`post-tool-developer-feedback`](./post-tool-developer-feedback/) | Log useful post-tool context, update status, and nudge follow-up checks after developer-facing changes |

These are examples only. They are not built-in `pi-yaml-hooks` product features.

## Repository-only examples

These are not shipped in the npm tarball. Clone [the GitHub repository](https://github.com/KristjanPikhof/pi-yaml-hooks) to use them:

| Pack | What it does |
|---|---|
| [`atomic-commit-snapshot-worker`](https://github.com/KristjanPikhof/pi-yaml-hooks/tree/main/examples/atomic-commit-snapshot-worker) (repo-only) | Python snapshot worker that auto-commits every recognized `file.changed` event into a per-worktree SQLite queue |
