import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { resetPiHooksLoggerForTests } from "../core/logger.js"
import {
  __resetHookHostProfileForTests,
  configureHookHostProfile,
} from "../core/host-profile.js"
import {
  __setHookAutocompleteInstrumentationForTests,
  registerHookAutocomplete,
  resetHookAutocompleteForTests,
} from "./autocomplete.js"

interface Case {
  readonly name: string
  readonly run: () => Promise<{ ok: boolean; detail?: string }>
}

type AutocompleteItem = { value: string; label: string; description?: string }
type Suggestions = { items: AutocompleteItem[]; prefix: string } | null
type AutocompleteProvider = {
  getSuggestions: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) => Promise<Suggestions>
  applyCompletion: (
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) => { lines: string[]; cursorLine: number; cursorCol: number }
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean
}
type Factory = (current: AutocompleteProvider) => AutocompleteProvider

function createNoopProvider(): AutocompleteProvider {
  return {
    async getSuggestions() {
      return null
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol }
    },
  }
}

function createInnerProviderWithItem(item: AutocompleteItem): AutocompleteProvider {
  return {
    async getSuggestions() {
      return { items: [item], prefix: "" }
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol }
    },
    shouldTriggerFileCompletion() {
      return true
    },
  }
}

interface FakeContext {
  readonly cwd: string
  readonly hasUI: boolean
  readonly mode?: string
  ui?: { addAutocompleteProvider?: (factory: Factory) => void }
  factories: Factory[]
}

function makeContext(opts: { projectDir: string; hasUI: boolean; expose: boolean; mode?: string }): FakeContext {
  const factories: Factory[] = []
  return {
    cwd: opts.projectDir,
    hasUI: opts.hasUI,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    factories,
    ui: opts.hasUI
      ? {
          ...(opts.expose
            ? {
                addAutocompleteProvider: (factory: Factory) => {
                  factories.push(factory)
                },
              }
            : {}),
        }
      : undefined,
  }
}

function writeHooksFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, "utf8")
}

function writeProjectHooks(projectDir: string, content: string): void {
  writeHooksFile(path.join(projectDir, ".pi", "hook", "hooks.yaml"), content)
}

async function withSandbox<T>(run: (projectDir: string, homeDir: string) => Promise<T>): Promise<T> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-autocomplete-"))
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "pi-yaml-hooks-home-"))
  const previousHome = process.env.HOME
  const previousUserProfile = process.env.USERPROFILE
  const previousTrust = process.env.PI_YAML_HOOKS_TRUST_PROJECT
  const previousAllowGlobalImports = process.env.PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS
  const previousAllowPackageImports = process.env.PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS
  const previousAllowOutsideTrust = process.env.PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
  __resetHookHostProfileForTests()
  resetPiHooksLoggerForTests()
  resetHookAutocompleteForTests()
  try {
    return await run(projectDir, homeDir)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousUserProfile
    if (previousTrust === undefined) delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
    else process.env.PI_YAML_HOOKS_TRUST_PROJECT = previousTrust
    if (previousAllowGlobalImports === undefined) delete process.env.PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS
    else process.env.PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS = previousAllowGlobalImports
    if (previousAllowPackageImports === undefined) delete process.env.PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS
    else process.env.PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS = previousAllowPackageImports
    if (previousAllowOutsideTrust === undefined) delete process.env.PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR
    else process.env.PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR = previousAllowOutsideTrust
    resetPiHooksLoggerForTests()
    resetHookAutocompleteForTests()
    __resetHookHostProfileForTests()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
}

const signal = () => new AbortController().signal

