import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  watch,
} from "node:fs"
import { once } from "node:events"
import os from "node:os"
import path from "node:path"

import {
  __resetTrustListCacheForTests,
  resolveProjectHookResolution,
  resolveTrustedProjectsFilePath,
} from "../core/config-paths.js"
import {
  __resetHookHostProfileForTests,
  configureHookHostProfile,
  getHookHostProfile,
} from "../core/host-profile.js"
import { resetPiHooksLoggerForTests } from "../core/logger.js"
import { registerCommands } from "./commands.js"
import { PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE } from "./diagnostics.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

interface CapturedMessage {
  readonly customType: string
  readonly content: unknown
  readonly display: boolean
  readonly details?: unknown
}

interface FakePi {
  readonly commands: Map<string, (args: string, ctx: unknown) => Promise<void>>
  readonly messages: CapturedMessage[]
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
  ): void
  sendMessage(message: CapturedMessage): void
}

function createFakePi(): FakePi {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const messages: CapturedMessage[] = []
  return {
    commands,
    messages,
    registerCommand(name, options) {
      commands.set(name, options.handler)
    },
    sendMessage(message) {
      messages.push(message)
    },
  }
}

interface FakeCtx {
  readonly cwd: string
  readonly hasUI: boolean
  readonly notifications: Array<{ message: string; level?: string }>
  readonly reloads: { count: number }
  ui: { notify: (m: string, l?: string) => void; confirm: () => Promise<boolean>; setStatus: () => void } | undefined
  reload: () => Promise<void>
}

function createCtx(opts: { cwd: string; hasUI: boolean }): FakeCtx {
  const notifications: Array<{ message: string; level?: string }> = []
  const reloads = { count: 0 }
  return {
    cwd: opts.cwd,
    hasUI: opts.hasUI,
    notifications,
    reloads,
    ui: opts.hasUI
      ? {
          notify: (message: string, level?: string) => {
            notifications.push({ message, level })
          },
          confirm: async () => true,
          setStatus: () => {},
        }
      : undefined,
    reload: async () => {
      reloads.count += 1
    },
  }
}

