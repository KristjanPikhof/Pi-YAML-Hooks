import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

interface DiagnosticsComponent {
  render(width: number): string[]
  invalidate(): void
}

interface RenderCache {
  readonly width: number
  readonly rows: string[]
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function ansiSequenceLength(text: string, offset: number): number {
  if (text.charCodeAt(offset) !== 0x1b) return 0
  const kind = text[offset + 1]
  if (kind === "[") {
    for (let index = offset + 2; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return index - offset + 1
    }
    return text.length - offset
  }
  if (kind === "]" || kind === "_" || kind === "^") {
    for (let index = offset + 2; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 0x07) return index - offset + 1
      if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") return index - offset + 2
    }
    return text.length - offset
  }
  return Math.min(2, text.length - offset)
}

function graphemeWidth(grapheme: string): number {
  const codePoint = grapheme.codePointAt(0)
  if (
    codePoint === undefined ||
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    /^\p{Mark}/u.test(grapheme)
  ) {
    return 0
  }
  if (
    /\p{Extended_Pictographic}/u.test(grapheme) ||
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) ||
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)))
  ) {
    return 2
  }
  return 1
}

function visibleWidth(text: string): number {
  let width = 0
  let plain = ""
  for (let offset = 0; offset < text.length; ) {
    const ansiLength = ansiSequenceLength(text, offset)
    if (ansiLength > 0) {
      for (const { segment } of graphemeSegmenter.segment(plain)) width += graphemeWidth(segment)
      plain = ""
      offset += ansiLength
      continue
    }
    const codePoint = text.codePointAt(offset)
    if (codePoint === undefined) break
    plain += String.fromCodePoint(codePoint)
    offset += codePoint > 0xffff ? 2 : 1
  }
  for (const { segment } of graphemeSegmenter.segment(plain)) width += graphemeWidth(segment)
  return width
}

function wrapLine(text: string, width: number): string[] {
  const rows: string[] = []
  let row = ""
  let rowWidth = 0
  let plain = ""

  const flushPlain = (): void => {
    for (const { segment } of graphemeSegmenter.segment(plain)) {
      const segmentWidth = graphemeWidth(segment)
      if (rowWidth > 0 && rowWidth + segmentWidth > width) {
        rows.push(row)
        row = ""
        rowWidth = 0
      }
      if (segmentWidth > width) {
        row += "?"
        rowWidth += 1
      } else {
        row += segment
        rowWidth += segmentWidth
      }
    }
    plain = ""
  }

  for (let offset = 0; offset < text.length; ) {
    const ansiLength = ansiSequenceLength(text, offset)
    if (ansiLength > 0) {
      flushPlain()
      row += text.slice(offset, offset + ansiLength)
      offset += ansiLength
      continue
    }
    const codePoint = text.codePointAt(offset)
    if (codePoint === undefined) break
    plain += String.fromCodePoint(codePoint)
    offset += codePoint > 0xffff ? 2 : 1
  }
  flushPlain()
  rows.push(row)
  return rows
}

class DiagnosticsRows implements DiagnosticsComponent {
  private cache: RenderCache | undefined

  constructor(
    private readonly contentRows: readonly string[],
    private readonly background: (text: string) => string,
  ) {}

  render(width: number): string[] {
    const boundedWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
    if (this.cache?.width === boundedWidth) return this.cache.rows

    if (boundedWidth === 0) {
      const rows: string[] = []
      this.cache = { width: boundedWidth, rows }
      return rows
    }

    const horizontalPadding = boundedWidth > 1 ? 1 : 0
    const contentWidth = Math.max(1, boundedWidth - horizontalPadding * 2)
    const leftPadding = " ".repeat(horizontalPadding)
    const rows: string[] = [this.background(" ".repeat(boundedWidth))]

    for (const contentRow of this.contentRows) {
      const logicalRows = contentRow.replace(/\r\n?/g, "\n").replace(/\t/g, "   ").split("\n")
      for (const logicalRow of logicalRows) {
        for (const wrappedRow of wrapLine(logicalRow, contentWidth)) {
          const line = leftPadding + wrappedRow
          rows.push(this.background(line + " ".repeat(Math.max(0, boundedWidth - visibleWidth(line)))))
        }
      }
    }
    rows.push(this.background(" ".repeat(boundedWidth)))

    this.cache = { width: boundedWidth, rows }
    return rows
  }

  invalidate(): void {
    this.cache = undefined
  }
}

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
): DiagnosticsComponent {
  const level = details?.level ?? "info"
  const title = details?.title ?? "pi-yaml-hooks diagnostics"
  const badgeColor = level === "error" ? "error" : level === "warning" ? "warning" : "dim"
  const rows = [`${theme.fg(badgeColor, `[${level.toUpperCase()}]`)} ${title}`, String(content)]

  if (expanded && details?.sections) {
    for (const section of details.sections) {
      rows.push("")
      rows.push(theme.fg("dim", section.label))
      rows.push(...section.lines)
    }
  }

  return new DiagnosticsRows(rows, (text) => theme.bg("customMessageBg", text))
}

export function registerHookDiagnostics(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<HookDiagnosticsMessageDetails>(
    PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
    (message, { expanded }, theme) => renderDiagnostics(message.content, message.details, expanded, theme),
  )

  const supportsEntries = hasEntryCapabilities(pi)
  entryEnabled.set(pi, false)
  pi.on("session_start", (_event, ctx) => {
    const mode = (ctx as unknown as { readonly mode?: unknown }).mode
    entryEnabled.set(pi, supportsEntries && mode === "tui")
  })

  if (supportsEntries) {
    const entryPi = pi as unknown as EntryCapablePi
    entryPi.registerEntryRenderer(
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
