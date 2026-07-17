import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getActiveHookPolicy, setActiveHookPolicy } from "../core/load-hooks.js"
import { __resetTrustListCacheForTests } from "../core/config-paths.js"
import {
  __resetHookHostProfileForTests,
  getConfiguredHookHostProfile,
} from "../core/host-profile.js"
import { getPiHooksLogFilePath, resetPiHooksLoggerForTests } from "../core/logger.js"
import piHooksExtension from "../index.js"
import { resetHookAutocompleteForTests } from "../pi/autocomplete.js"
import { _resetUserBashWarningForTests } from "../pi/user-bash.js"
import { ompHookPolicy, piHookPolicy } from "../pi/unsupported.js"
import ompHooksExtension from "./index.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

type OmpHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown
type CommandHandler = (args: string, ctx: unknown) => Promise<void>
type AutocompleteItem = { value: string; label: string; description?: string }
type AutocompleteProvider = {
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) => Promise<{ items: AutocompleteItem[]; prefix: string } | null>
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) => { lines: string[]; cursorLine: number; cursorCol: number }
}
type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider

const evidence = {
  profilePaths: new Set<string>(),
  trust: [] as string[],
  traces: [] as string[],
}

class FakeOmpHarness {
  readonly notifications: string[] = []
  readonly confirms: Array<{ title: string; message: string }> = []
  readonly statusUpdates: Array<{ hookId: string; text?: string }> = []
  readonly userMessages: Array<{ text: string; options?: unknown }> = []
  readonly customMessages: Array<{ customType: string; content: unknown; display: boolean; details?: unknown }> = []
  readonly handlers = new Map<string, OmpHandler[]>()
  readonly commands = new Map<string, CommandHandler>()
  readonly messageRenderers = new Map<string, unknown>()
  readonly autocompleteProviders: AutocompleteProviderFactory[] = []
  sessionId = "session-1"
  hasUI = true
  exposeAutocomplete = true
  confirmResult = true
  idle = true
  pendingMessages = false
  reloads = 0
  private sessionGeneration = 0

  constructor(
    readonly projectDir: string,
    readonly agentDir: string,
  ) {}

  createApi(getAgentDir: () => unknown = () => this.agentDir): Record<string, unknown> {
    const apiGeneration = this.sessionGeneration
    return {
      pi: { getAgentDir },
      on: (event: string, handler: OmpHandler) => {
        const handlers = this.handlers.get(event) ?? []
        handlers.push(handler)
        this.handlers.set(event, handlers)
      },
      registerCommand: (name: string, options: { handler: CommandHandler }) => {
        this.commands.set(name, options.handler)
      },
      registerMessageRenderer: (customType: string, renderer: unknown) => {
        this.messageRenderers.set(customType, renderer)
      },
      sendUserMessage: (text: string, options?: unknown) => {
        if (apiGeneration !== this.sessionGeneration) throw new Error("stale OMP ExtensionAPI")
        this.userMessages.push({ text, options })
      },
      sendMessage: (message: { customType: string; content: unknown; display: boolean; details?: unknown }) => {
        this.customMessages.push(message)
      },
    }
  }

  register(getAgentDir?: () => unknown): void {
    ompHooksExtension(this.createApi(getAgentDir ?? (() => this.agentDir)))
  }

