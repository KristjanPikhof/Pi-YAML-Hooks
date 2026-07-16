import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Box, Text } from "@earendil-works/pi-tui"

export const PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE = "pi-yaml-hooks-diagnostics"

export interface HookDiagnosticsMessageDetails {
  readonly title: string
  readonly level: "info" | "warning" | "error"
  readonly sections?: Array<{
    readonly label: string
    readonly lines: string[]
  }>
}

interface HookDiagnosticsEntryData extends HookDiagnosticsMessageDetails {
  readonly content: string
}

interface EntryCapablePi {
  registerEntryRenderer(
    customType: string,
    renderer: (
      entry: { readonly data?: HookDiagnosticsEntryData },
      options: { readonly expanded: boolean },
      theme: RendererTheme,
    ) => unknown,
  ): void
  appendEntry(customType: string, data: HookDiagnosticsEntryData): void
}

type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1]
type RendererTheme = Parameters<MessageRenderer>[2]

const entryEnabled = new WeakMap<ExtensionAPI, boolean>()

function hasEntryCapabilities(pi: ExtensionAPI): pi is ExtensionAPI & EntryCapablePi {
  const candidate = pi as unknown as Partial<EntryCapablePi>
  return typeof candidate.registerEntryRenderer === "function" && typeof candidate.appendEntry === "function"
}

function renderDiagnostics(
  content: unknown,
  details: HookDiagnosticsMessageDetails | undefined,
  expanded: boolean,
  theme: RendererTheme,
): Box {
  const level = details?.level ?? "info"
  const title = details?.title ?? "pi-yaml-hooks diagnostics"
  const badgeColor = level === "error" ? "error" : level === "warning" ? "warning" : "dim"
  const lines = [`${theme.fg(badgeColor, `[${level.toUpperCase()}]`)} ${title}`, String(content)]

  if (expanded && details?.sections) {
    for (const section of details.sections) {
      lines.push("")
      lines.push(theme.fg("dim", section.label))
      lines.push(...section.lines)
    }
  }

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
  box.addChild(new Text(lines.join("\n"), 0, 0))
  return box
}

export function registerHookDiagnostics(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HookDiagnosticsMessageDetails>(
    PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
    (message, { expanded }, theme) => renderDiagnostics(message.content, message.details, expanded, theme),
  )

  const supportsEntries = hasEntryCapabilities(pi)
  entryEnabled.set(pi, false)
  pi.on("session_start", (_event, ctx) => {
    entryEnabled.set(pi, supportsEntries && ctx.mode === "tui")
  })

  if (supportsEntries) {
    pi.registerEntryRenderer(
      PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
      (entry, { expanded }, theme) => {
        const data = entry.data
        return renderDiagnostics(data?.content, data, expanded, theme)
      },
    )
  }
}

export function sendHookDiagnostics(
  pi: ExtensionAPI,
  message: {
    readonly content: string
    readonly title: string
    readonly level: "info" | "warning" | "error"
    readonly sections?: HookDiagnosticsMessageDetails["sections"]
  },
): void {
  const details: HookDiagnosticsMessageDetails = {
    title: message.title,
    level: message.level,
    ...(message.sections ? { sections: message.sections } : {}),
  }

  if (entryEnabled.get(pi) && hasEntryCapabilities(pi)) {
    pi.appendEntry(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE, {
      content: message.content,
      ...details,
    })
    return
  }

  pi.sendMessage<HookDiagnosticsMessageDetails>({
    customType: PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
    content: message.content,
    display: true,
    details,
  })
}
