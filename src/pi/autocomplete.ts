import { statSync } from "node:fs"
import path from "node:path"

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { AutocompleteItem, AutocompleteProvider as PiAutocompleteProvider } from "@earendil-works/pi-tui"

import {
  resolveHookConfigPaths,
  resolveHookConfigWatchPaths,
  resolveProjectHookResolution,
} from "../core/config-paths.js"
import { loadDiscoveredHooksSnapshot, type HookLoadSnapshot } from "../core/load-hooks.js"
import { getHookHostProfile } from "../core/host-profile.js"
import { SESSION_HOOK_EVENTS } from "../core/types.js"
import { getPiHooksLogFilePath } from "../core/logger.js"

const HOOK_COMMANDS = [
  {
    value: "hooks-status",
    label: "/hooks-status",
    description: "Show active hook files, trust state, and log path",
  },
  {
    value: "hooks-validate",
    label: "/hooks-validate",
    description: "Validate active and project hook files",
  },
  {
    value: "hooks-trust",
    label: "/hooks-trust",
    description: "Trust the current project hook file",
  },
  {
    value: "hooks-reload",
    label: "/hooks-reload",
    description: "Reload extensions and hook command surfaces",
  },
  {
    value: "hooks-tail-log",
    label: "/hooks-tail-log",
    description: "Show hook log location and tail command",
  },
] as const satisfies readonly AutocompleteItem[]

const TOOL_HOOK_EVENTS = [
  "tool.before.*",
  "tool.after.*",
  "tool.before.bash",
  "tool.after.bash",
  "tool.before.read",
  "tool.after.read",
  "tool.before.edit",
  "tool.after.edit",
  "tool.before.write",
  "tool.after.write",
  "tool.before.grep",
  "tool.after.grep",
  "tool.before.find",
  "tool.after.find",
  "tool.before.ls",
  "tool.after.ls",
] as const

const LOG_OPTION_ITEMS: AutocompleteItem[] = [
  { value: "--follow", label: "--follow", description: "Spawn scripts/tail-hook-log.sh in follow mode" },
  { value: "--path", label: "--path", description: "Print only the hook log file path" },
]

type HookAutocompleteProvider = PiAutocompleteProvider & {
  shouldTriggerFileCompletion?: (lines: string[], cursorLine: number, cursorCol: number) => boolean
}

type AutocompleteProviderFactory = (current: HookAutocompleteProvider) => HookAutocompleteProvider

let autocompleteRegistered = false

export function registerHookAutocomplete(ctx: ExtensionContext): void {
  if (autocompleteRegistered || !ctx.hasUI || !isTuiContext(ctx)) {
    return
  }

  const addAutocompleteProvider = getAddAutocompleteProvider(ctx.ui)
  if (!addAutocompleteProvider) {
    return
  }

  autocompleteRegistered = true
  // Compute suggestion state lazily. A stat-only cache gate keeps synchronous
  // config/import discovery and project/git resolution off unchanged
  // autocomplete keystrokes while still noticing relevant file/env changes.
  addAutocompleteProvider(createHookAutocompleteProviderFactory(ctx.cwd))
}

export function resetHookAutocompleteForTests(): void {
  autocompleteRegistered = false
  cachedAutocompleteState = null
  autocompleteInstrumentation = undefined
}

function isTuiContext(ctx: ExtensionContext): boolean {
  const mode = (ctx as ExtensionContext & { mode?: unknown }).mode
  return mode === undefined || mode === "tui"
}

function getAddAutocompleteProvider(ui: unknown): ((factory: AutocompleteProviderFactory) => void) | undefined {
  if (!ui || typeof ui !== "object" || !("addAutocompleteProvider" in ui)) {
    return undefined
  }
  const candidate = (ui as { addAutocompleteProvider?: unknown }).addAutocompleteProvider
  return typeof candidate === "function" ? (candidate as (factory: AutocompleteProviderFactory) => void) : undefined
}

interface HookAutocompleteState {
  readonly projectDir: string
  readonly commandItems: readonly AutocompleteItem[]
  readonly hookIdItems: readonly AutocompleteItem[]
  readonly eventItems: readonly AutocompleteItem[]
  readonly configPathItems: readonly AutocompleteItem[]
  readonly logItems: readonly AutocompleteItem[]
}

interface CachedState {
  readonly projectDir: string
  readonly profileIdentity: string
  readonly envStateKey: string
  readonly signature: string
  readonly watchedPaths: readonly string[]
  readonly watchFingerprint: string
  readonly state: HookAutocompleteState
}

let cachedAutocompleteState: CachedState | null = null

interface HookAutocompleteInstrumentation {
  readonly onDiscovery?: () => void
  readonly onProjectResolution?: () => void
}

let autocompleteInstrumentation: HookAutocompleteInstrumentation | undefined

export function __setHookAutocompleteInstrumentationForTests(
  instrumentation: HookAutocompleteInstrumentation | undefined,
): void {
  autocompleteInstrumentation = instrumentation
}