  createContext(): unknown {
    const contextGeneration = this.sessionGeneration
    const assertFresh = () => {
      if (contextGeneration !== this.sessionGeneration) throw new Error("stale OMP ExtensionContext")
    }
    return {
      cwd: this.projectDir,
      hasUI: this.hasUI,
      ui: this.hasUI
        ? {
            notify: (text: string) => {
              assertFresh()
              this.notifications.push(text)
            },
            confirm: async (title: string, message: string) => {
              assertFresh()
              this.confirms.push({ title, message })
              return this.confirmResult
            },
            setStatus: (hookId: string, text?: string) => {
              assertFresh()
              this.statusUpdates.push({ hookId, text })
            },
            ...(this.exposeAutocomplete
              ? {
                  addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
                    this.autocompleteProviders.push(factory)
                  },
                }
              : {}),
          }
        : undefined,
      sessionManager: {
        getSessionId: () => {
          assertFresh()
          return this.sessionId
        },
        getHeader: () => {
          assertFresh()
          return { id: this.sessionId }
        },
      },
      isIdle: () => this.idle,
      hasPendingMessages: () => this.pendingMessages,
      reload: async () => {
        this.reloads += 1
      },
    } as never
  }

  replaceSession(sessionId: string): void {
    this.sessionId = sessionId
    this.sessionGeneration += 1
  }

  async emit(eventName: string, event: unknown = {}): Promise<unknown> {
    const handlers = this.handlers.get(eventName)
    if (!handlers || handlers.length === 0) throw new Error(`${eventName} handler was not registered`)
    let result: unknown
    for (const handler of handlers) {
      const next = await handler(event, this.createContext())
      if (next !== undefined) result = next
    }
    return result
  }

  async sessionStart(reason?: "new" | "startup" | "resume" | "fork"): Promise<void> {
    await this.emit("session_start", reason ? { type: "session_start", reason } : { type: "session_start" })
  }

  async sessionBeforeSwitch(reason?: "new" | "resume"): Promise<void> {
    await this.emit("session_before_switch", reason ? { type: "session_before_switch", reason } : {})
  }

  async sessionShutdown(reason?: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> {
    await this.emit("session_shutdown", reason ? { type: "session_shutdown", reason } : {})
  }

  async sessionSwitch(reason?: "new" | "resume" | "fork"): Promise<void> {
    await this.emit("session_switch", reason ? { type: "session_switch", reason } : {})
  }

  async sessionStop(): Promise<void> {
    await this.emit("session_stop", { type: "session_stop" })
  }

  async agentStart(): Promise<void> {
    await this.emit("agent_start", { type: "agent_start" })
  }

  async beforeAgentStart(): Promise<unknown> {
    return await this.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "inspect OMP hooks",
      systemPrompt: "base system prompt",
    })
  }

  async toolCall(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): Promise<unknown> {
    return await this.emit("tool_call", { toolName, toolCallId, input })
  }

  async toolResult(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): Promise<void> {
    await this.emit("tool_result", { toolName, toolCallId, input })
  }

  async userBash(command: string): Promise<unknown> {
    return await this.emit("user_bash", {
      type: "user_bash",
      command,
      excludeFromContext: false,
      cwd: this.projectDir,
    })
  }

  async command(name: string, args = ""): Promise<void> {
    const handler = this.commands.get(name)
    if (!handler) throw new Error(`${name} command was not registered`)
    await handler(args, this.createContext())
  }
}

interface Sandbox {
  readonly projectDir: string
  readonly homeDir: string
  readonly defaultAgentDir: string
  readonly namedAgentDir: string
}

async function withSandbox<T>(run: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-omp-project-"))
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-omp-home-"))
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_YAML_HOOKS_TRUST_PROJECT: process.env.PI_YAML_HOOKS_TRUST_PROJECT,
    PI_YAML_HOOKS_ENABLE_USER_BASH: process.env.PI_YAML_HOOKS_ENABLE_USER_BASH,
    PI_YAML_HOOKS_DEBUG: process.env.PI_YAML_HOOKS_DEBUG,
    PI_YAML_HOOKS_LOG_FILE: process.env.PI_YAML_HOOKS_LOG_FILE,
  }
  const previousWarn = console.warn
  const previousError = console.error
  const previousInfo = console.info
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
  delete process.env.PI_YAML_HOOKS_ENABLE_USER_BASH
  delete process.env.PI_YAML_HOOKS_DEBUG
  delete process.env.PI_YAML_HOOKS_LOG_FILE
  console.warn = () => {}
  console.error = () => {}
  console.info = () => {}
  resetState()

  try {
    return await run({
      projectDir,
      homeDir,
      defaultAgentDir: path.join(homeDir, ".omp", "agent"),
      namedAgentDir: path.join(homeDir, ".omp", "profiles", "work", "agent"),
    })
  } finally {
    resetState()
    console.warn = previousWarn
    console.error = previousError
    console.info = previousInfo
    restoreEnv("HOME", previous.HOME)
    restoreEnv("USERPROFILE", previous.USERPROFILE)
    restoreEnv("PI_YAML_HOOKS_TRUST_PROJECT", previous.PI_YAML_HOOKS_TRUST_PROJECT)
    restoreEnv("PI_YAML_HOOKS_ENABLE_USER_BASH", previous.PI_YAML_HOOKS_ENABLE_USER_BASH)
    restoreEnv("PI_YAML_HOOKS_DEBUG", previous.PI_YAML_HOOKS_DEBUG)
    restoreEnv("PI_YAML_HOOKS_LOG_FILE", previous.PI_YAML_HOOKS_LOG_FILE)
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
}

