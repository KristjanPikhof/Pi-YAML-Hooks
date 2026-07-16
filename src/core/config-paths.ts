import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { getPiHooksLogger } from "./logger.js"
import {
  createHookHostProfile,
  getConfiguredHookHostProfile,
  type HookHostProfile,
} from "./host-profile.js"

export interface HookConfigDiscoveryOptions {
  readonly projectDir?: string
  readonly platform?: string
  readonly homeDir?: string
  readonly appDataDir?: string
  readonly profile?: HookHostProfile
  readonly exists?: (filePath: string) => boolean
  readonly readFile?: (filePath: string) => string
  readonly realpath?: (filePath: string) => string
  readonly resolveGitWorktreeRoot?: (cwd: string) => string | undefined
}

export interface HookConfigPaths {
  readonly global?: string
  readonly project?: string
}

export type HookConfigSourceScope = "global" | "project"

export interface DiscoveredHookConfigPath {
  readonly scope: HookConfigSourceScope
  readonly filePath: string
}

export interface ProjectHookResolution {
  readonly cwd: string
  readonly anchorDir: string
  readonly canonicalCwd: string
  readonly canonicalAnchorDir: string
  readonly worktreeRoot?: string
  readonly discoveredProjectRoot?: string
  readonly trustFilePath: string
  readonly projectConfigPath?: string
  readonly trusted: boolean
}

/**
 * Resolve the primary global and project config paths for the active host.
 * Pi keeps its existing `.pi` locations. OMP checks its active agent
 * directory and native `.omp` project locations before legacy Pi fallbacks.
 */
export function resolveHookConfigPaths(options: HookConfigDiscoveryOptions = {}): HookConfigPaths {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? resolveHomeDir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const profile = resolveDiscoveryProfile(options, homeDir)
  const project = resolveProjectHookResolution(options)

  return {
    global: resolveGlobalConfigPath(exists, platform, homeDir, appDataDir, profile),
    project: project?.projectConfigPath,
  }
}

/**
 * Discover at most one global and one project config file. Global comes
 * before project so the project file can override the global one.
 *
 * Project hook files are gated by the active host's trust list. A legacy
 * `.pi` fallback discovered while OMP is active still requires OMP trust.
 */
export function discoverHookConfigEntries(options: HookConfigDiscoveryOptions = {}): DiscoveredHookConfigPath[] {
  const exists = options.exists ?? existsSync
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? resolveHomeDir()
  const appDataDir = options.appDataDir ?? process.env.APPDATA
  const profile = resolveDiscoveryProfile(options, homeDir)
  const project = resolveProjectHookResolution(options)

  const entries: DiscoveredHookConfigPath[] = []
  const globalPath = pickFirstExisting(globalCandidatePaths(platform, homeDir, appDataDir, profile), exists)
  if (globalPath) {
    entries.push({ scope: "global", filePath: globalPath })
  }

  if (project?.projectConfigPath) {
    if (project.trusted) {
      entries.push({ scope: "project", filePath: project.projectConfigPath })
    } else {
      warnUntrustedProjectOnce(project.anchorDir, project.projectConfigPath, project.trustFilePath)
    }
  }

  return entries
}

export function discoverHookConfigPaths(options: HookConfigDiscoveryOptions = {}): string[] {
  return discoverHookConfigEntries(options).map((entry) => entry.filePath)
}

const MAX_WARNED_UNTRUSTED_PROJECTS = 128
const warnedUntrustedProjects = new Map<string, true>()
const warnedTrustBypasses = new Set<string>()

function rememberWarnedUntrustedProject(projectDir: string): boolean {
  if (warnedUntrustedProjects.has(projectDir)) {
    warnedUntrustedProjects.delete(projectDir)
    warnedUntrustedProjects.set(projectDir, true)
    return false
  }
  warnedUntrustedProjects.set(projectDir, true)
  while (warnedUntrustedProjects.size > MAX_WARNED_UNTRUSTED_PROJECTS) {
    const oldest = warnedUntrustedProjects.keys().next().value
    if (oldest === undefined) break
    warnedUntrustedProjects.delete(oldest)
  }
  return true
}

function warnUntrustedProjectOnce(projectDir: string, candidate: string, trustFilePath: string): void {
  if (!rememberWarnedUntrustedProject(projectDir)) return
  const message =
    `[pi-yaml-hooks] Skipping untrusted project hooks at ${candidate}.\n` +
    `         To trust this project, either:\n` +
    `           - set PI_YAML_HOOKS_TRUST_PROJECT=1 for this session, or\n` +
    `           - add ${JSON.stringify(projectDir)} to ${trustFilePath}`
  // eslint-disable-next-line no-console
  console.warn(message)
  getPiHooksLogger().warn("project_untrusted", "Skipping untrusted project hooks.", {
    cwd: projectDir,
    details: { projectDir, candidate, trustFilePath },
  })
}

