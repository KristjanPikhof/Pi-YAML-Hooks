/**
 * Host capabilities that only exist on newer Pi/OMP SDKs.
 *
 * The extension ships with `peerDependencies: "*"`, so it must degrade to a
 * documented no-op on older hosts instead of assuming the newest API. The SDK
 * version is read from the resolved host package on disk: the packages do not
 * export a version symbol through their `exports` map, and a runtime import of
 * one host's package would break the other host's install.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import type { HookHostKind } from "../core/host-profile.js"

export interface HostCapabilities {
  /**
   * Pi >= 0.84 rewrites tool arguments by mutating `event.input` in place
   * (documented on `ToolCallEventResult`); OMP >= 18 returns the revision as
   * the `tool_call` result's `input` field.
   */
  readonly toolArgsRewrite: boolean
  /** OMP >= 18 accepts `deliverAs: "aside"` on its message APIs. */
  readonly asideDelivery: boolean
}

const PI_ARGS_REWRITE_MIN = "0.84.0"
const OMP_ARGS_REWRITE_MIN = "18.0.0"
const OMP_ASIDE_MIN = "18.0.0"

const PACKAGE_NAMES: Record<HookHostKind, string> = {
  pi: "@earendil-works/pi-coding-agent",
  omp: "@oh-my-pi/pi-coding-agent",
}

const requireFromHere = createRequire(import.meta.url)
const versionCache = new Map<HookHostKind, string | undefined>()

/** Resolve the active host SDK version, or undefined when it cannot be read. */
export function resolveHostSdkVersion(kind: HookHostKind): string | undefined {
  if (versionCache.has(kind)) {
    return versionCache.get(kind)
  }
  const version = readPackageVersion(PACKAGE_NAMES[kind])
  versionCache.set(kind, version)
  return version
}

function readPackageVersion(packageName: string): string | undefined {
  try {
    let dir = path.dirname(requireFromHere.resolve(packageName))
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
          name?: unknown
          version?: unknown
        }
        if (manifest.name === packageName && typeof manifest.version === "string") {
          return manifest.version
        }
      } catch {
        // package.json missing at this level; keep walking toward the root.
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Host SDK not resolvable from this module (for example a bundled install).
  }
  return undefined
}

/** Numeric-semver comparison; prerelease tags compare equal to their release. */
export function compareVersionStrings(left: string, right: string): number {
  const a = parseVersionSegments(left)
  const b = parseVersionSegments(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const l = a[index] ?? 0
    const r = b[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

function parseVersionSegments(version: string): number[] {
  const core = version.trim().replace(/^[^0-9]*/, "").split(/[-+]/)[0] ?? ""
  return core.split(".").map((segment) => {
    const value = Number.parseInt(segment, 10)
    return Number.isFinite(value) ? value : 0
  })
}

/**
 * Derive the capability set for a host. `sdkVersion` defaults to the version
 * resolved from the installed package; an unknown version yields no
 * capabilities so the extension never claims an API the host may lack.
 */
export function detectHostCapabilities(
  kind: HookHostKind,
  sdkVersion: string | undefined = resolveHostSdkVersion(kind),
): HostCapabilities {
  const atLeast = (minimum: string): boolean =>
    sdkVersion !== undefined && compareVersionStrings(sdkVersion, minimum) >= 0

  if (kind === "omp") {
    return { toolArgsRewrite: atLeast(OMP_ARGS_REWRITE_MIN), asideDelivery: atLeast(OMP_ASIDE_MIN) }
  }

  return { toolArgsRewrite: atLeast(PI_ARGS_REWRITE_MIN), asideDelivery: false }
}

/** Test seam: drop the memoized SDK version lookups. */
export function __resetHostCapabilitiesCacheForTests(): void {
  versionCache.clear()
}