function resetState(): void {
  resetPiHooksLoggerForTests()
  resetHookAutocompleteForTests()
  _resetUserBashWarningForTests()
  __resetTrustListCacheForTests()
  __resetHookHostProfileForTests()
  setActiveHookPolicy(piHookPolicy)
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function writeHooks(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function writeOmpProjectHooks(projectDir: string, content: string): string {
  const filePath = path.join(projectDir, ".omp", "hook", "hooks.yaml")
  writeHooks(filePath, content)
  return filePath
}

function writePiFallbackHooks(projectDir: string, content: string): string {
  const filePath = path.join(projectDir, ".pi", "hook", "hooks.yaml")
  writeHooks(filePath, content)
  return filePath
}

function writeTrust(agentDir: string, projectDir: string): string {
  const trustFile = path.join(agentDir, "trusted-projects.json")
  mkdirSync(path.dirname(trustFile), { recursive: true })
  writeFileSync(trustFile, `${JSON.stringify([realpathSync.native(projectDir)], null, 2)}\n`, "utf8")
  return trustFile
}

function allMessages(harness: FakeOmpHarness): string {
  return harness.customMessages.map((message) => String(message.content)).join("\n")
}

function createNoopAutocompleteProvider(): AutocompleteProvider {
  return {
    async getSuggestions() {
      return null
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol }
    },
  }
}

interface FakeMacrotasks {
  readonly pendingCount: number
  flushAll(): Promise<void>
}

async function withFakeMacrotasks<T>(run: (clock: FakeMacrotasks) => Promise<T>): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout
  const queue: Array<() => unknown> = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => unknown, _delay?: number, ...args: unknown[]) => {
    queue.push(() => callback(...args))
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout
  const clock: FakeMacrotasks = {
    get pendingCount() {
      return queue.length
    },
    async flushAll() {
      while (queue.length > 0) {
        const callback = queue.shift()
        if (callback) await callback()
      }
    },
  }
  try {
    return await run(clock)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
}

const cases: Case[] = [
  {
    name: "default OMP factory configures its agent root before logger and registration",
    run: async () =>
      await withSandbox(async ({ projectDir, homeDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_DEBUG = "1"
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        const agentDirExistedBeforeRegistration = existsSync(defaultAgentDir)
        harness.register()
        const profile = getConfiguredHookHostProfile()
        const logPath = getPiHooksLogFilePath()
        const expectedAgentDir = path.join(realpathSync.native(homeDir), ".omp", "agent")
        const expectedLog = path.join(expectedAgentDir, "logs", "pi-yaml-hooks.ndjson")
        const piLog = path.join(realpathSync.native(homeDir), ".pi", "agent", "logs", "pi-yaml-hooks.ndjson")
        evidence.profilePaths.add(expectedAgentDir)
        return !agentDirExistedBeforeRegistration &&
            profile?.kind === "omp" &&
            profile.agentDir === expectedAgentDir &&
            getActiveHookPolicy() === ompHookPolicy &&
            logPath === expectedLog &&
            existsSync(expectedLog) &&
            !existsSync(piLog) &&
            harness.commands.has("hooks-status") &&
            harness.messageRenderers.has("pi-yaml-hooks-diagnostics")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ profile, logPath, expectedLog, piLog }) }
      }),
  },
  {
    name: "named OMP profile drives commands, prompt, autocomplete, and user_bash paths",
    run: async () =>
      await withSandbox(async ({ projectDir, namedAgentDir }) => {
        process.env.PI_YAML_HOOKS_ENABLE_USER_BASH = "1"
        const globalPath = path.join(namedAgentDir, "hook", "hooks.yaml")
        const projectPath = writeOmpProjectHooks(
          projectDir,
          `hooks:\n  - id: profile-created\n    event: session.created\n    actions:\n      - notify: "profile-created"\n  - id: profile-bash\n    event: tool.before.bash\n    actions:\n      - notify: "profile-bash"\n`,
        )
        writeHooks(globalPath, "hooks: []\n")
        const trustPath = writeTrust(namedAgentDir, projectDir)
        const harness = new FakeOmpHarness(projectDir, namedAgentDir)
        harness.register()
        await harness.sessionStart()
        const bashResult = await harness.userBash("echo omp")
        await harness.command("hooks-status")
        const promptResult = await harness.beforeAgentStart()
        const prompt = (promptResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? ""
        const factory = harness.autocompleteProviders[0]
        const suggestions = factory
          ? await factory(createNoopAutocompleteProvider()).getSuggestions(["/hooks-status "], 0, 14, {
              signal: new AbortController().signal,
              force: true,
            })
          : null
        const suggestionText = JSON.stringify(suggestions)
        const messages = allMessages(harness)
        const expectedLog = path.join(namedAgentDir, "logs", "pi-yaml-hooks.ndjson")
        evidence.profilePaths.add(namedAgentDir)
        evidence.trust.push(`named:${trustPath}`)
        const ok =
          bashResult === undefined &&
          harness.notifications.includes("profile-created") &&
          harness.notifications.includes("profile-bash") &&
          messages.includes(globalPath) &&
          messages.includes(projectPath) &&
          messages.includes(trustPath) &&
          messages.includes(expectedLog) &&
          prompt.includes(globalPath) &&
          prompt.includes(projectPath) &&
          prompt.includes(trustPath) &&
          suggestionText.includes(globalPath) &&
          suggestionText.includes(projectPath)
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ notifications: harness.notifications, messages, prompt, suggestions }) }
      }),
  },
  {
    name: "missing pi.pi.getAgentDir capability fails before registration",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        const missingPi = harness.createApi()
        delete missingPi.pi
        const missingMethod = harness.createApi()
        missingMethod.pi = {}
        const errors: string[] = []
        for (const input of [missingPi, missingMethod, null]) {
          try {
            ompHooksExtension(input)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        }
        return errors.length === 3 && errors.every((message) => message.includes("pi.pi.getAgentDir")) &&
            getConfiguredHookHostProfile() === undefined
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ errors, profile: getConfiguredHookHostProfile() }) }
      }),
  },
  {
    name: "invalid or throwing getAgentDir fails clearly before registration",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        const nonStringOrBlankResults: unknown[] = [undefined, null, 42, "", "   "]
        const relativeResults: unknown[] = [".", "relative/agent"]
        const invalidHarnesses: FakeOmpHarness[] = []
        const errors: string[] = []
        for (const result of [...nonStringOrBlankResults, ...relativeResults]) {
          const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
          invalidHarnesses.push(harness)
          try {
            harness.register(() => result)
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error))
          }
        }
        const throwingHarness = new FakeOmpHarness(projectDir, defaultAgentDir)
        invalidHarnesses.push(throwingHarness)
        try {
          throwingHarness.register(() => {
            throw new Error("profile unavailable")
          })
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error))
        }
        const blankErrors = errors.slice(0, nonStringOrBlankResults.length)
        const relativeErrors = errors.slice(
          nonStringOrBlankResults.length,
          nonStringOrBlankResults.length + relativeResults.length,
        )
        const noRegistrationSideEffects = invalidHarnesses.every(
          (harness) =>
            harness.handlers.size === 0 &&
            harness.commands.size === 0 &&
            harness.messageRenderers.size === 0 &&
            harness.autocompleteProviders.length === 0,
        )
        return blankErrors.length === nonStringOrBlankResults.length &&
            blankErrors.every((message) => message.includes("non-empty string")) &&
            relativeErrors.length === relativeResults.length &&
            relativeErrors.every((message) => message.includes("absolute agentDir path")) &&
            errors.at(-1)?.includes("could not resolve the active agentDir") === true &&
            noRegistrationSideEffects &&
            getConfiguredHookHostProfile() === undefined &&
            getActiveHookPolicy() === piHookPolicy
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({
                errors,
                profile: getConfiguredHookHostProfile(),
                activePolicyIsPi: getActiveHookPolicy() === piHookPolicy,
                noRegistrationSideEffects,
              }),
            }
      }),
  },
  {
    name: "same OMP profile reload is allowed after canonicalization",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        mkdirSync(defaultAgentDir, { recursive: true })
        const first = new FakeOmpHarness(projectDir, defaultAgentDir)
        const second = new FakeOmpHarness(projectDir, path.join(defaultAgentDir, "."))
        first.register()
        const configured = getConfiguredHookHostProfile()
        second.register()
        return configured === getConfiguredHookHostProfile() && configured?.agentDir === realpathSync.native(defaultAgentDir)
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ configured, reloaded: getConfiguredHookHostProfile() }) }
      }),
  },
  {
    name: "Pi-configured process rejects later OMP registration",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        piHooksExtension(harness.createApi() as never)
        let message = ""
        try {
          harness.register()
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        return message.includes("already configured for pi") && message.includes("cannot reconfigure for omp")
          ? { ok: true }
          : { ok: false, detail: `message=${message}` }
      }),
  },
  {
    name: "Pi-only trust cannot authorize OMP legacy .pi fallback hooks or user_bash",
    run: async () =>
      await withSandbox(async ({ projectDir, homeDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_ENABLE_USER_BASH = "1"
        const fallbackPath = writePiFallbackHooks(
          projectDir,
          `hooks:\n  - event: session.created\n    actions:\n      - notify: "legacy-created"\n  - event: tool.before.bash\n    actions:\n      - confirm:\n          title: "legacy approval"\n          message: "allow?"\n`,
        )
        const piTrust = writeTrust(path.join(homeDir, ".pi", "agent"), projectDir)
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        harness.hasUI = false
        harness.register()
        await harness.sessionStart()
        const bashResult = await harness.userBash("rm -rf .")
        await harness.command("hooks-status")
        const messages = allMessages(harness)
        const ompTrust = path.join(defaultAgentDir, "trusted-projects.json")
        evidence.trust.push(`isolated:pi=${piTrust};omp=${ompTrust}`)
        const ok =
          harness.notifications.length === 0 &&
          bashResult === undefined &&
          messages.includes(fallbackPath) &&
          messages.includes(ompTrust) &&
          messages.includes("Project trusted: no") &&
          !messages.includes(piTrust)
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ notifications: harness.notifications, bashResult, messages, piTrust, ompTrust }) }
      }),
  },
  {
    name: "active OMP trust authorizes legacy fallback and typed shell interception",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_ENABLE_USER_BASH = "1"
        writePiFallbackHooks(
          projectDir,
          `hooks:\n  - event: session.created\n    actions:\n      - notify: "legacy-created"\n  - event: tool.before.bash\n    actions:\n      - confirm:\n          title: "legacy approval"\n          message: "allow?"\n`,
        )
        writeTrust(defaultAgentDir, projectDir)
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        harness.confirmResult = false
        harness.register()
        await harness.sessionStart()
        const result = await harness.userBash("rm -rf .")
        const blocked = result as { result?: { cancelled?: boolean; output?: string } } | undefined
        return harness.notifications.includes("legacy-created") &&
            blocked?.result?.cancelled === true &&
            blocked.result.output?.includes("user_bash blocked") === true
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ notifications: harness.notifications, result }) }
      }),
  },
  {
    name: "OMP tool before blocks and tool after dispatches",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
        writeOmpProjectHooks(
          projectDir,
          `hooks:\n  - event: tool.before.bash\n    actions:\n      - confirm:\n          title: "Approval required"\n          message: "Run command?"\n  - event: tool.after.write\n    actions:\n      - notify: "after-write"\n`,
        )
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        harness.confirmResult = false
        harness.register()
        const before = await harness.toolCall("bash", "call-before", { command: "echo hi" })
        await harness.toolResult("write", "call-after", { path: path.join(projectDir, "file.ts"), content: "ok" })
        const blocked = before as { block?: boolean; reason?: string } | undefined
        const trace = `tool.before.bash=${blocked?.block === true ? "blocked" : "allowed"};tool.after.write=${harness.notifications.join(",")}`
        evidence.traces.push(trace)
        return blocked?.block === true && blocked.reason?.includes("confirm") === true && harness.notifications.join(",") === "after-write"
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ before, notifications: harness.notifications }) }
      }),
  },
  {
    name: "OMP startup, new, resume, and fork map session.created exactly once",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
        writeOmpProjectHooks(projectDir, "hooks:\n  - event: session.created\n    actions:\n      - notify: \"created\"\n")
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        harness.register()
        await harness.sessionStart()
        await harness.sessionStart()
        await harness.sessionStart("resume")
        await harness.sessionStart("fork")
        harness.replaceSession("session-2")
        await harness.sessionSwitch("new")
        await harness.sessionSwitch("new")
        harness.replaceSession("session-3")
        await harness.sessionSwitch("resume")
        harness.replaceSession("session-4")
        await harness.sessionSwitch("fork")
        const trace = harness.notifications.join(",")
        evidence.traces.push(`created(startup,new,resume,fork)=${trace}`)
        return trace === "created,created"
          ? { ok: true }
          : { ok: false, detail: `notifications=${JSON.stringify(harness.notifications)}` }
      }),
  },
  {
    name: "OMP deleted sequence preserves reasons and deduplicates replacement pairs",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
        process.env.PI_YAML_HOOKS_DEBUG = "1"
        const logFile = path.join(projectDir, "lifecycle.ndjson")
        process.env.PI_YAML_HOOKS_LOG_FILE = logFile
        writeOmpProjectHooks(projectDir, "hooks:\n  - event: session.deleted\n    actions:\n      - notify: \"deleted\"\n")
        const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
        harness.register()
        await harness.sessionBeforeSwitch("new")
        await harness.sessionShutdown("new")
        harness.replaceSession("session-2")
        await harness.sessionShutdown("quit")
        const reasons = readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind?: string; event?: string; details?: { reason?: string } })
          .filter((entry) => entry.kind === "dispatch_start" && entry.event === "session.deleted")
          .map((entry) => entry.details?.reason)
        evidence.traces.push(`deleted=${reasons.join(",")}`)
        return harness.notifications.join(",") === "deleted,deleted" && JSON.stringify(reasons) === JSON.stringify(["new", "quit"])
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ notifications: harness.notifications, reasons }) }
      }),
  },
  {
    name: "OMP deferred idle suppresses replaced, continuing, busy, pending, and duplicate stops",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) =>
        await withFakeMacrotasks(async (clock) => {
          process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
          writeOmpProjectHooks(projectDir, "hooks:\n  - event: session.idle\n    actions:\n      - notify: \"idle\"\n")
          const harness = new FakeOmpHarness(projectDir, defaultAgentDir)
          harness.register()
          await harness.agentStart()
          await harness.sessionStop()
          const deferred = harness.notifications.length === 0 && clock.pendingCount === 1
          harness.replaceSession("session-2")
          await clock.flushAll()

          await harness.agentStart()
          await harness.sessionStop()
          await harness.agentStart()
          await clock.flushAll()

          harness.idle = false
          await harness.sessionStop()
          await clock.flushAll()
          harness.idle = true
          harness.pendingMessages = true
          await harness.sessionStop()
          await clock.flushAll()

          harness.pendingMessages = false
          await harness.agentStart()
          await harness.sessionStop()
          await harness.sessionStop()
          const duplicateChecks = clock.pendingCount === 2
          await clock.flushAll()
          const trace = `deferred=${deferred};duplicateChecks=${duplicateChecks};notifications=${harness.notifications.join(",")}`
          evidence.traces.push(`idle:${trace}`)
          return deferred && duplicateChecks && harness.notifications.join(",") === "idle"
            ? { ok: true }
            : { ok: false, detail: trace }
        }),
      ),
  },
  {
    name: "OMP UI permits confirm while headless mode blocks and degrades capabilities",
    run: async () =>
      await withSandbox(async ({ projectDir, defaultAgentDir }) => {
        process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
        writeOmpProjectHooks(
          projectDir,
          `hooks:\n  - event: tool.before.bash\n    actions:\n      - confirm:\n          title: "Approval required"\n          message: "Run command?"\n`,
        )
        const uiHarness = new FakeOmpHarness(projectDir, defaultAgentDir)
        uiHarness.register()
        const uiResult = await uiHarness.toolCall("bash", "ui-call", { command: "echo ui" })

        const headlessHarness = new FakeOmpHarness(projectDir, defaultAgentDir)
        headlessHarness.hasUI = false
        headlessHarness.register()
        await headlessHarness.sessionStart()
        const headlessResult = await headlessHarness.toolCall("bash", "headless-call", { command: "echo headless" })
        const promptResult = await headlessHarness.beforeAgentStart()
        const prompt = (promptResult as { systemPrompt?: string } | undefined)?.systemPrompt ?? ""
        const blocked = headlessResult as { block?: boolean } | undefined
        return uiResult === undefined &&
            uiHarness.confirms.length === 1 &&
            blocked?.block === true &&
            headlessHarness.confirms.length === 0 &&
            headlessHarness.autocompleteProviders.length === 0 &&
            prompt.includes("UI is unavailable in this mode")
          ? { ok: true }
          : {
              ok: false,
              detail: JSON.stringify({ uiResult, uiConfirms: uiHarness.confirms, headlessResult, prompt }),
            }
      }),
  },
]

export async function main(): Promise<number> {
  let failures = 0
  for (const testCase of cases) {
    try {
      const outcome = await testCase.run()
      if (outcome.ok) console.info(`PASS  ${testCase.name}`)
      else {
        failures += 1
        console.info(`FAIL  ${testCase.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${testCase.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  if (failures === 0) {
    console.info(`EVIDENCE profile roots: ${Array.from(evidence.profilePaths).join(" | ")}`)
    console.info(`EVIDENCE trust: ${evidence.trust.join(" | ")}`)
    console.info(`EVIDENCE traces: ${evidence.traces.join(" | ")}`)
  }
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /adapter\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
