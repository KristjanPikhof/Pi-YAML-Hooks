import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { registerHooksExtension } from "../index.js"

interface OmpAgentDirCapability {
  readonly pi: {
    getAgentDir(): unknown
  }
}

const REQUIRED_EXTENSION_METHODS = [
  "on",
  "registerCommand",
  "registerMessageRenderer",
  "sendMessage",
  "sendUserMessage",
] as const

export default function ompHooksExtension(input: unknown): void {
  const pi = requireOmpExtensionApi(input)
  let agentDir: unknown
  try {
    agentDir = pi.pi.getAgentDir()
  } catch (cause) {
    throw new Error("OMP extension could not resolve the active agentDir through pi.pi.getAgentDir().", { cause })
  }

  if (typeof agentDir !== "string" || agentDir.trim().length === 0) {
    throw new Error("OMP extension requires pi.pi.getAgentDir() to return a non-empty string agentDir.")
  }

  registerHooksExtension(pi, { kind: "omp", agentDir })
}

function requireOmpExtensionApi(input: unknown): ExtensionAPI & OmpAgentDirCapability {
  if (!isRecord(input) || !isRecord(input.pi) || typeof input.pi.getAgentDir !== "function") {
    throw new Error("OMP extension requires the pi.pi.getAgentDir() capability.")
  }

  for (const method of REQUIRED_EXTENSION_METHODS) {
    if (typeof input[method] !== "function") {
      throw new Error(`OMP extension requires the ExtensionAPI.${method}() capability.`)
    }
  }

  return input as unknown as ExtensionAPI & OmpAgentDirCapability
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
