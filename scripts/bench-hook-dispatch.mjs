#!/usr/bin/env node
/**
 * Per-event hook-dispatch benchmark.
 *
 * Builds isolated project fixtures that import 0, 1, and many hook files, then
 * times tool.before, tool.after, and session.idle dispatches and counts the
 * statSync calls the runtime makes for its hook-reload fingerprint.
 *
 * Usage: node scripts/bench-hook-dispatch.mjs [--iterations 200] [--files 0,1,200]
 *
 * The harness reads dist/, so run npm run build first (it builds once itself
 * when dist/core/runtime.js is missing).
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"

// node:fs must be reached through require, not a static ESM import: Node
// snapshots a builtin ESM namespace the first time it is imported, so a static
// import would freeze the original statSync before we can wrap it.
const require = createRequire(import.meta.url)
const fs = require("node:fs")
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = fs

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
let runtimeModule = path.join(rootDir, "dist", "core", "runtime.js")

function parseArgs(argv) {
  const options = { iterations: 200, fileCounts: [0, 1, 200] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--iterations") {
      options.iterations = Number(argv[(index += 1)])
    } else if (arg === "--files") {
      options.fileCounts = argv[(index += 1)].split(",").map((value) => Number(value))
    } else if (arg === "--runtime") {
      options.runtime = argv[(index += 1)]
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.runtime) {
  runtimeModule = path.resolve(options.runtime)
}

if (!existsSync(runtimeModule)) {
  console.error(`dist/core/runtime.js missing; running npm run build once`)
  const built = spawnSync("npm", ["run", "build"], { cwd: rootDir, stdio: "inherit" })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

// Count the stat calls the runtime makes. The runtime binds { statSync } from
// node:fs at import time, so patch the module object before the dynamic import
// below and every fingerprint stat flows through the counter.
let statCalls = 0
const realStatSync = fs.statSync
fs.statSync = function patchedStatSync(...args) {
  statCalls += 1
  return realStatSync.apply(this, args)
}
const { createHooksRuntime } = await import(pathToFileURL(runtimeModule).href)

function createHost() {
  return {
    abort: () => {},
    getRootSessionId: (id) => id,
    runBash: async (request) => ({
      command: request.command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      blocking: false,
      status: "success",
      durationMs: 0,
      signal: null,
    }),
    sendPrompt: () => {},
    notify: () => {},
    confirm: async () => true,
    setStatus: () => {},
  }
}

function createFixture(fileCount) {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-bench-home-"))
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-bench-project-"))
  const importDir = path.join(projectDir, ".pi", "hook", "imports")
  mkdirSync(importDir, { recursive: true })

  const importedEntries = []
  for (let index = 0; index < fileCount; index += 1) {
    const name = `import-${index}.yaml`
    importedEntries.push(`  - ./imports/${name}`)
    writeFileSync(
      path.join(importDir, name),
      [`hooks:`, `  - event: session.idle`, `    actions:`, `      - notify: "import ${index}"`, ``].join("\n"),
      "utf8",
    )
  }

  const projectConfig = [
    ...(importedEntries.length > 0 ? ["imports:", ...importedEntries] : []),
    "hooks:",
    "  - event: tool.before.bash",
    "    actions:",
    `      - notify: "before"`,
    "  - event: tool.after.bash",
    "    actions:",
    `      - notify: "after"`,
    "  - event: session.idle",
    "    actions:",
    `      - notify: "idle"`,
    "",
  ].join("\n")
  writeFileSync(path.join(projectDir, ".pi", "hook", "hooks.yaml"), projectConfig, "utf8")

  return { homeDir, projectDir }
}

async function measureFixture(fileCount, iterations) {
  const { homeDir, projectDir } = createFixture(fileCount)
  const previousHome = process.env.HOME
  const previousProfileHome = process.env.USERPROFILE
  const previousTrust = process.env.PI_YAML_HOOKS_TRUST_PROJECT
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"

  const rows = []
  try {
    const runtime = createHooksRuntime(createHost(), { directory: projectDir })
    const events = [
      [
        "tool.before",
        (index) =>
          runtime["tool.execute.before"](
            { tool: "bash", sessionID: "bench", callID: `before-${index}` },
            { args: { command: "echo hi" } },
          ),
      ],
      [
        "tool.after",
        (index) =>
          runtime["tool.execute.after"]({
            tool: "bash",
            sessionID: "bench",
            callID: `after-${index}`,
            args: { command: "echo hi" },
          }),
      ],
      [
        "session.idle",
        () => runtime.event({ event: { type: "session.idle", properties: { sessionID: "bench" } } }),
      ],
    ]

    for (const [name, dispatch] of events) {
      for (let index = 0; index < 20; index += 1) {
        await dispatch(index)
      }
      const statBefore = statCalls
      const started = performance.now()
      for (let index = 0; index < iterations; index += 1) {
        await dispatch(index)
      }
      const elapsed = performance.now() - started
      rows.push({
        event: name,
        msPerEvent: elapsed / iterations,
        statCallsPerEvent: (statCalls - statBefore) / iterations,
      })
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfileHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfileHome
    if (previousTrust === undefined) delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
    else process.env.PI_YAML_HOOKS_TRUST_PROJECT = previousTrust
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  }
  return rows
}

console.log(`iterations=${options.iterations} fixtures=${options.fileCounts.join(",")}`)
console.log("watched files | event        | ms/event | statCalls/event")
for (const fileCount of options.fileCounts) {
  const rows = await measureFixture(fileCount, options.iterations)
  for (const row of rows) {
    console.log(
      `${String(fileCount).padStart(13)} | ${row.event.padEnd(12)} | ${row.msPerEvent.toFixed(4)} | ${row.statCallsPerEvent.toFixed(1)}`,
    )
  }
}
console.log("benchmark complete")