async function captureTailFollowArgs(
  handler: (args: string, ctx: unknown) => Promise<void>,
  ctx: FakeCtx,
  sandboxDir: string,
): Promise<string[]> {
  const binDir = path.join(sandboxDir, "fake-bin")
  const capturePath = path.join(sandboxDir, "tail-args.txt")
  const fakeBashPath = path.join(binDir, "bash")
  mkdirSync(binDir, { recursive: true })
  writeFileSync(
    fakeBashPath,
    [
      "#!/bin/sh",
      'tmp=\"${PI_YAML_HOOKS_TEST_TAIL_CAPTURE}.tmp\"',
      'printf \'%s\\n\' \"$@\" > \"$tmp\"',
      'mv \"$tmp\" \"$PI_YAML_HOOKS_TEST_TAIL_CAPTURE\"',
      "",
    ].join("\n"),
    "utf8",
  )
  chmodSync(fakeBashPath, 0o755)

  const previousPath = process.env.PATH
  const previousCapture = process.env.PI_YAML_HOOKS_TEST_TAIL_CAPTURE
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`
  process.env.PI_YAML_HOOKS_TEST_TAIL_CAPTURE = capturePath
  const captureWatcher = watch(sandboxDir)

  try {
    await handler("--follow", ctx as never)
    while (!existsSync(capturePath)) {
      await once(captureWatcher, "change")
    }
    return readFileSync(capturePath, "utf8").trimEnd().split("\n")
  } finally {
    captureWatcher.close()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousCapture === undefined) delete process.env.PI_YAML_HOOKS_TEST_TAIL_CAPTURE
    else process.env.PI_YAML_HOOKS_TEST_TAIL_CAPTURE = previousCapture
  }
}

function writeProjectHooks(
  projectDir: string,
  content: string,
  hostKind: "pi" | "omp" = getHookHostProfile().kind,
): void {
  const filePath = path.join(projectDir, hostKind === "omp" ? ".omp" : ".pi", "hook", "hooks.yaml")
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function trustedFilePath(): string {
  return resolveTrustedProjectsFilePath()
}

async function withSandbox<T>(
  opts: { trusted: boolean; host?: "pi" | "omp"; ompProfile?: string },
  run: (projectDir: string) => Promise<T>,
): Promise<T> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-cmds-"))
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-home-"))
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const previousTrust = process.env.PI_YAML_HOOKS_TRUST_PROJECT
  const previousLogFile = process.env.PI_YAML_HOOKS_LOG_FILE
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  delete process.env.PI_YAML_HOOKS_LOG_FILE
  if (opts.trusted) process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
  else delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
  __resetHookHostProfileForTests()
  __resetTrustListCacheForTests()
  if (opts.host === "omp") {
    const agentDir = opts.ompProfile
      ? path.join(homeDir, ".omp", "profiles", opts.ompProfile, "agent")
      : path.join(homeDir, ".omp", "agent")
    configureHookHostProfile({ kind: "omp", agentDir })
  }
  resetPiHooksLoggerForTests()
  const previousInfo = console.info
  console.info = () => {}
  try {
    return await run(projectDir)
  } finally {
    console.info = previousInfo
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    if (previousTrust === undefined) delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
    else process.env.PI_YAML_HOOKS_TRUST_PROJECT = previousTrust
    if (previousLogFile === undefined) delete process.env.PI_YAML_HOOKS_LOG_FILE
    else process.env.PI_YAML_HOOKS_LOG_FILE = previousLogFile
    resetPiHooksLoggerForTests()
    __resetTrustListCacheForTests()
    __resetHookHostProfileForTests()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
}

const cases: Case[] = [
  {
    name: "registerCommands registers the documented hooks-* commands",
    run: async () =>
      await withSandbox({ trusted: true }, async () => {
        const pi = createFakePi()
        registerCommands(pi as never)
        const expected = ["hooks-status", "hooks-validate", "hooks-trust", "hooks-reload", "hooks-tail-log"]
        for (const name of expected) {
          if (!pi.commands.has(name)) {
            return { ok: false, detail: `missing command ${name}` }
          }
        }
        return { ok: true }
      }),
  },
  {
    name: "hooks-status emits a diagnostics message with trust state line",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-status")!("", ctx as never)

        const diag = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        if (!diag) return { ok: false, detail: "no diagnostics message" }
        const content = String(diag.content ?? "")
        return content.includes("Project trusted: yes") && content.includes("Hook log:")
          ? { ok: true }
          : { ok: false, detail: content }
      }),
  },
  {
    name: "hooks-status notes when project hooks exist but are untrusted",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-status")!("", ctx as never)

        const diag = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const content = String(diag?.content ?? "")
        return content.includes("Project trusted: no") && content.includes("Project hooks exist but are not active")
          ? { ok: true }
          : { ok: false, detail: content }
      }),
  },
  {
    name: "OMP status, validate, trust hint, and tail-log use active host paths",
    run: async () =>
      await withSandbox({ trusted: false, host: "omp" }, async (projectDir) => {
        const profile = getHookHostProfile()
        const expectedGlobal = path.join(profile.agentDir, "hook", "hooks.yaml")
        const expectedProject = path.join(projectDir, ".omp", "hook", "hooks.yaml")
        const expectedTrust = path.join(profile.agentDir, "trusted-projects.json")
        const expectedLog = path.join(profile.agentDir, "logs", "pi-yaml-hooks.ndjson")
        const legacyRoot = path.join(process.env.HOME!, ".pi")
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })

        await pi.commands.get("hooks-status")!("", ctx as never)
        const statusMessage = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const status = String(statusMessage?.content ?? "")

        pi.messages.length = 0
        await pi.commands.get("hooks-validate")!("", ctx as never)
        const validationMessage = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const validation = String(validationMessage?.content ?? "")

        ctx.notifications.length = 0
        await pi.commands.get("hooks-trust")!("", ctx as never)
        const trustHint = ctx.notifications.find((notification) =>
          notification.message.includes("No project hook file was found"),
        )?.message

        ctx.notifications.length = 0
        await pi.commands.get("hooks-tail-log")!("--path", ctx as never)
        const tailPath = ctx.notifications[0]?.message

        const ok =
          status.includes(expectedGlobal) &&
          status.includes(expectedProject) &&
          status.includes(expectedTrust) &&
          status.includes(expectedLog) &&
          !status.includes(legacyRoot) &&
          validation.includes(expectedProject) &&
          trustHint?.includes(expectedProject) === true &&
          tailPath === expectedLog
        return ok
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({ status, validation, trustHint, tailPath, expectedGlobal, expectedProject, expectedTrust, expectedLog }),
            }
      }),
  },
  {
    name: "hooks-validate flags untrusted-but-valid project hooks with /hooks-trust hint",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-validate")!("", ctx as never)

        const diag = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const content = String(diag?.content ?? "")
        return content.includes("valid but untrusted") && content.includes("/hooks-trust")
          ? { ok: true }
          : { ok: false, detail: content }
      }),
  },
  {
    name: "hooks-validate surfaces validation errors as diagnostics",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify:\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-validate")!("", ctx as never)

        const diag = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const details = diag?.details as { level?: string } | undefined
        return details?.level === "warning" ? { ok: true } : { ok: false, detail: JSON.stringify(diag) }
      }),
  },
  {
    name: "hooks-trust writes trust anchor to ~/.pi/agent/trusted-projects.json",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-trust")!("", ctx as never)

        const file = trustedFilePath()
        if (!existsSync(file)) return { ok: false, detail: "trust file not written" }
        const list = JSON.parse(readFileSync(file, "utf8")) as string[]
        const expected = realpathSync.native(projectDir)
        return list.includes(expected) ? { ok: true } : { ok: false, detail: JSON.stringify({ list, expected }) }
      }),
  },
  {
    name: "OMP hooks-trust gates legacy Pi config on OMP trust and atomically updates only OMP store",
    run: async () =>
      await withSandbox({ trusted: false, host: "omp" }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: legacy\n`, "pi")
        const expected = realpathSync.native(projectDir)
        const homeDir = process.env.HOME!
        const piTrustFile = path.join(homeDir, ".pi", "agent", "trusted-projects.json")
        const ompTrustFile = trustedFilePath()
        const existingOmpEntry = path.join(homeDir, "other-project")
        mkdirSync(path.dirname(piTrustFile), { recursive: true })
        mkdirSync(path.dirname(ompTrustFile), { recursive: true })
        writeFileSync(piTrustFile, JSON.stringify([expected], null, 2) + "\n", "utf8")
        writeFileSync(ompTrustFile, JSON.stringify([existingOmpEntry], null, 2) + "\n", "utf8")

        const before = resolveProjectHookResolution({ projectDir })
        if (before?.trusted || before?.projectConfigPath !== path.join(projectDir, ".pi", "hook", "hooks.yaml")) {
          return { ok: false, detail: `legacy config bypassed OMP trust: ${JSON.stringify(before)}` }
        }

        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-trust")!("", ctx as never)

        const ompEntries = JSON.parse(readFileSync(ompTrustFile, "utf8")) as string[]
        const piEntries = JSON.parse(readFileSync(piTrustFile, "utf8")) as string[]
        const mode = statSync(ompTrustFile).mode & 0o777
        const after = resolveProjectHookResolution({ projectDir })
        const success = ctx.notifications.find((notification) => notification.level === "info")?.message
        const ok =
          ompEntries.length === 2 &&
          ompEntries.includes(existingOmpEntry) &&
          ompEntries.includes(expected) &&
          piEntries.length === 1 &&
          piEntries[0] === expected &&
          mode === 0o600 &&
          after?.trusted === true &&
          success?.includes(ompTrustFile) === true
        return ok
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({ ompEntries, piEntries, mode: mode.toString(8), after, success, ompTrustFile }),
            }
      }),
  },
  {
    name: "OMP hooks-trust fails closed on malformed active trust store without touching Pi trust",
    run: async () =>
      await withSandbox({ trusted: false, host: "omp" }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: native\n`)
        const expected = realpathSync.native(projectDir)
        const piTrustFile = path.join(process.env.HOME!, ".pi", "agent", "trusted-projects.json")
        const ompTrustFile = trustedFilePath()
        mkdirSync(path.dirname(piTrustFile), { recursive: true })
        mkdirSync(path.dirname(ompTrustFile), { recursive: true })
        writeFileSync(piTrustFile, JSON.stringify([expected], null, 2) + "\n", "utf8")
        writeFileSync(ompTrustFile, "{malformed", "utf8")

        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-trust")!("", ctx as never)

        const error = ctx.notifications.find((notification) => notification.level === "error")?.message
        const piEntries = JSON.parse(readFileSync(piTrustFile, "utf8")) as string[]
        const ok =
          readFileSync(ompTrustFile, "utf8") === "{malformed" &&
          piEntries.length === 1 &&
          piEntries[0] === expected &&
          error?.includes(ompTrustFile) === true
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ error, piEntries, omp: readFileSync(ompTrustFile, "utf8") }) }
      }),
  },
  {
    name: "OMP hooks-trust atomically replaces a trust-file symlink without modifying its target",
    run: async () =>
      await withSandbox({ trusted: false, host: "omp" }, async (projectDir) => {
        if (process.platform === "win32") return { ok: true }
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: native\n`)
        const expected = realpathSync.native(projectDir)
        const externalContent = JSON.stringify([expected], null, 2) + "\n"
        const ompTrustFile = trustedFilePath()
        const externalTarget = path.join(process.env.HOME!, "external-trust.json")
        mkdirSync(path.dirname(ompTrustFile), { recursive: true })
        writeFileSync(externalTarget, externalContent, "utf8")
        symlinkSync(externalTarget, ompTrustFile)

        const pi = createFakePi()
        registerCommands(pi as never)
        await pi.commands.get("hooks-trust")!("", createCtx({ cwd: projectDir, hasUI: true }) as never)

        const entries = JSON.parse(readFileSync(ompTrustFile, "utf8")) as string[]
        const mode = statSync(ompTrustFile).mode & 0o777
        const ok =
          !lstatSync(ompTrustFile).isSymbolicLink() &&
          readFileSync(externalTarget, "utf8") === externalContent &&
          entries.length === 1 &&
          entries[0] === expected &&
          mode === 0o600
        return ok
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({
                isSymlink: lstatSync(ompTrustFile).isSymbolicLink(),
                external: readFileSync(externalTarget, "utf8"),
                entries,
                mode: mode.toString(8),
              }),
            }
      }),
  },
  {
    name: "hooks-trust does not duplicate an already-trusted project",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const file = trustedFilePath()
        const expected = realpathSync.native(projectDir)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify([expected], null, 2) + "\n", "utf8")
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-trust")!("", ctx as never)

        const list = JSON.parse(readFileSync(file, "utf8")) as string[]
        return list.length === 1 && list[0] === expected
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(list) }
      }),
  },
  {
    name: "hooks-trust warns and refuses to overwrite malformed trusted-projects.json",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const file = trustedFilePath()
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, "{not-json", "utf8")
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-trust")!("", ctx as never)

        const onDisk = readFileSync(file, "utf8")
        const warned = ctx.notifications.some(
          (n) => n.level === "error" && n.message.includes("not valid JSON"),
        )
        return onDisk === "{not-json" && warned
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ onDisk, notifications: ctx.notifications }) }
      }),
  },
  {
    name: "hooks-trust warns when the project has no hook file",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-trust")!("", ctx as never)

        const warned = ctx.notifications.some((n) => n.message.includes("No project hook file was found"))
        const noTrustFile = !existsSync(trustedFilePath())
        return warned && noTrustFile ? { ok: true } : { ok: false, detail: JSON.stringify(ctx.notifications) }
      }),
  },
  {
    name: "hooks-reload notifies and triggers ctx.reload()",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-reload")!("", ctx as never)

        const notified = ctx.notifications.some((n) => /Reloading PI extensions/i.test(n.message))
        return ctx.reloads.count === 1 && notified
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ reloads: ctx.reloads.count, notifications: ctx.notifications }) }
      }),
  },
  {
    name: "hooks-reload still triggers reload in headless mode",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: false })
        await pi.commands.get("hooks-reload")!("", ctx as never)
        return ctx.reloads.count === 1 ? { ok: true } : { ok: false, detail: String(ctx.reloads.count) }
      }),
  },
  {
    name: "hooks-tail-log surfaces a copy-pasteable tail -F command",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-tail-log")!("", ctx as never)

        const tailNotif = ctx.notifications.find((n) => n.message.includes("tail -F"))
        const ok = !!tailNotif && /Hook log: /.test(tailNotif!.message)
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(ctx.notifications) }
      }),
  },
  {
    name: "hooks-tail-log --path prints just the log file path",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-tail-log")!("--path", ctx as never)
        const notif = ctx.notifications.find((n) => /\.ndjson|pi-yaml-hooks/.test(n.message))
        // --path output should be a single-line path, not the multi-line tail hint.
        const ok = !!notif && !notif.message.includes("tail -F")
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify(ctx.notifications) }
      }),
  },
  {
    name: "hooks-tail-log --follow passes the named OMP profile log path to the helper",
    run: async () =>
      await withSandbox(
        { trusted: true, host: "omp", ompProfile: "work" },
        async (projectDir) => {
          const pi = createFakePi()
          registerCommands(pi as never)
          const handler = pi.commands.get("hooks-tail-log")
          if (!handler) return { ok: false, detail: "hooks-tail-log command not registered" }

          const ctx = createCtx({ cwd: projectDir, hasUI: true })
          const args = await captureTailFollowArgs(handler, ctx, projectDir)
          const expected = path.join(
            getHookHostProfile().agentDir,
            "logs",
            "pi-yaml-hooks.ndjson",
          )
          const ok =
            args[0]?.endsWith(path.join("scripts", "tail-hook-log.sh")) === true &&
            args[1] === "--file" &&
            args[2] === expected &&
            ctx.notifications.some((notification) => notification.message.includes(expected))
          return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ args, expected }) }
        },
      ),
  },
  {
    name: "hooks-tail-log --follow preserves an explicit log file override",
    run: async () =>
      await withSandbox({ trusted: true, host: "omp" }, async (projectDir) => {
        const override = path.join(projectDir, "custom logs", "hooks.ndjson")
        process.env.PI_YAML_HOOKS_LOG_FILE = override
        const pi = createFakePi()
        registerCommands(pi as never)
        const handler = pi.commands.get("hooks-tail-log")
        if (!handler) return { ok: false, detail: "hooks-tail-log command not registered" }

        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        const args = await captureTailFollowArgs(handler, ctx, projectDir)
        const ok = args[1] === "--file" && args[2] === override
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ args, override }) }
      }),
  },
  {
    // P1-12: 16 concurrent hooks-trust handlers must converge on a single
    // valid JSON file containing exactly one entry. The legacy
    // writeFileSync path could leave the file truncated or duplicated;
    // the atomic temp+fsync+rename path makes the file always parse and
    // always contain the unique trust anchor.
    name: "hooks-trust writes atomically under concurrent stress",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })

        const handler = pi.commands.get("hooks-trust")!
        const tasks: Array<Promise<void>> = []
        for (let i = 0; i < 16; i++) {
          tasks.push(handler("", ctx as never))
        }
        await Promise.all(tasks)

        const file = trustedFilePath()
        if (!existsSync(file)) return { ok: false, detail: "trust file not written" }

        // Always parses as JSON.
        const raw = readFileSync(file, "utf8")
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          return { ok: false, detail: `unparseable trust file after concurrent writes: ${(error as Error).message}; raw=${raw}` }
        }
        if (!Array.isArray(parsed)) {
          return { ok: false, detail: `expected array, got: ${raw}` }
        }
        const expected = realpathSync.native(projectDir)
        const list = parsed as unknown[]
        const unique = new Set(list)
        const ok = list.length === 1 && unique.size === 1 && list[0] === expected
        return ok
          ? { ok: true }
          : { ok: false, detail: `list=${JSON.stringify(list)}; expected=${expected}` }
      }),
  },
  {
    name: "hooks-trust serializes concurrent updates for different project anchors",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        const secondProjectDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-cmds-second-"))
        try {
          writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: one\n`)
          writeProjectHooks(secondProjectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: two\n`)
          const pi = createFakePi()
          registerCommands(pi as never)
          const handler = pi.commands.get("hooks-trust")!

          await Promise.all([
            handler("", createCtx({ cwd: projectDir, hasUI: true }) as never),
            handler("", createCtx({ cwd: secondProjectDir, hasUI: true }) as never),
          ])

          const list = JSON.parse(readFileSync(trustedFilePath(), "utf8")) as string[]
          const expectedOne = realpathSync.native(projectDir)
          const expectedTwo = realpathSync.native(secondProjectDir)
          const ok = list.includes(expectedOne) && list.includes(expectedTwo)
          return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ list, expectedOne, expectedTwo }) }
        } finally {
          rmSync(secondProjectDir, { recursive: true, force: true })
        }
      }),
  },
  {
    // P2-13: hooks-validate should bucket errors per scope. Inject an
    // intentionally invalid project hook file and assert the diagnostic
    // labels include the scope grouping.
    name: "hooks-validate groups errors by scope (project)",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        // Action with no fields triggers a schema error.
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify:\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-validate")!("", ctx as never)

        const diag = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const content = String(diag?.content ?? "")
        const ok =
          content.includes("Project hook errors:") ||
          content.includes("Project validation errors")
        return ok ? { ok: true } : { ok: false, detail: content }
      }),
  },
  {
    name: "hooks-validate buckets imported project errors separately from project root errors",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        const importedPath = path.join(projectDir, "shared", "bad.yaml")
        mkdirSync(path.dirname(importedPath), { recursive: true })
        writeFileSync(importedPath, `hooks:\n  - event: session.idle\n    actions:\n      - notify:\n`, "utf8")
        writeProjectHooks(projectDir, `imports:\n  - ../../shared/bad.yaml\nhooks: []\n`)
        const pi = createFakePi()
        registerCommands(pi as never)
        const ctx = createCtx({ cwd: projectDir, hasUI: true })
        await pi.commands.get("hooks-validate")!("", ctx as never)

        const diag = pi.messages.find((m) => m.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        const content = String(diag?.content ?? "")
        const ok = content.includes("Imported file errors:") && !content.includes("Project hook errors:")
        return ok ? { ok: true } : { ok: false, detail: content }
      }),
  },
]

export async function main(): Promise<number> {
  let failures = 0
  for (const c of cases) {
    try {
      const outcome = await c.run()
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
  /commands\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