const cases: Case[] = [
  {
    name: "skips registration when ctx.hasUI is false",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: false, expose: false })
        registerHookAutocomplete(ctx as never)
        return ctx.factories.length === 0
          ? { ok: true }
          : { ok: false, detail: `factories=${ctx.factories.length}` }
      }),
  },
  {
    name: "skips registration when addAutocompleteProvider is missing",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: false })
        registerHookAutocomplete(ctx as never)
        return ctx.factories.length === 0
          ? { ok: true }
          : { ok: false, detail: `factories=${ctx.factories.length}` }
      }),
  },
  {
    name: "skips TUI-only autocomplete registration in RPC mode even when UI exists",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true, mode: "rpc" })
        registerHookAutocomplete(ctx as never)
        return ctx.factories.length === 0
          ? { ok: true }
          : { ok: false, detail: `factories=${ctx.factories.length}` }
      }),
  },
  {
    name: "registers exactly one factory and is idempotent",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        registerHookAutocomplete(ctx as never)
        return ctx.factories.length === 1
          ? { ok: true }
          : { ok: false, detail: `factories=${ctx.factories.length}` }
      }),
  },
  {
    name: "suggests all hook slash commands when token prefix is /hooks-",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        // Use the bare /hooks- prefix so every hooks-* label matches the substring filter.
        const input = "/hooks-"
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const values = suggestions?.items.map((i) => i.value) ?? []
        const required = ["hooks-status", "hooks-validate", "hooks-trust", "hooks-reload", "hooks-tail-log"]
        const missing = required.filter((r) => !values.includes(r))
        return missing.length === 0 ? { ok: true } : { ok: false, detail: `missing=${missing.join(",")} got=${JSON.stringify(values)}` }
      }),
  },
  {
    name: "filters slash command completions by prefix on label/value",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-st"
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const values = suggestions?.items.map((i) => i.value) ?? []
        return values.includes("hooks-status") && !values.includes("hooks-reload")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(values) }
      }),
  },
  {
    // P3-5: substring-of-the-name like "us" used to wrongly surface
    // "hooks-status" because the substring sat inside "status". With prefix
    // matching the user must start typing the actual command name.
    name: "prefix-matches command names so unrelated substrings do not match",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/us"
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        // Outside the /hooks- token the provider returns null, so any
        // suggestions should not include hooks-status via false-positive
        // substring match.
        const values = suggestions?.items.map((i) => i.value) ?? []
        return !values.includes("hooks-status")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(values) }
      }),
  },
  {
    // P1-11: state captured at registration must not freeze; a hook id
    // added to hooks.yaml after registration should appear on the next
    // suggestion call.
    name: "picks up newly added hook ids without re-registering",
    run: async () =>
      await withSandbox(async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - id: original-hook
    event: tool.after.write
    actions:
      - notify: ok
`,
        )
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())

        // Add a new hook id after the provider has been registered.
        writeProjectHooks(
          projectDir,
          `hooks:
  - id: original-hook
    event: tool.after.write
    actions:
      - notify: ok
  - id: brand-new-hook
    event: tool.after.read
    actions:
      - notify: ok
`,
        )

        const input = "/hooks-status brand-"
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const values = suggestions?.items.map((i) => i.value) ?? []
        return values.includes("brand-new-hook")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(values) }
      }),
  },
  {
    name: "reuses cached autocomplete state without repeating discovery or project resolution",
    run: async () =>
      await withSandbox(async (projectDir) => {
        writeProjectHooks(projectDir, "hooks: []\n")
        let discoveryCalls = 0
        let projectResolutionCalls = 0
        __setHookAutocompleteInstrumentationForTests({
          onDiscovery: () => {
            discoveryCalls += 1
          },
          onProjectResolution: () => {
            projectResolutionCalls += 1
          },
        })
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status "
        await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        return discoveryCalls === 1 && projectResolutionCalls === 1
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ discoveryCalls, projectResolutionCalls }) }
      }),
  },
  {
    name: "invalidates cached autocomplete state when a watched hook file changes",
    run: async () =>
      await withSandbox(async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - id: original-hook
    event: tool.after.write
    actions:
      - notify: ok
`,
        )
        let discoveryCalls = 0
        __setHookAutocompleteInstrumentationForTests({
          onDiscovery: () => {
            discoveryCalls += 1
          },
        })
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status changed-"
        await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        writeProjectHooks(
          projectDir,
          `hooks:
  - id: changed-hook
    event: tool.after.read
    actions:
      - notify: refreshed
`,
        )
        const refreshed = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const values = refreshed?.items.map((item) => item.value) ?? []
        return discoveryCalls === 2 && values.includes("changed-hook")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ discoveryCalls, values }) }
      }),
  },
  {
    name: "invalidates cached autocomplete state when an import trust env value changes",
    run: async () =>
      await withSandbox(async (projectDir, homeDir) => {
        const globalDir = path.join(homeDir, ".pi", "agent", "hook")
        writeHooksFile(
          path.join(globalDir, "hooks.yaml"),
          `imports:
  - ./shared.yaml
hooks: []
`,
        )
        writeHooksFile(
          path.join(globalDir, "shared.yaml"),
          `hooks:
  - id: imported-after-env
    event: session.idle
    actions:
      - notify: imported
`,
        )
        delete process.env.PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS
        let discoveryCalls = 0
        __setHookAutocompleteInstrumentationForTests({
          onDiscovery: () => {
            discoveryCalls += 1
          },
        })
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status imported-"
        const initial = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        process.env.PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS = "1"
        const refreshed = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const initialValues = initial?.items.map((item) => item.value) ?? []
        const refreshedValues = refreshed?.items.map((item) => item.value) ?? []
        return discoveryCalls === 2 &&
          !initialValues.includes("imported-after-env") &&
          refreshedValues.includes("imported-after-env")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ discoveryCalls, initialValues, refreshedValues }) }
      }),
  },
  {
    name: "refreshes when a missing import is added and when that import is edited",
    run: async () =>
      await withSandbox(async (projectDir, homeDir) => {
        const globalDir = path.join(homeDir, ".pi", "agent", "hook")
        const importedPath = path.join(globalDir, "packs", "shared.yaml")
        writeHooksFile(
          path.join(globalDir, "hooks.yaml"),
          `imports:
  - ./packs/shared.yaml
hooks: []
`,
        )
        process.env.PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS = "1"
        let discoveryCalls = 0
        __setHookAutocompleteInstrumentationForTests({
          onDiscovery: () => {
            discoveryCalls += 1
          },
        })
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status import-"
        await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        writeHooksFile(
          importedPath,
          `hooks:
  - id: import-added
    event: session.idle
    actions:
      - notify: added
`,
        )
        const added = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        writeHooksFile(
          importedPath,
          `hooks:
  - id: import-edited
    event: session.idle
    actions:
      - notify: edited
`,
        )
        const edited = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const addedValues = added?.items.map((item) => item.value) ?? []
        const editedValues = edited?.items.map((item) => item.value) ?? []
        return discoveryCalls === 3 &&
          addedValues.includes("import-added") &&
          editedValues.includes("import-edited") &&
          !editedValues.includes("import-added")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ discoveryCalls, addedValues, editedValues }) }
      }),
  },
  {
    name: "returns null suggestions outside /hooks- prefix",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const suggestions = await provider.getSuggestions(["echo hi"], 0, "echo hi".length, { signal: signal() })
        return suggestions === null ? { ok: true } : { ok: false, detail: JSON.stringify(suggestions) }
      }),
  },
  {
    name: "suggests hook ids and event names as arguments to /hooks-status",
    run: async () =>
      await withSandbox(async (projectDir) => {
        writeProjectHooks(
          projectDir,
          `hooks:
  - id: my-cool-hook
    event: tool.after.write
    actions:
      - notify: ok
`,
        )
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status "
        const idSuggestions = await provider.getSuggestions([input + "my"], 0, (input + "my").length, { signal: signal() })
        const idValues = idSuggestions?.items.map((i) => i.value) ?? []
        const eventInput = "/hooks-status tool.after"
        const eventSuggestions = await provider.getSuggestions([eventInput], 0, eventInput.length, { signal: signal() })
        const eventValues = eventSuggestions?.items.map((i) => i.value) ?? []
        const ok = idValues.includes("my-cool-hook") && eventValues.includes("tool.after.write")
        return ok
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ idValues, eventValues }) }
      }),
  },
  {
    name: "/hooks-tail-log argument completions include --follow and --path",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-tail-log --"
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const values = suggestions?.items.map((i) => i.value) ?? []
        return values.includes("--follow") && values.includes("--path")
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(values) }
      }),
  },
  {
    name: "/hooks-status reports selected Pi paths and trusted project state",
    run: async () =>
      await withSandbox(async (projectDir, homeDir) => {
        writeProjectHooks(projectDir, `hooks:\n  - event: session.idle\n    actions:\n      - notify: hi\n`)
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status "
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const items = suggestions?.items ?? []
        const globalPath = path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml")
        const projectPath = path.join(projectDir, ".pi", "hook", "hooks.yaml")
        const globalItem = items.find((item) => item.value === globalPath)
        const projectItem = items.find((item) => item.value === projectPath)
        const ok =
          globalItem?.description?.includes("Pi global") === true &&
          projectItem?.description?.includes("Pi project") === true &&
          projectItem.description.includes("(trusted)")
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ globalItem, projectItem }) }
      }),
  },
  {
    name: "/hooks-status reports selected OMP native paths and trusted project state",
    run: async () =>
      await withSandbox(async (projectDir, homeDir) => {
        const agentDir = path.join(homeDir, ".omp", "agent", "profiles", "work")
        const profile = configureHookHostProfile({ kind: "omp", agentDir })
        const globalPath = path.join(profile.agentDir, "hook", "hooks.yaml")
        const projectPath = path.join(projectDir, ".omp", "hook", "hooks.yaml")
        writeHooksFile(globalPath, "hooks: []\n")
        writeHooksFile(projectPath, "hooks: []\n")
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status "
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const items = suggestions?.items ?? []
        const globalItem = items.find((item) => item.value === globalPath)
        const projectItem = items.find((item) => item.value === projectPath)
        const ok =
          globalItem?.description?.includes("OMP global") === true &&
          projectItem?.description?.includes("OMP project") === true &&
          projectItem.description.includes("(trusted)")
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ globalItem, projectItem }) }
      }),
  },
  {
    name: "refreshes OMP project fallback suggestions without exposing Pi global config",
    run: async () =>
      await withSandbox(async (projectDir, homeDir) => {
        const agentDir = path.join(homeDir, ".omp", "agent")
        const profile = configureHookHostProfile({ kind: "omp", agentDir })
        const fallbackGlobal = path.join(homeDir, ".pi", "agent", "hook", "hooks.yaml")
        const fallbackProject = path.join(projectDir, ".pi", "hook", "hooks.yaml")
        const nativeGlobal = path.join(profile.agentDir, "hook", "hooks.yaml")
        const nativeProject = path.join(projectDir, ".omp", "hook", "hooks.yaml")
        writeHooksFile(fallbackGlobal, "hooks: []\n")
        writeHooksFile(fallbackProject, "hooks: []\n")
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status "
        const initial = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        writeHooksFile(nativeGlobal, "hooks: []\n")
        writeHooksFile(nativeProject, "hooks: []\n")
        const refreshed = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const initialValues = initial?.items.map((item) => item.value) ?? []
        const refreshedValues = refreshed?.items.map((item) => item.value) ?? []
        const ok =
          ctx.factories.length === 1 &&
          initialValues.includes(nativeGlobal) &&
          initialValues.includes(fallbackProject) &&
          !initialValues.includes(fallbackGlobal) &&
          refreshedValues.includes(nativeGlobal) &&
          refreshedValues.includes(nativeProject) &&
          !refreshedValues.includes(fallbackGlobal) &&
          !refreshedValues.includes(fallbackProject)
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ initialValues, refreshedValues }) }
      }),
  },
  {
    name: "refreshes project trust description lazily without re-registering",
    run: async () =>
      await withSandbox(async (projectDir) => {
        writeProjectHooks(projectDir, "hooks: []\n")
        delete process.env.PI_YAML_HOOKS_TRUST_PROJECT
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const input = "/hooks-status "
        const initial = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        process.env.PI_YAML_HOOKS_TRUST_PROJECT = "1"
        const refreshed = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const projectPath = path.join(projectDir, ".pi", "hook", "hooks.yaml")
        const initialItem = initial?.items.find((item) => item.value === projectPath)
        const refreshedItem = refreshed?.items.find((item) => item.value === projectPath)
        const ok =
          ctx.factories.length === 1 &&
          initialItem?.description?.includes("(untrusted)") === true &&
          refreshedItem?.description?.includes("(trusted)") === true
        return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ initialItem, refreshedItem }) }
      }),
  },
  {
    name: "merges hook suggestions with inner provider suggestions, deduping by value",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const innerItem: AutocompleteItem = { value: "hooks-status", label: "/inner-hooks-status" }
        const provider = ctx.factories[0](createInnerProviderWithItem(innerItem))
        const input = "/hooks-st"
        const suggestions = await provider.getSuggestions([input], 0, input.length, { signal: signal() })
        const items = suggestions?.items ?? []
        const statusItems = items.filter((i) => i.value === "hooks-status")
        // Hook (primary) suggestion should take precedence over inner duplicate.
        return statusItems.length === 1 && statusItems[0].label === "/hooks-status"
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(items) }
      }),
  },
  {
    name: "delegates applyCompletion to the inner provider",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        let applyCalls = 0
        const inner: AutocompleteProvider = {
          async getSuggestions() {
            return null
          },
          applyCompletion(lines, cursorLine, cursorCol) {
            applyCalls += 1
            return { lines: ["delegated"], cursorLine, cursorCol }
          },
        }
        const provider = ctx.factories[0](inner)
        const result = provider.applyCompletion(["x"], 0, 0, { value: "hooks-status", label: "/hooks-status" }, "/hooks-st")
        return applyCalls === 1 && result.lines[0] === "delegated"
          ? { ok: true }
          : { ok: false, detail: JSON.stringify({ applyCalls, result }) }
      }),
  },
  {
    name: "shouldTriggerFileCompletion delegates to inner provider when present",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createInnerProviderWithItem({ value: "x", label: "x" }))
        const triggered = provider.shouldTriggerFileCompletion?.(["foo"], 0, 0) ?? false
        return triggered === true ? { ok: true } : { ok: false, detail: String(triggered) }
      }),
  },
  {
    name: "shouldTriggerFileCompletion returns false when inner provider doesn't implement it",
    run: async () =>
      await withSandbox(async (projectDir) => {
        const ctx = makeContext({ projectDir, hasUI: true, expose: true })
        registerHookAutocomplete(ctx as never)
        const provider = ctx.factories[0](createNoopProvider())
        const triggered = provider.shouldTriggerFileCompletion?.(["foo"], 0, 0) ?? false
        return triggered === false ? { ok: true } : { ok: false, detail: String(triggered) }
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
  /autocomplete\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
