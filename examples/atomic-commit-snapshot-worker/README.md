# Snapshot autocommit worker

This repository-only example captures `file.changed` payloads, stores snapshots in a worktree-local SQLite queue, and publishes Git commits after a short quiet period.

It is not part of the npm package and is not a built-in `pi-yaml-hooks` feature. Clone the repository and point your hook file at these scripts.

## Requirements

- macOS or Linux
- Python 3
- Git 2
- a repository with an existing branch and first commit

The worker uses POSIX signals and `fcntl` locks. It does not support Windows, detached HEAD, unborn branches, or multiple worktrees editing the same branch.

## Configure

Copy [`hooks.yaml`](./hooks.yaml) into a trusted project hook file. Replace `<snapshot-example-dir>` with the absolute path to this directory:

```yaml
hooks:
  - id: snapshot-autocommit
    event: file.changed
    async: true
    actions:
      - bash: 'python3 <snapshot-example-dir>/snapshot-hook.py'

  - id: snapshot-flush-on-exit
    event: session.deleted
    actions:
      - bash: 'python3 <snapshot-example-dir>/snapshot-worker.py --flush --repo "$PI_PROJECT_DIR"'
```

The flush is best-effort because `session.deleted` may represent a shutdown or a session switch.

## Verify and operate

After an agent edits a file, wait about one second and inspect Git history and queue status:

```bash
git log --oneline -5
python3 snapshot-worker.py --status --repo /path/to/repo
```

Other commands:

```bash
# Drain the current branch queue. Exit 0 means empty; exit 2 means work remains.
python3 snapshot-worker.py --flush --repo /path/to/repo

# Run the worker in the foreground.
python3 snapshot-worker.py --repo /path/to/repo
```

## Safety model

Each worktree has its own database, locks, logs, and worker under its Git directory. A shared branch registry tracks branch ownership and generation across worktrees.

The worker publishes only events whose branch generation and base ancestry still match. A reset, rebase, force move, branch recreation, or unsupported topology settles affected work as `blocked_conflict` instead of replaying it onto uncertain history. It records incomplete source payloads as best-effort; structured `changes[]` entries provide the strongest capture input.

The main event states are `pending`, `publishing`, `published`, `blocked_conflict`, and `failed`. Startup reconciles interrupted publishing work before processing more events.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `SNAPSHOTD_QUIET_SECONDS` | `1.0` | Wait after the last enqueue before replay |
| `SNAPSHOTD_IDLE_SECONDS` | `30.0` | Worker idle lifetime |
| `SNAPSHOTD_POLL_SECONDS` | `0.35` | Queue poll interval |
| `SNAPSHOTD_HEARTBEAT_STALE` | `15` | Age at which a heartbeat is stale |
| `SNAPSHOTD_RETENTION_SECONDS` | `604800` | Settled-row retention |
| `SNAPSHOTD_RECONCILE_RETRY_ATTEMPTS` | `3` | Deferred index-reset retry count |
| `SNAPSHOTD_RECONCILE_RETRY_SLEEP` | `0.2` | Delay between reconciliation retries |
| `SNAPSHOTD_DEBUG` | off | Write hook and worker debug logs |
| `SNAPSHOTD_LOG_MAX_BYTES` | 2 MiB | Log rotation size |
| `SNAPSHOTD_LOG_KEEP` | `3` | Rotated logs to retain |
| `SNAPSHOTD_WORKER_PATH` | sibling script | Override the worker path |
| `SNAPSHOTD_COMMIT_MESSAGE_CMD` | unset | Run a custom argv-style message command per event |
| `SNAPSHOTD_AI_ENABLE` | off | Enable OpenAI-compatible commit-message batching |
| `SNAPSHOTD_AI_MAX_QUEUE_DEPTH` | `2` | Skip AI generation above this backlog |
| `SNAPSHOTD_AI_CHUNK_SIZE` | `20` | Events per AI request, clamped to 1 through 100 |
| `SNAPSHOTD_SENSITIVE_GLOBS` | common secret files | Redact matching diffs before network requests |
| `OPENAI_API_KEY` | unset | Authorize AI message generation |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model for AI messages |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | HTTPS endpoint for AI messages |
| `OPENAI_API_TIMEOUT` | `15` | Request timeout in seconds |

AI generation is off unless both `SNAPSHOTD_AI_ENABLE=1` and `OPENAI_API_KEY` are set. Sensitive globs are redacted before network requests. If AI or a custom message command fails, the worker falls back to deterministic messages.

## Debug

Set `SNAPSHOTD_DEBUG=1`, then inspect:

```bash
git_dir=$(git rev-parse --absolute-git-dir)
tail -n 200 "$git_dir/ai-snapshotd/logs/hook.log"
tail -n 200 "$git_dir/ai-snapshotd/logs/worker.log"
python3 snapshot-worker.py --status --repo .
```

Treat `blocked_conflict` as a manual-review state. The worker does not retry those events automatically.
