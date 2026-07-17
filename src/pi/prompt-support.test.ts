import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resetPiHooksLoggerForTests } from "../core/logger.js"
import {
  __resetHookHostProfileForTests,
  configureHookHostProfile,
} from "../core/host-profile.js"
import { registerPromptSupport } from "./prompt-support.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

interface FakePi {
  readonly handlers: Map<string, Handler[]>
  on(event: string, handler: Handler): void
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Handler[]>()
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
  }
}

function withTrust<T>(trusted: boolean, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_YAML_HOOKS_TRUST_PROJECT
  if (trusted) process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
  else delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
  return run().finally(() => {
    if (previous === undefined) delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
    else process.env.PI_YAML_HOOKS_TRUST_PROJECT = previous
  })
}

async function withSandbox<T>(
  opts: { trusted: boolean; awareness?: string | null },
  run: (projectDir: string, homeDir: string) => Promise<T>,
): Promise<T> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-prompt-"))
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-home-"))
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const previousAwareness = process.env.PI_YAML_HOOKS_PROMPT_AWARENESS
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  if (opts.awareness === undefined) {
    delete process.env.PI_YAML_HOOKS_PROMPT_AWARENESS
  } else if (opts.awareness === null) {
    delete process.env.PI_YAML_HOOKS_PROMPT_AWARENESS
  } else {
    process.env.PI_YAML_HOOKS_PROMPT_AWARENESS = opts.awareness
  }
  __resetHookHostProfileForTests()
  resetPiHooksLoggerForTests()

  return withTrust(opts.trusted, async () => {
    try {
      return await run(projectDir, homeDir)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      if (previousAwareness === undefined) delete process.env.PI_YAML_HOOKS_PROMPT_AWARENESS
      else process.env.PI_YAML_HOOKS_PROMPT_AWARENESS = previousAwareness
      resetPiHooksLoggerForTests()
      __resetHookHostProfileForTests()
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })
}

function writeHooksFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function writeProjectHooks(projectDir: string, content: string): void {
  writeHooksFile(path.join(projectDir, ".pi", "hook", "hooks.yaml"), content)
}

async function invokeBeforeAgentStart(
  pi: FakePi,
  projectDir: string,
  hasUI = true,
  basePrompt: string | string[] = "base system prompt",
  mode?: string,
): Promise<unknown> {
  const handlers = pi.handlers.get("before_agent_start") ?? []
  if (handlers.length === 0) {
    throw new Error("no before_agent_start handler registered")
  }
  const ctx = {
    cwd: projectDir,
    hasUI,
    ui: hasUI ? { notify: () => {}, confirm: async () => true, setStatus: () => {} } : undefined,
    ...(mode !== undefined ? { mode } : {}),
    sessionManager: { getSessionId: () => "session", getHeader: () => ({ id: "session" }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    reload: async () => {},
  }
  let result: unknown
  for (const handler of handlers) {
    const r = await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: basePrompt }, ctx)
    if (r !== undefined) result = r
  }
  return result
}

