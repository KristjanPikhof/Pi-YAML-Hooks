import type {
  HookAction,
  HookConfig,
  HookEvent,
  HookMap,
  HookPolicy,
  HookPolicyDiagnostics,
} from "../core/types.js"
import { setActiveHookPolicy } from "../core/load-hooks.js"

/**
 * Host compatibility diagnostics for hook configurations loaded from
 * OpenCode-compatible hooks.yaml files. Some YAML features are unsupported by
 * the PI-compatible extension API (or behave differently), while tool-name
 * availability depends on the selected host.
 */

export type UnsupportedDiagnostics = HookPolicyDiagnostics

export type UnsupportedDiagnosticsHost = "pi" | "omp"

const COMMAND_ACTION_ERROR =
  "command: actions are not supported on PI. PI exposes no API to invoke slash commands from event handlers. Remove this action or use bash instead."

const TOOL_ACTION_ADVISORY =
  "tool: actions run as current-session prompts via pi.sendUserMessage. Cross-session targeting is not supported."

const RUN_IN_MAIN_NON_BASH_ERROR =
  "runIn: main is only supported for bash actions on PI. Remove runIn or switch to bash."

const SCOPE_CHILD_ADVISORY =
  "scope: child filters via session ancestry (parentSession). Fires only in child sessions."

const PI_TOOL_NAME_NEVER_MATCH_ADVISORY =
  "PI built-ins are bash, powershell, read, edit, write, grep, find, ls. This tool name will never match unless you install a matching custom tool."

const OMP_TOOL_NAME_NEVER_MATCH_ADVISORY =
  "OMP built-ins include read, bash, edit, ast_grep, ast_edit, ask, debug, eval, github, glob, grep, find, lsp, checkpoint, rewind, context_notes, new_context, security_scan, task, hub, todo, web_search, write, memory_edit, retain, recall, reflect, learn, manage_skill, yield, goal, and think. This tool name will never match unless you install a matching custom tool."

interface ToolNameDiagnosticsPolicy {
  readonly builtinTools: Readonly<Record<string, true>>
  readonly neverMatchAdvisory: string
}

const PI_TOOL_NAME_POLICY: ToolNameDiagnosticsPolicy = {
  builtinTools: {
    bash: true,
    powershell: true,
    read: true,
    edit: true,
    write: true,
    grep: true,
    find: true,
    ls: true,
  },
  neverMatchAdvisory: PI_TOOL_NAME_NEVER_MATCH_ADVISORY,
}

// OMP 18.2.8 canonical built-ins (dist/types/tools/builtin-names.d.ts), including
// its hidden but tool-addressable yield, goal, and think tools. OMP 18 dropped
// inspect_image and browser from the canonical list and added context_notes,
// new_context, and security_scan; 18.2.7 added find. Keep this separate from PI's conservative
// allow-list: adding OMP names to PI would suppress useful warnings for hooks
// that can never fire there.
//
// inspect_image (replaced by `read <image>?q=`), browser, and computer are no
// longer canonical built-ins in 18.2.6 (browser/computer are eval-side tools, so
// they do not surface as top-level tool_call events). Hooks targeting them keep
// the never-match advisory, which is the honest signal.
const OMP_TOOL_NAME_POLICY: ToolNameDiagnosticsPolicy = {
  builtinTools: {
    read: true,
    bash: true,
    edit: true,
    ast_grep: true,
    ast_edit: true,
    ask: true,
    debug: true,
    eval: true,
    github: true,
    glob: true,
    grep: true,
    find: true,
    lsp: true,
    checkpoint: true,
    rewind: true,
    context_notes: true,
    new_context: true,
    security_scan: true,
    task: true,
    hub: true,
    todo: true,
    web_search: true,
    write: true,
    memory_edit: true,
    retain: true,
    recall: true,
    reflect: true,
    learn: true,
    manage_skill: true,
    yield: true,
    goal: true,
    think: true,
  },
  neverMatchAdvisory: OMP_TOOL_NAME_NEVER_MATCH_ADVISORY,
}

function prefixWithSource(hook: HookConfig, message: string): string {
  const src = hook.source
  return `[${src.filePath}#hooks[${src.index}]] ${message}`
}

function isCommandAction(action: HookAction): boolean {
  return typeof action === "object" && action !== null && "command" in action
}

function isToolAction(action: HookAction): boolean {
  return typeof action === "object" && action !== null && "tool" in action
}

function isBashAction(action: HookAction): boolean {
  return typeof action === "object" && action !== null && "bash" in action
}

