# Example hook packs

These opt-in packs combine YAML with small scripts. Copy the pack into your project or update its script paths before using it.

| Pack | What it demonstrates | In npm package |
|---|---|---|
| [Pre-tool developer guards](./pre-tool-developer-guards/) | Inspect tool input and block risky commands or protected paths | yes |
| [Post-tool developer feedback](./post-tool-developer-feedback/) | Log mutation context, set status, and request a follow-up check | yes |
| [Snapshot autocommit worker](./atomic-commit-snapshot-worker/) | Queue file snapshots and publish Git commits from a Python worker | no, repository-only |

The hook YAML is the same in Pi and OMP. Project files normally live at `.pi/hook/hooks.yaml` for Pi or `.omp/hook/hooks.yaml` for OMP. Run `/hooks-trust`, then `/hooks-status` after installing a project pack.

These packs are examples, not built-in product features. Read the pack's README before enabling it, especially when it can block commands or create commits.

For smaller copyable snippets, see [Hook examples](../docs/examples.md).