function getOrComputeAutocompleteState(cwd: string): HookAutocompleteState {
  const projectDir = path.resolve(cwd)
  const profile = getHookHostProfile()
  const profileIdentity = `${profile.kind}\0${profile.agentDir}`
  const envStateKey = DISCOVERY_ENV_KEYS.map((key) => `${key}=${process.env[key] ?? ""}`).join("\0")
  if (
    cachedAutocompleteState &&
    cachedAutocompleteState.projectDir === projectDir &&
    cachedAutocompleteState.profileIdentity === profileIdentity &&
    cachedAutocompleteState.envStateKey === envStateKey &&
    computeStatFingerprint(cachedAutocompleteState.watchedPaths) === cachedAutocompleteState.watchFingerprint
  ) {
    return cachedAutocompleteState.state
  }

  autocompleteInstrumentation?.onDiscovery?.()
  const snapshot = loadDiscoveredHooksSnapshot({ projectDir, profile })
  const globalPath = resolveHookConfigPaths({ profile }).global
  autocompleteInstrumentation?.onProjectResolution?.()
  const project = resolveProjectHookResolution({ projectDir, profile })
  const hostLabel = profile.kind === "omp" ? "OMP" : "Pi"
  const signature = [
    snapshot.signature,
    profile.kind,
    globalPath ?? "",
    project?.projectConfigPath ?? "",
    project?.trustFilePath ?? "",
    project?.trusted ? "trusted" : "untrusted",
  ].join("\0")

  const hookIds = new Map<string, AutocompleteItem>()

  for (const hooks of snapshot.hooks.values()) {
    for (const hook of hooks) {
      if (hook.id && !hookIds.has(hook.id)) {
        hookIds.set(hook.id, {
          value: hook.id,
          label: hook.id,
          description: `${hook.event} hook id from ${path.basename(hook.source.filePath)}`,
        })
      }
    }
  }

  const configPathItems: AutocompleteItem[] = []
  if (globalPath) {
    configPathItems.push({
      value: globalPath,
      label: globalPath,
      description: `${hostLabel} global pi-yaml-hooks config path`,
    })
  }
  if (project?.projectConfigPath) {
    configPathItems.push({
      value: project.projectConfigPath,
      label: project.projectConfigPath,
      description: `${hostLabel} project pi-yaml-hooks config path (${project.trusted ? "trusted" : "untrusted"})`,
    })
  }

  const logFilePath = getPiHooksLogFilePath()

  const state: HookAutocompleteState = {
    projectDir,
    commandItems: HOOK_COMMANDS,
    hookIdItems: Array.from(hookIds.values()).sort(compareAutocompleteItems),
    eventItems: [...SESSION_HOOK_EVENTS, ...TOOL_HOOK_EVENTS].map((event) => ({
      value: event,
      label: event,
      description: "pi-yaml-hooks event name",
    })),
    configPathItems,
    logItems: [
      { value: logFilePath, label: logFilePath, description: "pi-yaml-hooks log file path" },
      { value: `tail -F ${JSON.stringify(logFilePath)}`, label: "tail -F hook log", description: "Ready-to-run log tail command" },
      ...LOG_OPTION_ITEMS,
    ],
  }

  const watchedPaths = mergeUniquePaths(
    resolveHookConfigWatchPaths({ projectDir, profile }).paths,
    snapshot.files,
    getSnapshotWatchPaths(snapshot),
  )
  cachedAutocompleteState = {
    projectDir,
    profileIdentity,
    envStateKey,
    signature,
    watchedPaths,
    watchFingerprint: computeStatFingerprint(watchedPaths),
    state,
  }
  return state
}

const DISCOVERY_ENV_KEYS = [
  "PI_YAML_HOOKS_TRUST_PROJECT",
  "PI_YAML_HOOKS_ALLOW_PROJECT_IMPORTS_OUTSIDE_TRUST_ANCHOR",
  "PI_YAML_HOOKS_ALLOW_GLOBAL_IMPORTS",
  "PI_YAML_HOOKS_ALLOW_PACKAGE_IMPORTS",
] as const


function getSnapshotWatchPaths(snapshot: HookLoadSnapshot): readonly string[] {
  if (!("watchPaths" in snapshot)) {
    return []
  }
  const { watchPaths } = snapshot
  return Array.isArray(watchPaths) && watchPaths.every((filePath) => typeof filePath === "string")
    ? watchPaths
    : []
}

function mergeUniquePaths(...pathSets: readonly (readonly string[])[]): string[] {
  const paths = new Set<string>()
  for (const pathSet of pathSets) {
    for (const filePath of pathSet) {
      paths.add(filePath)
    }
  }
  return Array.from(paths)
}

// Cheap stat-only refresh gate. Nanosecond mtime/ctime detect rapid same-size
// rewrites; inode and mode also detect atomic replacement and metadata changes.
function computeStatFingerprint(paths: readonly string[]): string {
  const parts: string[] = []
  for (const filePath of paths) {
    try {
      const stat = statSync(filePath, { bigint: true })
      parts.push(`${filePath}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.size}|${stat.ino}|${stat.mode}`)
    } catch {
      parts.push(`${filePath}|missing`)
    }
  }
  return parts.join("\n")
}

