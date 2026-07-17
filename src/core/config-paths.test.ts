import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveHookConfigWatchPaths } from "./config-paths.js"
import type { HookHostProfile } from "./host-profile.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

const cases: Case[] = [
  {
    name: "watch paths cover host candidates, cwd ancestors, trust, and repository markers",
    run: async () => {
      const sandbox = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-watch-paths-"))
      const homeDir = path.join(sandbox, "home")
      const worktreeRoot = path.join(sandbox, "repo")
      const cwd = path.join(worktreeRoot, "packages", "app")
      const agentDir = path.join(homeDir, ".omp", "agent")
      const profile: HookHostProfile = Object.freeze({ kind: "omp", agentDir })
      mkdirSync(cwd, { recursive: true })

      let gitResolverCalls = 0
      try {
        const actual = resolveHookConfigWatchPaths({
          projectDir: cwd,
          homeDir,
          profile,
          resolveGitWorktreeRoot: () => {
            gitResolverCalls += 1
            return worktreeRoot
          },
        }).paths

        const expected = [
          path.join(agentDir, "hook", "hooks.yaml"),
          path.join(agentDir, "hooks.yaml"),
          path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml"),
          path.join(homeDir, ".pi", "agent", "hooks.yaml"),
          path.join(agentDir, "trusted-projects.json"),
        ]
        for (const dir of [cwd, path.dirname(cwd), worktreeRoot]) {
          expected.push(
            path.join(dir, ".omp", "hook", "hooks.yaml"),
            path.join(dir, ".omp", "hooks.yaml"),
            path.join(dir, ".pi", "hook", "hooks.yaml"),
            path.join(dir, ".pi", "hooks.yaml"),
            path.join(dir, ".git"),
          )
        }

        const outsideWorktree = path.join(sandbox, ".pi", "hook", "hooks.yaml")
        const ok = gitResolverCalls === 1 &&
          JSON.stringify(actual) === JSON.stringify(expected) &&
          !actual.includes(outsideWorktree)
        return ok
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({ gitResolverCalls, actual, expected, outsideWorktree }),
            }
      } finally {
        rmSync(sandbox, { recursive: true, force: true })
      }
    },
  },
]

export async function main(): Promise<number> {
  let failures = 0
  for (const testCase of cases) {
    try {
      const outcome = await testCase.run()
      if (outcome.ok) {
        console.info(`PASS  ${testCase.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${testCase.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${testCase.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /config-paths\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
