import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getPiHooksLogFilePath, getPiHooksLogger, resetPiHooksLoggerForTests } from "../core/logger.js"
import {
  __resetHookHostProfileForTests,
  configureHookHostProfile,
} from "../core/host-profile.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}
function withEnv<T>(key: string, value: string | undefined, run: () => T): T {
  const previous = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}


function withLoggerEnv<T>(
  options: { debug?: boolean; level?: string; logFile?: string },
  run: (logFile: string) => T,
): T {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-logger-"))
  const logFile = options.logFile ?? path.join(tempDir, "pi-yaml-hooks.ndjson")

  const previousDebug = process.env.PI_YAML_HOOKS_DEBUG
  const previousLogLevel = process.env.PI_YAML_HOOKS_LOG_LEVEL
  const previousLogFile = process.env.PI_YAML_HOOKS_LOG_FILE

  if (options.debug) process.env.PI_YAML_HOOKS_DEBUG = "1"
  else delete process.env.PI_YAML_HOOKS_DEBUG

  if (options.level !== undefined) process.env.PI_YAML_HOOKS_LOG_LEVEL = options.level
  else delete process.env.PI_YAML_HOOKS_LOG_LEVEL

  process.env.PI_YAML_HOOKS_LOG_FILE = logFile
  resetPiHooksLoggerForTests()

  try {
    return run(logFile)
  } finally {
    if (previousDebug === undefined) delete process.env.PI_YAML_HOOKS_DEBUG
    else process.env.PI_YAML_HOOKS_DEBUG = previousDebug

    if (previousLogLevel === undefined) delete process.env.PI_YAML_HOOKS_LOG_LEVEL
    else process.env.PI_YAML_HOOKS_LOG_LEVEL = previousLogLevel

    if (previousLogFile === undefined) delete process.env.PI_YAML_HOOKS_LOG_FILE
    else process.env.PI_YAML_HOOKS_LOG_FILE = previousLogFile

    resetPiHooksLoggerForTests()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

const PROFILE_LOGGER_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "PI_YAML_HOOKS_DEBUG",
  "PI_YAML_HOOKS_LOG_LEVEL",
  "PI_YAML_HOOKS_LOG_FILE",
  "PI_YAML_HOOKS_LOG_STDERR",
] as const
type ProfileLoggerEnvKey = (typeof PROFILE_LOGGER_ENV_KEYS)[number]

function withProfileLoggerSandbox(
  run: (tempDir: string) => { ok: boolean; detail?: string },
): { ok: boolean; detail?: string } {
  const previous: Partial<Record<ProfileLoggerEnvKey, string>> = {}
  for (const key of PROFILE_LOGGER_ENV_KEYS) previous[key] = process.env[key]

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-logger-profile-"))
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
    for (const key of PROFILE_LOGGER_ENV_KEYS) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function readLogKinds(filePath: string): string[] {
  return readLogLines(filePath).map((line) => {
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

function readLogLines(logFile: string): string[] {
  const content = readFileSync(logFile, "utf8")
  return content.trim().split("\n").filter(Boolean)
}

const cases: Case[] = [
  {
    name: "resolves log file path from environment override",
    run: () => withLoggerEnv({ debug: true }, (logFile) => {
      const resolved = getPiHooksLogFilePath()
      return resolved === logFile ? { ok: true } : { ok: false, detail: `resolved=${resolved} expected=${logFile}` }
    }),
  },
  {
    name: "filters out entries below configured log level",
    run: () => withLoggerEnv({ level: "warn" }, (logFile) => {
      const logger = getPiHooksLogger()
      logger.info("info_event", "should not be written")
      logger.warn("warn_event", "should be written")
      const lines = readLogLines(logFile)
      if (lines.length !== 1) return { ok: false, detail: `lines=${JSON.stringify(lines)}` }
      return lines[0]?.includes("warn_event") && !lines[0]?.includes("info_event")
        ? { ok: true }
        : { ok: false, detail: `line=${lines[0]}` }
    }),
  },
  {
    name: "refuses to write log when target path is a symlink",
    run: () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-logger-symlink-"))
      const realTarget = path.join(tempDir, "real-elsewhere.log")
      const linkPath = path.join(tempDir, "pi-yaml-hooks.ndjson")

      writeFileSync(realTarget, "")
      try {
        symlinkSync(realTarget, linkPath)
      } catch (error) {
        // Some environments (e.g. restricted CI) cannot create symlinks; treat as skipped.
        rmSync(tempDir, { recursive: true, force: true })
        const message = error instanceof Error ? error.message : String(error)
        console.info(`SKIP  refuses symlink target — symlink unsupported: ${message}`)
        return { ok: true }
      }

      return withLoggerEnv({ debug: true, logFile: linkPath }, () => {
        const sizeBefore = readFileSync(realTarget, "utf8").length
        const previousWarn = console.warn
        let warnings = 0
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.warn = (..._args: any[]) => {
          warnings += 1
        }
        try {
          const logger = getPiHooksLogger()
          logger.info("symlink_test", "should not be written through symlink")
        } finally {
          console.warn = previousWarn
        }

        const sizeAfter = readFileSync(realTarget, "utf8").length
        rmSync(tempDir, { recursive: true, force: true })

        if (sizeBefore !== sizeAfter) {
          return { ok: false, detail: `wrote through symlink: before=${sizeBefore} after=${sizeAfter}` }
        }
        if (warnings === 0) {
          return { ok: false, detail: "expected a warning to be emitted on symlink refusal" }
        }
        return { ok: true }
      })
    },
  },
  {
    name: "creates log file with restrictive 0o600 permissions on first write",
    run: () => {
      if (process.platform === "win32") return { ok: true }
      return withLoggerEnv({ debug: true }, (logFile) => {
        const logger = getPiHooksLogger()
        logger.info("perm_test", "create file")
        if (!existsSync(logFile)) return { ok: false, detail: "log file not created" }
        const mode = statSync(logFile).mode & 0o777
        // Honor process umask: at minimum group/other must not be writable; we created with 0o600.
        if ((mode & 0o077) !== 0) {
          return { ok: false, detail: `expected 0o600-ish, got 0o${mode.toString(8)}` }
        }
        return { ok: true }
      })
    },
  },
  {
    name: "redacts sensitive strings and truncates large payloads",
    run: () => withLoggerEnv({ debug: true }, (logFile) => {
      const logger = getPiHooksLogger()
      const largeValue = "x".repeat(2500)
      logger.info("secret_event", "testing redaction", {
        details: {
          token: 'token="super-secret-value"',
          authorization: 'Authorization: Bearer top-secret-token',
          largeValue,
        },
      })
      const line = readLogLines(logFile)[0]
      if (!line) return { ok: false, detail: "no log line written" }
      const redactedToken = line.includes("[REDACTED]") && !line.includes("super-secret-value") && !line.includes("top-secret-token")
      const truncated = line.includes("[truncated")
      return redactedToken && truncated ? { ok: true } : { ok: false, detail: line }
    }),
  },
  {
    name: "Pi default log path remains under the Pi agent directory",
    run: () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-log-pi-default-"))
      try {
        __resetHookHostProfileForTests()
        resetPiHooksLoggerForTests()
        const resolved = withEnv("HOME", tempDir, () =>
          withEnv("PI_YAML_HOOKS_LOG_FILE", undefined, () => getPiHooksLogFilePath()),
        )
        const expected = path.join(tempDir, ".pi", "agent", "logs", "pi-yaml-hooks.ndjson")
        return resolved === expected
          ? { ok: true }
          : { ok: false, detail: `resolved=${resolved} expected=${expected}` }
      } finally {
        __resetHookHostProfileForTests()
        resetPiHooksLoggerForTests()
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  },
  {
    name: "OMP default and named agent directories define default log roots",
    run: () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-log-omp-defaults-"))
      const agentDirs = [
        path.join(tempDir, ".omp", "agent"),
        path.join(tempDir, ".omp", "agent", "profiles", "work"),
      ]
      try {
        for (const agentDir of agentDirs) {
          __resetHookHostProfileForTests()
          resetPiHooksLoggerForTests()
          const profile = configureHookHostProfile({ kind: "omp", agentDir })
          const resolved = withEnv("PI_YAML_HOOKS_LOG_FILE", undefined, () => getPiHooksLogFilePath())
          const expected = path.join(profile.agentDir, "logs", "pi-yaml-hooks.ndjson")
          if (resolved !== expected) {
            return { ok: false, detail: `resolved=${resolved} expected=${expected}` }
          }
        }
        return { ok: true }
      } finally {
        __resetHookHostProfileForTests()
        resetPiHooksLoggerForTests()
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  },
  {
    name: "environment log override remains authoritative for OMP",
    run: () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-log-omp-override-"))
      try {
        __resetHookHostProfileForTests()
        configureHookHostProfile({ kind: "omp", agentDir: path.join(tempDir, ".omp", "agent") })
        return withLoggerEnv({ debug: true }, (logFile) => {
          const resolved = getPiHooksLogFilePath()
          return resolved === logFile
            ? { ok: true }
            : { ok: false, detail: `resolved=${resolved} expected=${logFile}` }
        })
      } finally {
        __resetHookHostProfileForTests()
        resetPiHooksLoggerForTests()
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  },
  {
    name: "cached logger follows a later explicit OMP profile",
    run: () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-log-profile-refresh-"))
      try {
        __resetHookHostProfileForTests()
        resetPiHooksLoggerForTests()
        return withEnv("HOME", tempDir, () =>
          withEnv("PI_YAML_HOOKS_LOG_FILE", undefined, () =>
            withEnv("PI_YAML_HOOKS_DEBUG", "1", () => {
              const piLogger = getPiHooksLogger()
              const profile = configureHookHostProfile({
                kind: "omp",
                agentDir: path.join(tempDir, ".omp", "agent"),
              })
              const ompLogger = getPiHooksLogger()
              const expected = path.join(profile.agentDir, "logs", "pi-yaml-hooks.ndjson")
              return piLogger !== ompLogger && ompLogger.filePath === expected
                ? { ok: true }
                : {
                    ok: false,
                    detail: JSON.stringify({
                      piFilePath: piLogger.filePath,
                      ompFilePath: ompLogger.filePath,
                      expected,
                    }),
                  }
            }),
          ),
        )
      } finally {
        __resetHookHostProfileForTests()
        resetPiHooksLoggerForTests()
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
  },
  {
    name: "empty log override falls back to the active OMP profile path",
    run: () =>
      withProfileLoggerSandbox((tempDir) => {
        const profile = configureHookHostProfile({
          kind: "omp",
          agentDir: path.join(tempDir, ".omp", "profiles", "work", "agent"),
        })
        process.env.PI_YAML_HOOKS_LOG_FILE = "   "

        const expected = path.join(profile.agentDir, "logs", "pi-yaml-hooks.ndjson")
        const logger = getPiHooksLogger()
        logger.info("empty-override", "fallback path")
        const ok =
          getPiHooksLogFilePath() === expected &&
          logger.enabled &&
          logger.filePath === expected &&
          existsSync(expected) &&
          readLogKinds(expected).includes("empty-override")
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
      withProfileLoggerSandbox((tempDir) => {
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
          readLogKinds(override).includes("explicit-override")
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ resolved: getPiHooksLogFilePath(), logger, override }) }
      }),
  },
  {
    name: "disabled logger refreshes across host profile and enable transitions",
    run: () =>
      withProfileLoggerSandbox((tempDir) => {
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
          readLogKinds(expected).includes("enabled-after-switch")
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
      withProfileLoggerSandbox((tempDir) => {
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

        const piKinds = readLogKinds(piPath)
        const ompKinds = readLogKinds(ompPath)
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
  for (const c of cases) {
    try {
      const outcome = c.run()
      if (outcome.ok) {
        console.info(`PASS  ${c.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${c.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${c.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
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
  const code = main()
  process.exit(code)
}
