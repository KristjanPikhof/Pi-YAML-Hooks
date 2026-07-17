import type {
  BeforeAgentStartEvent as PiBeforeAgentStartEvent,
  BeforeAgentStartEventResult as PiBeforeAgentStartEventResult,
  ExtensionAPI as PiExtensionAPI,
  ExtensionContext as PiExtensionContext,
} from "@earendil-works/pi-coding-agent"
import type {
  BeforeAgentStartEvent as OmpBeforeAgentStartEvent,
  BeforeAgentStartEventResult as OmpBeforeAgentStartEventResult,
  ExtensionAPI as OmpExtensionAPI,
  ExtensionContext as OmpExtensionContext,
} from "@oh-my-pi/pi-coding-agent"

import { resolveHookConfigPaths, resolveProjectHookResolution } from "../core/config-paths.js"
import { loadDiscoveredHooksSnapshot, summarizeHookSources } from "../core/load-hooks.js"
import { getHookHostProfile } from "../core/host-profile.js"

const PROMPT_AWARENESS_DISABLE_ENV = "PI_YAML_HOOKS_PROMPT_AWARENESS"

export function registerPromptSupport(api: PiExtensionAPI | OmpExtensionAPI): void {
  const profile = getHookHostProfile()
  if (profile.kind === "omp") {
    const omp = api as OmpExtensionAPI
    omp.on("before_agent_start", handleOmpBeforeAgentStart)
    return
  }

  const pi = api as PiExtensionAPI
  pi.on("before_agent_start", handlePiBeforeAgentStart)
}

function handlePiBeforeAgentStart(
  event: PiBeforeAgentStartEvent,
  ctx: PiExtensionContext,
): PiBeforeAgentStartEventResult | undefined {
  const systemPrompt = buildHookAwarenessSystemPrompt(ctx)
  if (!systemPrompt) {
    return undefined
  }

  return {
    systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${systemPrompt}`,
  }
}

function handleOmpBeforeAgentStart(
  event: OmpBeforeAgentStartEvent,
  ctx: OmpExtensionContext,
): OmpBeforeAgentStartEventResult | undefined {
  const systemPrompt = buildHookAwarenessSystemPrompt(ctx)
  if (!systemPrompt) {
    return undefined
  }

  return {
    systemPrompt: [...event.systemPrompt, systemPrompt],
  }
}

// P3-3: accept a small set of common "off" spellings so users do not have to
// remember a single canonical form. We treat env var presence the same way
// other PI knobs do: trim + lowercase compare against an allow-list.
const PROMPT_AWARENESS_DISABLE_VALUES = new Set(["0", "false", "off", "no"])

function isPromptAwarenessDisabled(): boolean {
  const raw = process.env[PROMPT_AWARENESS_DISABLE_ENV]
  if (raw === undefined) return false
  return PROMPT_AWARENESS_DISABLE_VALUES.has(raw.trim().toLowerCase())
}

function buildHookAwarenessSystemPrompt(
  ctx: Pick<PiExtensionContext | OmpExtensionContext, "cwd" | "hasUI">,
): string | undefined {
  if (isPromptAwarenessDisabled()) {
    return undefined
  }

  const loaded = loadDiscoveredHooksSnapshot({ projectDir: ctx.cwd })
  const summary = summarizeHookSources(loaded.sources)
  const profile = getHookHostProfile()
  const globalPath = resolveHookConfigPaths({ profile }).global
  const project = resolveProjectHookResolution({ projectDir: ctx.cwd, profile })
  const hostLabel = profile.kind === "omp" ? "OMP" : "Pi"
  const trustLine = project?.projectConfigPath
    ? project.trusted
      ? `- project hooks are trusted and active when loaded: ${project.projectConfigPath}`
      : `- project hooks exist but are currently untrusted: ${project.projectConfigPath}`
    : "- no project hook file is present for this repo/worktree scope"

  const lines = [
    "Hook-awareness for this session:",
    `- active hook host: ${hostLabel}`,
    `- selected global hook config: ${globalPath ?? "none"}`,
    trustLine,
    `- project trust list: ${project?.trustFilePath ?? "unavailable"}`,
  ]

  if (loaded.errors.length > 0) {
    lines.push(`- current hook files have ${loaded.errors.length} validation issue(s); the runtime may be using the valid subset or a last known good hook set`)
    lines.push("- use /hooks-validate for the exact validation errors and active trust state")
  } else {
    lines.push(`- pi-yaml-hooks loaded ${summary.total} hooks (${summary.global} global, ${summary.project} project)`)
  }

  lines.push("- command actions are unsupported on PI; prefer bash-backed hooks or user-invoked /hooks commands")
  // P2-16: be explicit about the targeting boundary. The previous wording
  // ("tool prompts still target the current session") was easy to misread
  // as "tool actions can target sessions" with the current one as a default.
  // tool: actions on PI inject a follow-up prompt into the same PI session
  // the hook fired in — they cannot route a prompt to any other session.
  lines.push(
    "- tool actions inject a follow-up prompt into the current PI session only; they cannot target other sessions",
  )

  if (!ctx.hasUI) {
    lines.push("- UI is unavailable in this mode: notify/setStatus degrade and confirm denies by default")
  }

  return lines.join("\n")
}
