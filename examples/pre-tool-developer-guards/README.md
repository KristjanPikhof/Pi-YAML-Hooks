# Pre-tool developer guards

This pack reads pre-tool JSON and exits with code `2` when a rule blocks the call. It covers obvious destructive shell commands, protected file paths, and dependency-install commands.

The patterns are guardrails, not a security boundary. Shell quoting, variables, aliases, and indirect execution can bypass string matching. Use operating-system isolation for hostile code.

## Install

Copy this directory into your project, or keep it at the same repo-relative path. Merge [`hooks.yaml`](./hooks.yaml) into the project's `.pi/hook/hooks.yaml` or `.omp/hook/hooks.yaml`, then run:

```text
/hooks-trust
/hooks-validate
/hooks-status
```

The YAML expects this script at:

```text
./examples/pre-tool-developer-guards/pre-tool-policy.mjs
```

Update the path if you place the pack elsewhere.

## Rules

| Hook | Blocks |
|---|---|
| `guard-risky-bash` | Hard resets, destructive clean commands, broad `rm -rf`, recursive `chmod 777`, and pipe-to-shell installs |
| `guard-protected-write` and `guard-protected-edit` | Common environment, credential, key, certificate, `.ssh`, and `secrets` paths |
| `guard-package-install` | Common JavaScript, Python, Rust, and Go dependency changes |

To test safely, ask the agent to run a harmless command, then a command that matches one rule. Confirm the first runs and the second is blocked with the expected reason.
