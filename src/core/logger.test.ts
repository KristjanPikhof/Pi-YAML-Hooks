import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  __resetHookHostProfileForTests,
  configureHookHostProfile,
} from "./host-profile.js"
import {
  getPiHooksLogFilePath,
  getPiHooksLogger,
  resetPiHooksLoggerForTests,
} from "./logger.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

const LOGGER_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PI_YAML_HOOKS_DEBUG",
  "PI_YAML_HOOKS_LOG_LEVEL",
  "PI_YAML_HOOKS_LOG_FILE",
  "PI_YAML_HOOKS_LOG_STDERR",
] as const
type LoggerEnvKey = (typeof LOGGER_ENV_KEYS)[number]

function withLoggerSandbox(run: (tempDir: string) => { ok: boolean; detail?: string }): {
  ok: boolean
  detail?: string
} {
  const previous: Partial<Record<LoggerEnvKey, string>> = {}
  for (const key of LOGGER_ENV_KEYS) previous[key] = process.env[key]

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-logger-"))
  process.env.HOME = tempDir
  process.env.USERPROFILE = tempDir
  delete process.env.PI_YAML_HOOKS_DEBUG
  delete process.env.PI_YAML_HOOKS_LOG_LEVEL
  delete process.env.PI_YAML_HOOKS_LOG_FILE
  delete process.env.PI_YAML_HOOKS_LOG_STDERR
  __resetHookHostProfileForTests()
  resetPiHooksLoggerForTests()

  try {
    return run(tempDir)
  } finally {
    resetPiHooksLoggerForTests()
    __resetHookHostProfileForTests()
    for (const key of LOGGER_ENV_KEYS) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function readKinds(filePath: string): string[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parsed: unknown = JSON.parse(line)
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("kind" in parsed) ||
        typeof parsed.kind !== "string"
      ) {
        throw new Error(`Log entry has no string kind: ${line}`)
      }
      return parsed.kind
    })
}

const cases: Case[] = [
  {
    name: "empty log override falls back to the active OMP profile path",
    run: () =>
      withLoggerSandbox((tempDir) => {
        const agentDir = path.join(tempDir, ".omp", "profiles", "work", "agent")
        configureHookHostProfile({ kind: "omp", agentDir })
        process.env.PI_YAML_HOOKS_LOG_FILE = "   "

        const expected = path.join(agentDir, "logs", "pi-yaml-hooks.ndjson")
        const logger = getPiHooksLogger()
        logger.info("empty-override", "fallback path")

        const ok =
          getPiHooksLogFilePath() === expected &&
          logger.enabled &&
          logger.filePath === expected &&
          existsSync(expected) &&
          readKinds(expected).includes("empty-override")
        return ok
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({ resolved: getPiHooksLogFilePath(), logger, expected }),
            }
      }),
  },
  {
    name: "nonempty log override is trimmed and preserved over host defaults",
    run: () =>
      withLoggerSandbox((tempDir) => {
        configureHookHostProfile({
          kind: "omp",
          agentDir: path.join(tempDir, ".omp", "profiles", "work", "agent"),
        })
        const override = path.join(tempDir, "explicit", "hooks.ndjson")
        process.env.PI_YAML_HOOKS_LOG_FILE = `  ${override}  `

        const logger = getPiHooksLogger()
        logger.info("explicit-override", "explicit path")
        const ok =
          getPiHooksLogFilePath() === override &&
          logger.filePath === override &&
          readKinds(override).includes("explicit-override")
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ resolved: getPiHooksLogFilePath(), logger, override }) }
      }),
  },
  {
    name: "disabled logger refreshes across host profile and enable transitions",
    run: () =>
      withLoggerSandbox((tempDir) => {
        const piLogger = getPiHooksLogger()
        const profile = configureHookHostProfile({
          kind: "omp",
          agentDir: path.join(tempDir, ".omp", "profiles", "work", "agent"),
        })
        const ompDisabledLogger = getPiHooksLogger()
        process.env.PI_YAML_HOOKS_DEBUG = "1"
        const ompEnabledLogger = getPiHooksLogger()
        const expected = path.join(profile.agentDir, "logs", "pi-yaml-hooks.ndjson")
        ompEnabledLogger.info("enabled-after-switch", "new host path")

        const ok =
          !piLogger.enabled &&
          !ompDisabledLogger.enabled &&
          piLogger !== ompDisabledLogger &&
          ompDisabledLogger !== ompEnabledLogger &&
          ompEnabledLogger.enabled &&
          ompEnabledLogger.filePath === expected &&
          readKinds(expected).includes("enabled-after-switch")
        return ok
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({ piLogger, ompDisabledLogger, ompEnabledLogger, expected }),
            }
      }),
  },
  {
    name: "host switch closes the cached path and writes through the new profile descriptor",
    run: () =>
      withLoggerSandbox((tempDir) => {
        process.env.PI_YAML_HOOKS_DEBUG = "1"
        const piPath = path.join(tempDir, ".pi", "agent", "logs", "pi-yaml-hooks.ndjson")
        const piLogger = getPiHooksLogger()
        piLogger.info("pi-before-switch", "old descriptor")

        const profile = configureHookHostProfile({
          kind: "omp",
          agentDir: path.join(tempDir, ".omp", "profiles", "work", "agent"),
        })
        const ompPath = path.join(profile.agentDir, "logs", "pi-yaml-hooks.ndjson")
        const ompLogger = getPiHooksLogger()
        ompLogger.info("omp-after-switch", "new descriptor")

        const piKinds = readKinds(piPath)
        const ompKinds = readKinds(ompPath)
        const ok =
          piLogger !== ompLogger &&
          piLogger.filePath === piPath &&
          ompLogger.filePath === ompPath &&
          JSON.stringify(piKinds) === JSON.stringify(["pi-before-switch"]) &&
          JSON.stringify(ompKinds) === JSON.stringify(["omp-after-switch"])
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ piPath, ompPath, piKinds, ompKinds }) }
      }),
  },
]

export function main(): number {
  let failures = 0
  for (const testCase of cases) {
    try {
      const outcome = testCase.run()
      if (outcome.ok) {
        console.info(`PASS  ${testCase.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${testCase.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(
        `FAIL  ${testCase.name} -- threw ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /logger\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  process.exit(main())
}
