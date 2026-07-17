import type { BashExecutionRequest, BashHookResult } from "./bash-types.js"
import {
  createHooksRuntime,
  OMP_SYNCHRONOUS_BASH_BUDGET_MS,
} from "./runtime.js"
import type { HookAction, HookConfig, HookEvent, HookMap, HostAdapter } from "./types.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

function addHook(
  hooks: HookMap,
  event: HookEvent,
  actions: HookAction[],
  asynchronous = false,
): void {
  const hook: HookConfig = {
    event,
    actions,
    scope: "all",
    runIn: "current",
    ...(asynchronous ? { async: true as const } : {}),
    source: { filePath: "/virtual/runtime-budget-hooks.yaml", index: hooks.size },
  }
  hooks.set(event, [...(hooks.get(event) ?? []), hook])
}

function createFakeHost(): HostAdapter {
  return {
    abort: () => {},
    getRootSessionId: (id) => id,
    runBash: async (request) => successfulResult(request.command),
    sendPrompt: () => {},
    notify: () => {},
    confirm: async () => true,
    setStatus: () => {},
  }
}

function successfulResult(command: string): BashHookResult {
  return {
    command,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    blocking: false,
    status: "success",
    durationMs: 0,
    signal: null,
  }
}

const cases: Case[] = [
  {
    name: "unconfigured Pi runtime preserves default and explicit bash timeouts",
    run: async () => {
      const hooks: HookMap = new Map()
      addHook(hooks, "session.created", [
        { bash: "default-timeout" },
        { bash: { command: "explicit-timeout", timeout: 45_000 } },
      ])
      const seen: Array<number | undefined> = []
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        now: () => {
          throw new Error("unconfigured runtime must not read the budget clock")
        },
        executeBash: async (request: BashExecutionRequest) => {
          seen.push(request.timeout)
          return successfulResult(request.command)
        },
      })

      await runtime.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
      return JSON.stringify(seen) === JSON.stringify([undefined, 45_000])
        ? { ok: true }
        : { ok: false, detail: `timeouts=${JSON.stringify(seen)}` }
    },
  },
  {
    name: "one OMP deadline spans file.changed and serial tool.after bash actions",
    run: async () => {
      const hooks: HookMap = new Map()
      addHook(hooks, "file.changed", [{ bash: "file-change" }])
      addHook(hooks, "tool.after.write", [
        { bash: "tool-after-first" },
        { bash: "tool-after-exhausted" },
      ])
      let now = 1_000
      const seen: Array<{ command: string; timeout: number | undefined }> = []
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        synchronousBashBudgetMs: OMP_SYNCHRONOUS_BASH_BUDGET_MS,
        now: () => now,
        executeBash: async (request: BashExecutionRequest) => {
          seen.push({ command: request.command, timeout: request.timeout })
          if (request.command === "file-change") now += 7_000
          if (request.command === "tool-after-first") now += 14_000
          return successfulResult(request.command)
        },
      })

      await runtime["tool.execute.after"]({
        tool: "write",
        sessionID: "s1",
        callID: "c1",
        args: { path: "/repo/a.ts", content: "x" },
      })

      const expected = [
        { command: "file-change", timeout: 20_000 },
        { command: "tool-after-first", timeout: 13_000 },
        { command: "tool-after-exhausted", timeout: 1 },
      ]
      return JSON.stringify(seen) === JSON.stringify(expected)
        ? { ok: true }
        : { ok: false, detail: `calls=${JSON.stringify(seen)}` }
    },
  },
  {
    name: "OMP budget preserves a shorter explicit bash timeout",
    run: async () => {
      const hooks: HookMap = new Map()
      addHook(hooks, "session.created", [
        { bash: { command: "short", timeout: 5_000 } },
      ])
      let seen: number | undefined
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        synchronousBashBudgetMs: OMP_SYNCHRONOUS_BASH_BUDGET_MS,
        now: () => 10_000,
        executeBash: async (request: BashExecutionRequest) => {
          seen = request.timeout
          return successfulResult(request.command)
        },
      })

      await runtime.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
      return seen === 5_000
        ? { ok: true }
        : { ok: false, detail: `timeout=${String(seen)}` }
    },
  },
  {
    name: "user bash shares one deadline across bash and confirmation actions",
    run: async () => {
      const hooks: HookMap = new Map()
      addHook(hooks, "tool.before.bash", [
        { bash: "preflight" },
        { confirm: { title: "Approve", message: "Run command?" } },
      ])
      let now = 1_000
      let bashTimeout: number | undefined
      let confirmTimeout: number | undefined
      const host: HostAdapter = {
        ...createFakeHost(),
        confirm: async (request) => {
          confirmTimeout = request.timeout
          return false
        },
      }
      const runtime = createHooksRuntime(host, {
        directory: "/repo",
        hooks,
        synchronousBashBudgetMs: OMP_SYNCHRONOUS_BASH_BUDGET_MS,
        now: () => now,
        executeBash: async (request: BashExecutionRequest) => {
          bashTimeout = request.timeout
          now += 15_000
          return successfulResult(request.command)
        },
      })

      let blocked = false
      try {
        await runtime["user.bash.before"](
          { tool: "bash", sessionID: "s1", callID: "c1" },
          { args: { command: "echo hi" } },
        )
      } catch {
        blocked = true
      }

      return blocked && bashTimeout === 20_000 && confirmTimeout === 5_000
        ? { ok: true }
        : {
            ok: false,
            detail: `blocked=${String(blocked)}, bash=${String(bashTimeout)}, confirm=${String(confirmTimeout)}`,
          }
    },
  },
  {
    name: "async bash actions omit the synchronous OMP deadline",
    run: async () => {
      const hooks: HookMap = new Map()
      addHook(
        hooks,
        "session.created",
        [{ bash: { command: "background", timeout: 45_000 } }],
        true,
      )
      let seen: number | undefined
      let resolveCalled: (() => void) | undefined
      const called = new Promise<void>((resolve) => {
        resolveCalled = resolve
      })
      const runtime = createHooksRuntime(createFakeHost(), {
        directory: "/repo",
        hooks,
        synchronousBashBudgetMs: OMP_SYNCHRONOUS_BASH_BUDGET_MS,
        now: () => 25_000,
        executeBash: async (request: BashExecutionRequest) => {
          seen = request.timeout
          resolveCalled?.()
          return successfulResult(request.command)
        },
      })

      await runtime.event({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
      await called
      return seen === 45_000
        ? { ok: true }
        : { ok: false, detail: `timeout=${String(seen)}` }
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
  /runtime-budget\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
