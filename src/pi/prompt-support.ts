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
import {
  loadDiscoveredHooksSnapshot,
  summarizeHookSources,
  type HookLoadSnapshot,
} from "../core/load-hooks.js"
import { getHookHostProfile } from "../core/host-profile.js"
import { getPiHooksLogger } from "../core/logger.js"
import { safeGetSessionId } from "./host-adapter.js"
import type { RuntimeRegistry } from "./runtime-registry.js"

const PROMPT_AWARENESS_DISABLE_ENV = "PI_YAML_HOOKS_PROMPT_AWARENESS"
const PROMPT_CONTEXT_PREFIX = "Context from pi-yaml-hooks user.prompt.submit:"

export function registerPromptSupport(
  api: PiExtensionAPI | OmpExtensionAPI,
  runtimeRegistry?: RuntimeRegistry,
): void {
  const profile = getHookHostProfile()
  if (profile.kind === "omp") {
    const omp = api as OmpExtensionAPI
    omp.on("before_agent_start", (event, ctx) => handleOmpBeforeAgentStart(event, ctx, runtimeRegistry))
    return
  }

  const pi = api as PiExtensionAPI
  pi.on("before_agent_start", (event, ctx) => handlePiBeforeAgentStart(event, ctx, runtimeRegistry))
}

async function handlePiBeforeAgentStart(
  event: PiBeforeAgentStartEvent,
  ctx: PiExtensionContext,
  runtimeRegistry: RuntimeRegistry | undefined,
): Promise<PiBeforeAgentStartEventResult | undefined> {
  const blocks = await buildPromptBlocks(event.prompt, ctx, runtimeRegistry)
  if (blocks === undefined || blocks.length === 0) return undefined

  // Pi >= 0.86 exposes mutable `systemPromptOptions`. Appending there lets the
  // host rebuild the prompt from its own sections, which keeps the prompt cache
  // warm; returning `systemPrompt` would instead replace the whole prompt.
  if (appendBlocksToSystemPromptOptions(event, blocks)) {
    return undefined
  }

  // Older SDKs have no options object, so fall back to string concatenation.
  return {
    systemPrompt: [event.systemPrompt.trimEnd(), ...blocks].join("\n\n"),
  }
}

async function handleOmpBeforeAgentStart(
  event: OmpBeforeAgentStartEvent,
  ctx: OmpExtensionContext,
  runtimeRegistry: RuntimeRegistry | undefined,
): Promise<OmpBeforeAgentStartEventResult | undefined> {
  const blocks = await buildPromptBlocks(event.prompt, ctx, runtimeRegistry)
  if (blocks === undefined || blocks.length === 0) return undefined

  return {
    systemPrompt: [...event.systemPrompt, ...blocks],
  }
}

async function buildPromptBlocks(
  prompt: string,
  ctx: PiExtensionContext | OmpExtensionContext,
  runtimeRegistry: RuntimeRegistry | undefined,
): Promise<readonly string[] | undefined> {
  let sessionID: string | undefined
  try {
    const loaded = runtimeRegistry?.getHookLoadFor(ctx.cwd)
    const awareness = buildHookAwarenessSystemPrompt(ctx, loaded)
    if (!runtimeRegistry || process.platform === "win32") {
      return awareness ? [awareness] : []
    }

    runtimeRegistry.rememberContext(ctx.cwd, ctx as PiExtensionContext)
    sessionID = safeGetSessionId(ctx.sessionManager as PiExtensionContext["sessionManager"])
    if (!sessionID) {
      reportPromptDispatchFailure(ctx.cwd, undefined, "missing_session")
      return undefined
    }

    const result = await runtimeRegistry.getRuntimeFor(ctx.cwd)["user.prompt.submit"]({
      sessionID,
      prompt,
    })
    const contextBlocks = result.additionalContext.map(
      (text) => `${PROMPT_CONTEXT_PREFIX}\n${text}`,
    )
    return awareness ? [awareness, ...contextBlocks] : contextBlocks
  } catch (error) {
    reportPromptDispatchFailure(
      ctx.cwd,
      sessionID,
      error instanceof Error ? error.name : typeof error,
    )
    return undefined
  }
}

function reportPromptDispatchFailure(
  cwd: string,
  sessionID: string | undefined,
  failureType: string,
): void {
  getPiHooksLogger().error("prompt_dispatch", "Prompt submission hook dispatch failed; continuing the agent turn.", {
    cwd,
    event: "user.prompt.submit",
    ...(sessionID === undefined ? {} : { sessionId: sessionID }),
    details: { failureType },
  })
  // eslint-disable-next-line no-console
  console.error("[pi-yaml-hooks] Prompt submission hooks failed; continuing without injected context.")
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
  preparedLoad?: HookLoadSnapshot,
): string | undefined {
  if (isPromptAwarenessDisabled()) {
    return undefined
  }

  const loaded = preparedLoad ?? loadDiscoveredHooksSnapshot({ projectDir: ctx.cwd })
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

  lines.push(`- command actions are unsupported on ${hostLabel}; prefer bash-backed hooks or user-invoked /hooks commands`)
  // P2-16: be explicit about the targeting boundary. A tool action injects a
  // follow-up prompt into the same host session in which the hook fired; it
  // cannot route a prompt to another session.
  lines.push(
    `- tool actions inject a follow-up prompt into the current ${hostLabel} session only; they cannot target other sessions`,
  )

  if (!ctx.hasUI) {
    lines.push("- UI is unavailable in this mode: notify/setStatus degrade and confirm denies by default")
  }

  return lines.join("\n")
}

/** Section tag used when appending hook context through Pi >= 0.86 prompt options. */
const PI_YAML_HOOKS_SECTION_TAG = "pi-yaml-hooks"

/**
 * Pi >= 0.86 hands handlers a mutable `systemPromptOptions` with collection
 * fields, and its `BeforeAgentStartEventResult.systemPrompt` replaces the whole
 * prompt. Appending a section is the additive path; the section tag keeps our
 * block separate from other extensions' contributions.
 *
 * Returns false when the event carries no options object (Pi < 0.86), so the
 * caller can fall back to the legacy concatenation.
 */
function appendBlocksToSystemPromptOptions(
  event: PiBeforeAgentStartEvent | OmpBeforeAgentStartEvent,
  blocks: readonly string[],
): boolean {
  const carrier = event as { systemPromptOptions?: { sections?: Record<string, string> } }
  const options = carrier.systemPromptOptions
  if (!options || typeof options !== "object") {
    return false
  }

  if (!options.sections || typeof options.sections !== "object") {
    options.sections = {}
  }
  const existing = options.sections[PI_YAML_HOOKS_SECTION_TAG]
  const addition = blocks.join("\n\n")
  options.sections[PI_YAML_HOOKS_SECTION_TAG] =
    typeof existing === "string" && existing.length > 0 ? `${existing}\n\n${addition}` : addition
  return true
}
