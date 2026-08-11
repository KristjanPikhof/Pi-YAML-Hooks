# Maintaining pi-yaml-hooks

This page is for release work and host-sensitive changes. Users can skip it.

## Verification levels

| Change | Minimum check |
|---|---|
| Documentation only | Link check, example validation, `git diff --check` |
| TypeScript source | `npm run typecheck` and focused tests |
| Runtime or adapter behavior | `npm run test:internal` |
| Pi SDK compatibility | `npm run compat:sdk-matrix` |
| Host paths, manifests, lifecycle, UI, commands, or packaging | `npm run compat:host-matrix` |
| Release candidate | Both runtime smokes and package inspection |

`npm test` is a consumer no-op. It is not a validation command.

## Host matrix

Preview the isolated workflow without installing dependencies:

```bash
npm run compat:host-matrix -- --dry-run
```

Run the full gate:

```bash
npm run compat:host-matrix
```

The matrix verifies:

- exact Pi SDK pairs `0.74.0`, `0.79.3`, `0.80.10`, and `0.84.1`
- exact OMP SDK pairs `17.0.1` and `17.2.12`
- typecheck and all discovered internal tests for each row
- OMP runtime smoke on both supported rows
- native package manifests, exports, packed files, cleanup, and lockfile drift

The workflow uses temporary copies and isolated home and npm state. A pass does not mutate the working checkout's package files.

## Runtime smokes

Run both from the repository root:

```bash
bash scripts/smoke/pi-runtime-smoke.sh --automated
bash scripts/smoke/omp-runtime-smoke.sh
```

These scripts verify native package discovery instead of manual extension paths. Together they cover config and trust paths, tool and lifecycle events, prompt behavior, diagnostics, UI degradation, TUI autocomplete, opt-in human bash interception, logs, package state, and cleanup.

The Pi smoke uses exact `0.84.1` host and SDK evidence, including an isolated `--no-builtin-tools` process. The host matrix runs OMP smoke against exact `17.0.1` and `17.2.12` rows.

## Widen compatibility claims

Do not widen a host claim from typecheck alone. For each new exact host line:

1. Pin the host, coding-agent SDK, and TUI SDK in an isolated matrix row.
2. Pass typecheck and every internal test.
3. Pack the same artifact and install it through native discovery.
4. Verify global, project, profile, trust, and log paths.
5. Exercise lifecycle, tool, prompt, diagnostics, RPC, headless behavior, TUI autocomplete, and cleanup.
6. Record exact versions and results with the release or pull request.

`npm run compat:sdk-matrix:future` is advisory. A pass does not widen support by itself.

## Package checks

The packed artifact must contain both host entries, public exports, source declarations, and declared examples. It must not contain tests, TypeScript build info, or undeclared build debris.

```bash
npm run build:publish
npm pack --dry-run
```

If an intentional change alters package contents, update `package.json#files` and the package verifier in the same commit.

## Timed-hook flake policy

The POSIX descendant-cleanup test is timing-sensitive but is not an allowed failure. If it is the only failing test, retain the first output and rerun that exact matrix stage once. A second failure fails the gate. A passing rerun must still be reported as the known timed-hook flake.

## Evidence to keep

Keep exact commands, exit codes, host and SDK versions, test counts, selected paths, representative event traces, package inventory, cleanup assertions, and drift results. Do not copy dated evidence into this guide; attach it to the release or pull request where it can stay tied to the tested revision.
