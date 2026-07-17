import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type HookHostKind = "pi" | "omp"

export interface HookHostProfile {
  readonly kind: HookHostKind
  readonly agentDir: string
}

export interface HookHostProfileConfiguration {
  readonly kind: HookHostKind
  readonly agentDir?: string
}

let configuredProfile: HookHostProfile | undefined

/**
 * Configure the process-wide host profile. The first explicit configuration
 * wins; subsequent identical configuration is harmless, while a conflicting
 * host or agent directory is rejected.
 */
export function configureHookHostProfile(configuration: HookHostProfileConfiguration): HookHostProfile {
  const candidate = createHookHostProfile(configuration)
  if (!configuredProfile) {
    configuredProfile = candidate
    return configuredProfile
  }

  if (configuredProfile.kind !== candidate.kind || configuredProfile.agentDir !== candidate.agentDir) {
    throw new Error(
      `Hook host profile is already configured for ${configuredProfile.kind} at ${configuredProfile.agentDir}; ` +
        `cannot reconfigure for ${candidate.kind} at ${candidate.agentDir}.`,
    )
  }

  return configuredProfile
}

/**
 * Return the active profile. Until explicitly configured, each read derives a
 * frozen Pi default without committing process state, so a later OMP
 * registration can still configure its active agent directory.
 */
export function getHookHostProfile(): HookHostProfile {
  return configuredProfile ?? createHookHostProfile({ kind: "pi" })
}

/** Return the explicitly configured profile, if registration has occurred. */
export function getConfiguredHookHostProfile(): HookHostProfile | undefined {
  return configuredProfile
}

/** Build a normalized frozen profile for deterministic dependency injection. */
export function createHookHostProfile(configuration: HookHostProfileConfiguration): HookHostProfile {
  if (configuration.kind !== "pi" && configuration.kind !== "omp") {
    throw new Error(`Unsupported hook host kind: ${String(configuration.kind)}`)
  }

  const configuredAgentDir = configuration.agentDir
  if (configuredAgentDir !== undefined && configuredAgentDir.trim().length === 0) {
    throw new Error("Hook host agentDir must not be empty.")
  }
  if (configuration.kind === "omp" && configuredAgentDir === undefined) {
    throw new Error("OMP hook host configuration requires an active agentDir.")
  }

  const agentDir =
    configuredAgentDir !== undefined
      ? canonicalizeAgentDir(configuredAgentDir)
      : path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".pi", "agent")
  return Object.freeze({ kind: configuration.kind, agentDir })
}

export function __resetHookHostProfileForTests(): void {
  configuredProfile = undefined
}

function canonicalizeAgentDir(agentDir: string): string {
  const resolved = path.resolve(agentDir)
  const missingSegments: string[] = []
  let candidate = resolved

  while (true) {
    try {
      return path.resolve(realpathSync.native(candidate), ...missingSegments)
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return resolved
      missingSegments.unshift(path.basename(candidate))
      candidate = parent
    }
  }
}