/**
 * command: actions → hard error. PI has no slash-command API.
 */
export function diagnoseCommandActions(hook: HookConfig): string[] {
  const errors: string[] = []
  for (const action of hook.actions) {
    if (isCommandAction(action)) {
      errors.push(prefixWithSource(hook, COMMAND_ACTION_ERROR))
    }
  }
  return errors
}

/**
 * tool: actions → advisory. They work but are scoped to the current session.
 */
export function diagnoseToolActions(hook: HookConfig): string[] {
  const advisories: string[] = []
  for (const action of hook.actions) {
    if (isToolAction(action)) {
      advisories.push(prefixWithSource(hook, TOOL_ACTION_ADVISORY))
    }
  }
  return advisories
}

/**
 * runIn: main on any non-bash action → hard error.
 * Only bash actions can currently be routed to the main session on PI.
 */
export function diagnoseRunInMainNonBash(hook: HookConfig): string[] {
  if (hook.runIn !== "main") {
    return []
  }
  const errors: string[] = []
  for (const action of hook.actions) {
    if (!isBashAction(action)) {
      errors.push(prefixWithSource(hook, RUN_IN_MAIN_NON_BASH_ERROR))
    }
  }
  return errors
}

/**
 * scope: child → advisory. Only fires in child sessions via parentSession check.
 */
export function diagnoseScopeChild(hook: HookConfig): string[] {
  if (hook.scope === "child") {
    return [prefixWithSource(hook, SCOPE_CHILD_ADVISORY)]
  }
  return []
}

/**
 * tool.before.<name> / tool.after.<name> where <name> is outside the active
 * host's built-in allow-list (and not the "*" wildcard) → advisory. Custom
 * tools remain possible, so this is deliberately advisory rather than an error.
 *
 * The host is explicit instead of treating OMP's larger tool set as valid on
 * PI, where those names would never match without a custom tool.
 */
export function diagnoseUnsupportedToolNameEvents(
  hook: HookConfig,
  host: UnsupportedDiagnosticsHost = "pi",
): string[] {
  const event: HookEvent = hook.event
  if (typeof event !== "string") {
    return []
  }
  const match = /^tool\.(before|after)\.(.+)$/.exec(event)
  if (!match) {
    return []
  }
  const toolName = match[2]
  if (toolName === "*") {
    return []
  }
  const policy = host === "omp" ? OMP_TOOL_NAME_POLICY : PI_TOOL_NAME_POLICY
  if (policy.builtinTools[toolName] === true) {
    return []
  }
  return [prefixWithSource(hook, policy.neverMatchAdvisory)]
}

/**
 * Collect compatibility diagnostics across every hook in the given map.
 * Errors are intended to be appended to ParsedHooksFile.errors (load-blocking).
 * Advisories are intended to be surfaced via console.info and/or a new
 * `advisories` field on ParsedHooksFile (load succeeds).
 *
 * Importing this module installs PI's policy for the default entry point. OMP's
 * entry point explicitly selects ompHookPolicy after successful host
 * registration, keeping OMP-only tool names out of PI's allow-list.
 */
export function createUnsupportedHookPolicy(host: UnsupportedDiagnosticsHost): HookPolicy {
  return {
    diagnose: (hookMap: HookMap): HookPolicyDiagnostics => collectUnsupportedDiagnostics(hookMap, host),
  }
}

export const piHookPolicy: HookPolicy = createUnsupportedHookPolicy("pi")
export const ompHookPolicy: HookPolicy = createUnsupportedHookPolicy("omp")

setActiveHookPolicy(piHookPolicy)

export function collectUnsupportedDiagnostics(
  hookMap: HookMap,
  host: UnsupportedDiagnosticsHost = "pi",
): UnsupportedDiagnostics {
  const errors: string[] = []
  const advisories: string[] = []
  const invalidHooks = new Set<HookConfig>()

  for (const hooks of hookMap.values()) {
    for (const hook of hooks) {
      const hookErrors: string[] = []
      hookErrors.push(...diagnoseCommandActions(hook))
      hookErrors.push(...diagnoseRunInMainNonBash(hook))
      if (hookErrors.length > 0) {
        invalidHooks.add(hook)
        errors.push(...hookErrors)
      }

      advisories.push(...diagnoseToolActions(hook))
      advisories.push(...diagnoseScopeChild(hook))
      advisories.push(...diagnoseUnsupportedToolNameEvents(hook, host))
    }
  }

  return { errors, advisories, invalidHooks }
}