function warnTrustBypassOnce(projectDir: string): void {
  const key = `PI_YAML_HOOKS_TRUST_PROJECT:${projectDir}`
  if (warnedTrustBypasses.has(key)) return
  warnedTrustBypasses.add(key)
  const message =
    `[pi-yaml-hooks] PI_YAML_HOOKS_TRUST_PROJECT=1 is temporarily bypassing project hook trust for ${projectDir}. ` +
    `Trusted project hooks can execute bash and inspect hook context for this session.`
  // eslint-disable-next-line no-console
  console.warn(message)
  getPiHooksLogger().warn("project_trust_bypass", "Project hook trust bypass enabled by environment.", {
    cwd: projectDir,
    details: { projectDir, env: "PI_YAML_HOOKS_TRUST_PROJECT" },
  })
}

export function resolveProjectHookResolution(options: HookConfigDiscoveryOptions = {}): ProjectHookResolution | undefined {
  const projectDir = options.projectDir
  if (!projectDir) {
    return undefined
  }

  const exists = options.exists ?? existsSync
  const homeDir = options.homeDir ?? resolveHomeDir()
  const profile = resolveDiscoveryProfile(options, homeDir)
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, "utf8"))
  const realpath = options.realpath ?? defaultRealpath
  const cwd = path.resolve(projectDir)
  const canonicalCwd = canonicalizePath(cwd, realpath)
  const worktreeRoot = resolveWorktreeRoot(cwd, options.resolveGitWorktreeRoot, realpath)
  const discoveredProjectRoot = findNearestProjectRoot(cwd, worktreeRoot, exists, realpath, profile.kind)
  const projectConfigPath = discoveredProjectRoot
    ? pickFirstExisting(projectCandidatePaths(discoveredProjectRoot, profile.kind), exists)
    : undefined
  const anchorDir = worktreeRoot ?? discoveredProjectRoot ?? cwd
  const canonicalAnchorDir = canonicalizePath(anchorDir, realpath)
  const trustFilePath = resolveTrustedProjectsFilePath({ homeDir, profile })

  return {
    cwd,
    anchorDir,
    canonicalCwd,
    canonicalAnchorDir,
    ...(worktreeRoot ? { worktreeRoot } : {}),
    ...(discoveredProjectRoot ? { discoveredProjectRoot } : {}),
    trustFilePath,
    ...(projectConfigPath ? { projectConfigPath } : {}),
    trusted: isProjectTrusted(canonicalAnchorDir, trustFilePath, readFile, realpath, exists),
  }
}

// P2 #20 fix: cache the parsed `trusted-projects.json` keyed on the file's
// mtime + size so we do not re-read and re-parse JSON on every dispatch. The
// cache is invalidated whenever the underlying file's stat changes (or the
// file becomes missing/present). Test injections that drive `exists` and
// `readFile` are still honoured because we always re-check existence and only
// short-circuit when the stat fingerprint matches a previously cached parse.
interface CachedTrustList {
  fingerprint: string
  canonicalEntries: Set<string>
}
const trustListCache = new Map<string, CachedTrustList>()

export function __resetTrustListCacheForTests(): void {
  trustListCache.clear()
}

function fingerprintTrustFile(trustFile: string): string {
  try {
    const stat = statSync(trustFile)
    return `${stat.mtimeMs}|${stat.size}`
  } catch {
    return "missing"
  }
}

function isProjectTrusted(
  canonicalAnchorDir: string,
  trustFile: string,
  readFile: (filePath: string) => string,
  realpath: (filePath: string) => string,
  exists: (filePath: string) => boolean,
): boolean {
  if (process.env.PI_YAML_HOOKS_TRUST_PROJECT === "1") {
    warnTrustBypassOnce(canonicalAnchorDir)
    return true
  }
  // Honour the injected `exists` so tests with virtual filesystems remain
  // deterministic — `existsSync` would leak through to the host filesystem.
  if (!exists(trustFile)) return false

  const fingerprint = fingerprintTrustFile(trustFile)
  const cached = trustListCache.get(trustFile)
  let canonicalEntries: Set<string>
  if (cached && cached.fingerprint === fingerprint) {
    canonicalEntries = cached.canonicalEntries
  } else {
    try {
      const raw = readFile(trustFile)
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) {
        // Cache the negative result so a malformed file does not re-parse on
        // every call until it is fixed.
        canonicalEntries = new Set()
      } else {
        canonicalEntries = new Set(
          parsed
            .filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry))
            .map((entry) => canonicalizePath(entry, realpath)),
        )
      }
    } catch {
      canonicalEntries = new Set()
    }
    trustListCache.set(trustFile, { fingerprint, canonicalEntries })
  }

  return canonicalEntries.has(canonicalAnchorDir)
}

