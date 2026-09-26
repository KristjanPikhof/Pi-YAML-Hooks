import type { ExtensionContext as PiContext } from "@earendil-works/pi-coding-agent"
import type { ExtensionContext as OmpContext } from "@oh-my-pi/pi-coding-agent"

import type { BashSessionMetadata } from "../core/bash-types.js"
import type { HookHostKind } from "../core/host-profile.js"

/** Copy live host values before an async hook or session switch can change them. */
export function captureSessionMetadata(
  ctx: PiContext | OmpContext,
  hostKind: HookHostKind,
  api?: { getThinkingLevel?: () => string | undefined },
): BashSessionMetadata {
  const model = ctx.model
  const sessionFile = ctx.sessionManager.getSessionFile?.()
  const reasoningLevel = hostKind === "pi"
    ? (ctx as PiContext).thinkingLevel
    : api?.getThinkingLevel?.()

  return Object.freeze({
    ...(model ? { model: model.id, provider: model.provider } : {}),
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  })
}
