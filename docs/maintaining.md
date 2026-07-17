# Maintaining pi-yaml-hooks

> Maintainers only. Skip this file if you are using `pi-yaml-hooks` rather than releasing it.

This guide defines the dual-host compatibility gate, runtime smoke evidence, and claim-widening policy.

## Run the host matrix

Use the integrated matrix before merging changes to host adapters, lifecycle mapping, package entries, storage paths, commands, UI actions, prompts, or autocomplete:

```bash
npm run compat:host-matrix
```

For a no-install preview of the exact pinned versions and commands:

```bash
npm run compat:host-matrix -- --dry-run
```

The matrix uses isolated temporary copies, excludes `.git`, `.trekoon`, `node_modules`, and `dist`, isolates npm and home state, cleans up on success or failure, and verifies that `package.json` and `package-lock.json` did not drift.

| Gate | Pinned evidence | What must pass |
|---|---|---|
| Pi SDK compatibility | `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at `0.74.0` and `0.79.3` | Typecheck plus all discovered internal test files for each pair. These remain the compatibility claims. |
| OMP SDK compatibility | `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` at `17.0.1` | Isolated dependency substitution, typecheck, and the complete internal suite. |
| OMP runtime | Observed OMP CLI, Bun, and installed `pi-yaml-hooks` versions | `scripts/smoke/omp-runtime-smoke.sh`, including native packed install, RPC behavior, real TUI autocomplete, lifecycle mapping, active named-profile paths, trust, and cleanup. |
| Package contract | Current `package.json`, canonical `package-lock.json`, and packed artifact | Both host manifest entries and public extension stubs exist; declared files are packed; tests, build debris, and undeclared targets are absent. |

`npm test` is a consumer-facing no-op. The matrix intentionally runs `npm run test:internal`.

### Keep package and manifest checks exact

The package gate must confirm:

- `pi.extensions` points to `./extensions/pi-yaml-hooks/index.ts`
- `omp.extensions` points to `./extensions/omp-yaml-hooks/index.ts`
- Pi and OMP host peers remain optional so installing one host does not force the other runtime
- dev SDK specs resolve to Pi `0.79.3` and OMP `17.0.1`
- source entries, generated `dist` entries, and public exports are present in `npm pack`
- package inventory has no `*.test.*`, `*.tsbuildinfo`, or other build debris

If an intentional package-content change alters the inventory, update the verifier and record the new pack summary in the same change. Do not weaken the assertion to make an unexplained count pass.

## Run both runtime smoke gates

Run both from the repository root:

```bash
bash scripts/smoke/pi-runtime-smoke.sh --automated
bash scripts/smoke/omp-runtime-smoke.sh
```

Both scripts stage a checkout copy, then use isolated home, project, profile, npm, and log state. They install the staged packed artifact through the host's native discovery path, reject manual `-e` or `--extension` evidence, and verify that packing did not change the checkout's package files or `dist`.

| Runtime evidence | Pi smoke | OMP smoke |
|---|---|---|
| Host versions | Records Pi, both `@earendil-works` SDK packages, and Node | Records the OMP CLI, Bun, and installed `pi-yaml-hooks` package |
| Storage and trust | `.pi` global/project paths, active Pi trust store, default and override logs | Active named-profile `.omp` runtime paths, native project paths, OMP trust store, default log, and no Pi-state leakage |
| Events | Tool before/after, synthesized file changes, created/idle/deleted, opt-in `user_bash` | Tool before, created/idle/deleted, and opt-in `user_bash` |
| UI and prompts | RPC actions, prompt awareness, diagnostics, and real PTY autocomplete | RPC actions/headless degradation, prompt awareness, diagnostics, and real tmux TUI autocomplete with same-process lazy refresh |
| Cleanup | Temporary install and process cleanup; real-home and checkout package/`dist` checksums unchanged | Temporary profile, package stage, HTTP server, and private tmux cleanup; checkout package/`dist` checksum unchanged |

Default-profile and named-profile OMP storage are both covered by internal tests. The standalone OMP smoke records runtime evidence only for its active named profile.

Current standalone runtime evidence used Pi `0.80.7` with SDK `0.80.7`, and OMP CLI `17.0.1` with the printed Bun and installed plugin versions. The OMP SDK `17.0.1` claim comes from the host matrix, not the standalone runtime smoke. The Pi observation does not replace the published `0.74.0`/`0.79.3` compatibility matrix.

The completed `2026-07-17` gate recorded `test_files=24 pass=24 fail=0` for each Pi pair and OMP `17.0.1`, OMP runtime `A23` through `A26` at `4/4`, and a package inventory of `140` files with `11` required entries, `0` missing, and `0` forbidden. Cleanup and package-file drift checks passed.

## Widen a host claim

Do not widen an OMP claim from typechecking alone. Before naming a newer OMP line:

1. Pin that exact CLI, coding-agent SDK, and TUI SDK in an isolated matrix run.
2. Pass typecheck and every internal test file with zero failures.
3. Pack the same artifact and install it through normal OMP package discovery, without a manual extension path.
4. Prove native default and named-profile config, trust, and log paths.
5. Prove native-over-legacy precedence and that Pi trust/config state does not leak into OMP.
6. Prove tool, lifecycle, `user_bash`, prompt, diagnostic, RPC UI, no-UI, and real TUI autocomplete rows.
7. Keep exact version output, event/log excerpts, path selections, package inventory, and cleanup assertions.

Apply the same rule to a future Pi line: the advisory future SDK probe is not enough. Keep `0.74.0` and `0.79.3` claims until the exact matrix and live runtime smoke both pass.

## Handle the known timed-hook flake

`timed out bash hooks kill descendant background processes on POSIX` is a known timing-sensitive Pi matrix test. It is not an allowed failure.

If it is the only failing test:

1. Keep the first failing output.
2. Re-run the same matrix stage once in the same isolated environment.
3. If the rerun passes, record both outputs and label the result as the known timed-hook flake.
4. If it fails again, or any other test fails, treat the gate as failed. Do not edit expected counts, skip the test, or report the matrix as passing.

## Evidence to keep

For every host-sensitive change, retain:

- exact command and exit status
- CLI, SDK, Node or Bun, and package versions
- discovered test-file, pass, and fail counts
- selected global/project config, trust, and log paths
- representative ordered event and UI traces
- package manifest targets and `npm pack` summary
- cleanup assertions and package-file drift result
- the first failure and one rerun when the known timed-hook policy applies

## Verification commands

| Command | Use |
|---|---|
| `npm run typecheck` | TypeScript verification after source changes |
| `npm run build` | Build before direct `dist/**/*.test.js` execution |
| `npm run test:internal` | Complete internal suite; the timed-hook policy above applies |
| `npm run compat:sdk-matrix` | Pi `0.74.0`/`0.79.3` compatibility only |
| `npm run compat:sdk-matrix:future` | Advisory Pi future-line probe; never widens claims by itself |
| `npm run compat:host-matrix -- --dry-run` | Print exact dual-host matrix versions and commands without installs |
| `npm run compat:host-matrix` | Full Pi/OMP compile, test, runtime, package, cleanup, and drift gate |
| `bash scripts/smoke/pi-runtime-smoke.sh --automated` | Isolated native Pi runtime smoke |
| `bash scripts/smoke/omp-runtime-smoke.sh` | Isolated native OMP `17.0.1` runtime smoke |
| `npm run build:publish && npm pack --dry-run` | Inspect publish output and package inventory |

Keep [`hooks-reference.md`](./hooks-reference.md) and [`debugging-hooks.md`](./debugging-hooks.md) aligned with the evidence.