function resolveGlobalConfigPath(
  exists: (filePath: string) => boolean,
  platform: string,
  homeDir: string,
  appDataDir: string | undefined,
  profile: HookHostProfile,
): string {
  const candidates = globalCandidatePaths(platform, homeDir, appDataDir, profile)
  return pickFirstExisting(candidates, exists) ?? candidates[0]
}

function globalCandidatePaths(
  platform: string,
  homeDir: string,
  appDataDir: string | undefined,
  profile: HookHostProfile,
): string[] {
  const candidates = [
    path.join(profile.agentDir, "hook", "hooks.yaml"),
    path.join(profile.agentDir, "hooks.yaml"),
  ]

  if (profile.kind === "omp") {
    const legacyAgentDir = path.join(homeDir, ".pi", "agent")
    candidates.push(path.join(legacyAgentDir, "hook", "hooks.yaml"))
    candidates.push(path.join(legacyAgentDir, "hooks.yaml"))
    return candidates
  }

  if (platform === "win32" && appDataDir) {
    candidates.push(path.join(appDataDir, "pi", "agent", "hook", "hooks.yaml"))
    candidates.push(path.join(appDataDir, "pi", "agent", "hooks.yaml"))
  }

  return candidates
}

function projectCandidatePaths(projectDir: string, hostKind: HookHostProfile["kind"]): string[] {
  const piCandidates = [
    path.join(projectDir, ".pi", "hook", "hooks.yaml"),
    path.join(projectDir, ".pi", "hooks.yaml"),
  ]
  return hostKind === "omp"
    ? [
        path.join(projectDir, ".omp", "hook", "hooks.yaml"),
        path.join(projectDir, ".omp", "hooks.yaml"),
        ...piCandidates,
      ]
    : piCandidates
}

function findNearestProjectRoot(
  cwd: string,
  worktreeRoot: string | undefined,
  exists: (filePath: string) => boolean,
  realpath: (filePath: string) => string,
  hostKind: HookHostProfile["kind"],
): string | undefined {
  for (const dir of ancestorDirs(cwd, worktreeRoot, realpath)) {
    if (pickFirstExisting(projectCandidatePaths(dir, hostKind), exists)) {
      return dir
    }
  }

  return undefined
}

function* ancestorDirs(cwd: string, stopDir: string | undefined, realpath: (filePath: string) => string): Iterable<string> {
  const canonicalStopDir = stopDir ? canonicalizePath(stopDir, realpath) : undefined
  let current = path.resolve(cwd)

  while (true) {
    yield current
    if (canonicalStopDir && canonicalizePath(current, realpath) === canonicalStopDir) {
      return
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return
    }
    current = parent
  }
}

function resolveWorktreeRoot(
  cwd: string,
  resolveGitWorktreeRootFn: ((cwd: string) => string | undefined) | undefined,
  realpath: (filePath: string) => string,
): string | undefined {
  const worktreeRoot = resolveGitWorktreeRootFn?.(cwd) ?? defaultResolveGitWorktreeRoot(cwd)
  return worktreeRoot ? canonicalizePath(worktreeRoot, realpath) : undefined
}

function defaultResolveGitWorktreeRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

function canonicalizePath(filePath: string, realpath: (filePath: string) => string): string {
  try {
    return path.resolve(realpath(filePath))
  } catch {
    return path.resolve(filePath)
  }
}

function defaultRealpath(filePath: string): string {
  return realpathSync.native(filePath)
}

function pickFirstExisting(
  candidates: readonly string[],
  exists: (filePath: string) => boolean,
): string | undefined {
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

export function resolveTrustedProjectsFilePath(
  options: Pick<HookConfigDiscoveryOptions, "homeDir" | "profile"> = {},
): string {
  const homeDir = options.homeDir ?? resolveHomeDir()
  const profile = resolveDiscoveryProfile(options, homeDir)
  return path.join(profile.agentDir, "trusted-projects.json")
}

function resolveDiscoveryProfile(
  options: Pick<HookConfigDiscoveryOptions, "profile">,
  homeDir: string,
  return (
    options.profile ??
    getConfiguredHookHostProfile() ??
    Object.freeze({ kind: "pi", agentDir: path.resolve(homeDir, ".pi", "agent") })
  )
}

function resolveHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}