const cases: Case[] = [
  {
    name: "registers a before_agent_start handler",
    run: async () =>
      await withSandbox({ trusted: true }, async () => {
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        return pi.handlers.has("before_agent_start") && (pi.handlers.get("before_agent_start") ?? []).length === 1
          ? { ok: true }
          : { ok: false, detail: `handlers=${JSON.stringify(Array.from(pi.handlers.keys()))}` }
      }),
  },
  {
    name: "reports selected Pi paths and trust state when SDK mode is omitted",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir, homeDir) => {
        const projectPath = path.join(realpathSync.native(projectDir), ".pi", "hook", "hooks.yaml")
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: hi
`,
        )
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        if (typeof sp !== "string") return { ok: false, detail: `result=${JSON.stringify(result)}` }
        const ok =
          sp.startsWith("base system prompt") &&
          sp.includes("Hook-awareness for this session:") &&
          sp.includes("- active hook host: Pi") &&
          sp.includes(`- selected global hook config: ${path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml")}`) &&
          sp.includes(`- project hooks are trusted and active when loaded: ${projectPath}`) &&
          sp.includes(`- project trust list: ${path.join(homeDir, ".pi", "agent", "trusted-projects.json")}`) &&
          sp.includes("pi-yaml-hooks loaded 1 hooks")
        return ok ? { ok: true } : { ok: false, detail: sp }
      }),
  },
  {
    name: "appends OMP awareness as a new system-prompt block without mutating host input",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir, homeDir) => {
        const agentDir = path.join(homeDir, ".omp", "agent", "profiles", "work")
        const profile = configureHookHostProfile({ kind: "omp", agentDir })
        const globalPath = path.join(profile.agentDir, "hook", "hooks.yaml")
        const projectPath = path.join(realpathSync.native(projectDir), ".omp", "hook", "hooks.yaml")
        writeHooksFile(globalPath, "hooks: []\n")
        writeHooksFile(projectPath, "hooks: []\n")
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const hostPrompt = ["base system prompt", "project instructions"]
        const originalHostPrompt = [...hostPrompt]
        const result = await invokeBeforeAgentStart(pi, projectDir, true, hostPrompt)
        const sp = (result as { systemPrompt?: string[] } | undefined)?.systemPrompt
        const awareness = sp?.at(-1)
        const ok =
          Array.isArray(sp) &&
          sp !== hostPrompt &&
          sp.length === hostPrompt.length + 1 &&
          sp[0] === hostPrompt[0] &&
          sp[1] === hostPrompt[1] &&
          JSON.stringify(hostPrompt) === JSON.stringify(originalHostPrompt) &&
          awareness?.includes("- active hook host: OMP") === true &&
          awareness.includes("tool actions inject a follow-up prompt into the current OMP session only") &&
          awareness.includes(`- selected global hook config: ${globalPath}`) &&
          awareness.includes(`- project hooks are trusted and active when loaded: ${projectPath}`) &&
          awareness.includes(`- project trust list: ${path.join(profile.agentDir, "trusted-projects.json")}`)
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ hostPrompt, sp }) }
      }),
  },
  {
    name: "refreshes OMP project fallback paths without loading Pi global config",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir, homeDir) => {
        const agentDir = path.join(homeDir, ".omp", "agent")
        const profile = configureHookHostProfile({ kind: "omp", agentDir })
        const fallbackGlobal = path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml")
        const canonicalProjectDir = realpathSync.native(projectDir)
        const fallbackProject = path.join(canonicalProjectDir, ".pi", "hook", "hooks.yaml")
        const nativeGlobal = path.join(profile.agentDir, "hook", "hooks.yaml")
        const nativeProject = path.join(canonicalProjectDir, ".omp", "hook", "hooks.yaml")
        writeHooksFile(fallbackGlobal, "hooks: []\n")
        writeHooksFile(fallbackProject, "hooks: []\n")
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const initialResult = await invokeBeforeAgentStart(pi, projectDir, true, ["base system prompt"])
        writeHooksFile(nativeGlobal, "hooks: []\n")
        writeHooksFile(nativeProject, "hooks: []\n")
        const refreshedResult = await invokeBeforeAgentStart(pi, projectDir, true, ["base system prompt"])
        const initial = (initialResult as { systemPrompt?: string[] } | undefined)?.systemPrompt?.at(-1)
        const refreshed = (refreshedResult as { systemPrompt?: string[] } | undefined)?.systemPrompt?.at(-1)
        const ok =
          (pi.handlers.get("before_agent_start") ?? []).length === 1 &&
          initial?.includes(`- selected global hook config: ${nativeGlobal}`) === true &&
          initial.includes(`- project hooks are trusted and active when loaded: ${fallbackProject}`) &&
          !initial.includes(fallbackGlobal) &&
          refreshed?.includes(`- selected global hook config: ${nativeGlobal}`) === true &&
          refreshed.includes(`- project hooks are trusted and active when loaded: ${nativeProject}`) &&
          !refreshed.includes(fallbackGlobal) &&
          !refreshed.includes(fallbackProject)
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ initial, refreshed }) }
      }),
  },
  {
    name: "indicates untrusted-but-present project hooks",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: hi
`,
        )
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        return typeof sp === "string" && sp.includes("project hooks exist but are currently untrusted")
          ? { ok: true }
          : { ok: false, detail: typeof sp === "string" ? sp : JSON.stringify(result) }
      }),
  },
  {
    name: "indicates absence of project hook file",
    run: async () =>
      await withSandbox({ trusted: false }, async (projectDir) => {
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        return typeof sp === "string" && sp.includes("no project hook file is present")
          ? { ok: true }
          : { ok: false, detail: typeof sp === "string" ? sp : JSON.stringify(result) }
      }),
  },
  {
    name: "warns about validation issues when hook file is invalid",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify:
`,
        )
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        const ok =
          typeof sp === "string" &&
          sp.includes("validation issue") &&
          sp.includes("/hooks-validate")
        return ok ? { ok: true } : { ok: false, detail: typeof sp === "string" ? sp : JSON.stringify(result) }
      }),
  },
  {
    name: "mentions UI degradation in headless RPC mode",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: hi
`,
        )
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir, false, "base system prompt", "rpc")
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        return typeof sp === "string" && sp.includes("UI is unavailable in this mode")
          ? { ok: true }
          : { ok: false, detail: typeof sp === "string" ? sp : JSON.stringify(result) }
      }),
  },
  {
    name: "is disabled when PI_YAML_HOOKS_PROMPT_AWARENESS=0",
    run: async () =>
      await withSandbox({ trusted: true, awareness: "0" }, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: hi
`,
        )
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        return result === undefined ? { ok: true } : { ok: false, detail: JSON.stringify(result) }
      }),
  },
  {
    name: "keeps OMP host prompt unchanged when awareness is disabled",
    run: async () =>
      await withSandbox({ trusted: true, awareness: "0" }, async (projectDir, homeDir) => {
        configureHookHostProfile({ kind: "omp", agentDir: path.join(homeDir, ".omp", "agent") })
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const hostPrompt = ["base system prompt", "project instructions"]
        const originalHostPrompt = [...hostPrompt]
        const result = await invokeBeforeAgentStart(pi, projectDir, true, hostPrompt)
        const ok = result === undefined && JSON.stringify(hostPrompt) === JSON.stringify(originalHostPrompt)
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ hostPrompt, result }) }
      }),
  },
  {
    // P3-3: accept additional "off" spellings beyond literal "0".
    name: "is disabled for false / off / no / FALSE / 0 (case-insensitive)",
    run: async () => {
      const offValues = ["false", "off", "no", "FALSE", "Off", "  0  "]
      for (const value of offValues) {
        const ok = await withSandbox({ trusted: true, awareness: value }, async (projectDir) => {
          const pi = createFakePi()
          registerPromptSupport(pi as never)
          const result = await invokeBeforeAgentStart(pi, projectDir)
          return result === undefined
        })
        if (!ok) {
          return { ok: false, detail: `expected awareness='${value}' to disable but got a system prompt` }
        }
      }
      return { ok: true }
    },
  },
  {
    name: "remains enabled for any non-disable value of PI_YAML_HOOKS_PROMPT_AWARENESS",
    run: async () =>
      await withSandbox({ trusted: true, awareness: "1" }, async (projectDir) => {
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        return result !== undefined ? { ok: true } : { ok: false, detail: "expected systemPrompt result" }
      }),
  },
  {
    // P2-16: tool-action wording must explicitly state cross-session is
    // impossible (not merely "limited" or "still targets current").
    name: "uses unambiguous tool-action wording in the awareness block",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - event: session.idle
    actions:
      - notify: hi
`,
        )
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const result = await invokeBeforeAgentStart(pi, projectDir)
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        if (typeof sp !== "string") return { ok: false, detail: JSON.stringify(result) }
        const ok =
          sp.includes("tool actions inject a follow-up prompt into the current Pi session only") &&
          sp.includes("they cannot target other sessions")
        return ok ? { ok: true } : { ok: false, detail: sp }
      }),
  },
  {
    name: "appends Pi awareness to the system-prompt string without mutating host input",
    run: async () =>
      await withSandbox({ trusted: true }, async (projectDir) => {
        const pi = createFakePi()
        registerPromptSupport(pi as never)
        const hostPrompt = "base prompt   \n\n  "
        const result = await invokeBeforeAgentStart(pi, projectDir, true, hostPrompt)
        const sp = (result as { systemPrompt?: string } | undefined)?.systemPrompt
        if (typeof sp !== "string") return { ok: false, detail: JSON.stringify(result) }
        const ok =
          hostPrompt === "base prompt   \n\n  " &&
          /base prompt\n\nHook-awareness for this session:/.test(sp)
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ hostPrompt, sp }) }
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
  /prompt-support\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