function createHookAutocompleteProviderFactory(cwd: string): AutocompleteProviderFactory {
  return (current: HookAutocompleteProvider): HookAutocompleteProvider => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options)
      const line = lines[cursorLine] ?? ""
      if (!line.slice(0, cursorCol).startsWith("/hooks")) {
        return currentSuggestions
      }
      // P1-11: recompute (or reuse cached) state for each hook-completion
      // request so freshly edited hooks.yaml files appear without a restart.
      const state = getOrComputeAutocompleteState(cwd)
      const hookSuggestions = getHookSuggestions(state, lines, cursorLine, cursorCol)
      if (!hookSuggestions) {
        return currentSuggestions
      }
      if (!currentSuggestions) {
        return hookSuggestions
      }
      return {
        prefix: hookSuggestions.prefix || currentSuggestions.prefix,
        items: mergeAutocompleteItems(hookSuggestions.items, currentSuggestions.items),
      }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false
    },
  })
}

function getHookSuggestions(
  state: HookAutocompleteState,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): { items: AutocompleteItem[]; prefix: string } | null {
  const line = lines[cursorLine] ?? ""
  const beforeCursor = line.slice(0, cursorCol)
  const tokenPrefix = beforeCursor.match(/\S*$/)?.[0] ?? ""

  if (!beforeCursor.startsWith("/hooks")) {
    return null
  }

  const commandMatch = beforeCursor.match(/^(\/hooks-[\w-]+)(?:\s+(.*))?$/)
  if (!commandMatch || commandMatch[2] === undefined) {
    // P3-5: command names use prefix matching so typing "/hooks-st" no longer
    // surfaces "/hooks-tail-log" via the substring "st" appearing inside
    // unrelated labels. Argument completions still use substring (see below).
    return filterCommandItems(state.commandItems, tokenPrefix)
  }

  const command = commandMatch[1]
  const argumentPrefix = commandMatch[2].match(/\S*$/)?.[0] ?? ""
  const argumentItems = getArgumentItems(state, command)
  return filterArgumentItems(argumentItems, argumentPrefix)
}

function getArgumentItems(state: HookAutocompleteState, command: string): readonly AutocompleteItem[] {
  switch (command) {
    case "/hooks-status":
      return [...state.hookIdItems, ...state.eventItems, ...state.configPathItems, ...state.logItems]
    case "/hooks-validate":
      return [...state.hookIdItems, ...state.eventItems, ...state.configPathItems]
    case "/hooks-trust":
      return state.configPathItems
    case "/hooks-tail-log":
      return state.logItems
    case "/hooks-reload":
      return state.commandItems
    default:
      return []
  }
}

// P3-5: prefix match for command items so "/hooks-st" only suggests
// "/hooks-status", not commands whose label happens to contain "st"
// somewhere in the middle. Match against both `value` (e.g. "hooks-status")
// and `label` (e.g. "/hooks-status") so a leading slash typed by the user is
// tolerated.
function filterCommandItems(
  items: readonly AutocompleteItem[],
  prefix: string,
): { items: AutocompleteItem[]; prefix: string } {
  const normalizedPrefix = prefix.toLowerCase()
  const slashStripped = normalizedPrefix.startsWith("/") ? normalizedPrefix.slice(1) : normalizedPrefix
  return {
    prefix,
    items: items
      .filter((item) => {
        const valueLc = item.value.toLowerCase()
        const labelLc = item.label.toLowerCase()
        return (
          valueLc.startsWith(slashStripped) ||
          labelLc.startsWith(normalizedPrefix) ||
          // Tolerate users typing the value form ("hooks-st") even when the
          // label is the slash form ("/hooks-status").
          labelLc.startsWith(`/${slashStripped}`)
        )
      })
      .sort(compareAutocompleteItems),
  }
}

// Free-form arguments (hook ids, paths, event names) keep substring matching
// because users frequently search by a fragment like "after.write" or a
// path basename rather than a leading prefix.
function filterArgumentItems(
  items: readonly AutocompleteItem[],
  prefix: string,
): { items: AutocompleteItem[]; prefix: string } {
  const normalizedPrefix = prefix.toLowerCase()
  return {
    prefix,
    items: items
      .filter((item) => item.value.toLowerCase().includes(normalizedPrefix) || item.label.toLowerCase().includes(normalizedPrefix))
      .sort(compareAutocompleteItems),
  }
}

function mergeAutocompleteItems(primary: readonly AutocompleteItem[], secondary: readonly AutocompleteItem[]): AutocompleteItem[] {
  const seen = new Set<string>()
  const merged: AutocompleteItem[] = []
  for (const item of [...primary, ...secondary]) {
    const key = item.value
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(item)
    }
  }
  return merged
}

function compareAutocompleteItems(a: AutocompleteItem, b: AutocompleteItem): number {
  return a.label.localeCompare(b.label)
}
