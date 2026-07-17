import {
  PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE,
  registerHookDiagnostics,
  sendHookDiagnostics,
} from "./diagnostics.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

interface CapturedMessage {
  readonly customType: string
  readonly content: unknown
  readonly display: boolean
  readonly details?: unknown
}

interface CapturedEntry {
  readonly customType: string
  readonly data: unknown
}

interface FakePi {
  readonly messages: CapturedMessage[]
  readonly entries: CapturedEntry[]
  readonly renderers: Map<string, unknown>
  readonly entryRenderers?: Map<string, unknown>
  registerMessageRenderer<T>(type: string, render: (message: { content: unknown; details: T | undefined }, opts: { expanded: boolean }, theme: unknown) => unknown): void
  registerEntryRenderer?(type: string, render: unknown): void
  sendMessage<T>(message: { customType: string; content: string; display: boolean; details?: T }): void
  appendEntry?(customType: string, data: unknown): void
  on(type: string, handler: (event: unknown, ctx: { mode: string }) => void): void
  startSession(mode: string): void
}

function createFakePi(options: { entryRenderer?: boolean; appendEntry?: boolean } = {}): FakePi {
  const messages: CapturedMessage[] = []
  const entries: CapturedEntry[] = []
  const renderers = new Map<string, unknown>()
  const entryRenderers = options.entryRenderer ? new Map<string, unknown>() : undefined
  let sessionStart: ((event: unknown, ctx: { mode: string }) => void) | undefined
  return {
    messages,
    entries,
    renderers,
    ...(entryRenderers
      ? {
          entryRenderers,
          registerEntryRenderer(type: string, render: unknown) {
            entryRenderers.set(type, render)
          },
        }
      : {}),
    ...(options.appendEntry
      ? {
          appendEntry(customType: string, data: unknown) {
            entries.push({ customType, data })
          },
        }
      : {}),
    registerMessageRenderer(type, render) {
      renderers.set(type, render)
    },
    sendMessage(message) {
      messages.push(message)
    },
    on(type, handler) {
      if (type === "session_start") sessionStart = handler
    },
    startSession(mode) {
      sessionStart?.({}, { mode })
    },
  }
}

const cases: Case[] = [
  {
    name: "registers a renderer under the documented message type",
    run: () => {
      const pi = createFakePi()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerHookDiagnostics(pi as any)
      return pi.renderers.has(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE)
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(Array.from(pi.renderers.keys())) }
    },
  },
  {
    name: "registers an entry renderer only when both entry capabilities exist",
    run: () => {
      const complete = createFakePi({ entryRenderer: true, appendEntry: true })
      const missingSender = createFakePi({ entryRenderer: true })
      registerHookDiagnostics(complete as never)
      registerHookDiagnostics(missingSender as never)

      const completeRegistered = complete.entryRenderers?.has(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) === true
      const partialRegistered = missingSender.entryRenderers?.has(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) === true
      return completeRegistered && !partialRegistered
        ? { ok: true }
        : { ok: false, detail: `complete=${completeRegistered}, partial=${partialRegistered}` }
    },
  },
  {
    name: "PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE is the canonical pi-yaml-hooks-diagnostics string",
    run: () =>
      PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE === "pi-yaml-hooks-diagnostics"
        ? { ok: true }
        : { ok: false, detail: PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE },
  },
  {
    name: "TUI diagnostics use context-free entries when both capabilities exist",
    run: () => {
      const pi = createFakePi({ entryRenderer: true, appendEntry: true })
      registerHookDiagnostics(pi as never)
      pi.startSession("tui")
      const sections = [{ label: "details", lines: ["one"] }]
      sendHookDiagnostics(pi as never, {
        title: "Entry title",
        level: "warning",
        content: "entry content",
        sections,
      })

      if (pi.messages.length !== 0 || pi.entries.length !== 1) {
        return { ok: false, detail: `messages=${pi.messages.length}, entries=${pi.entries.length}` }
      }
      const entry = pi.entries[0]
      const data = entry.data as { content?: string; title?: string; level?: string; sections?: unknown }
      return entry.customType === PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE &&
        data.content === "entry content" &&
        data.title === "Entry title" &&
        data.level === "warning" &&
        JSON.stringify(data.sections) === JSON.stringify(sections)
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(entry) }
    },
  },
  {
    name: "non-TUI diagnostics keep the custom-message fallback",
    run: () => {
      const pi = createFakePi({ entryRenderer: true, appendEntry: true })
      registerHookDiagnostics(pi as never)
      pi.startSession("json")
      sendHookDiagnostics(pi as never, { title: "headless", level: "info", content: "fallback" })

      return pi.entries.length === 0 && pi.messages.length === 1 && pi.messages[0].content === "fallback"
        ? { ok: true }
        : { ok: false, detail: `messages=${pi.messages.length}, entries=${pi.entries.length}` }
    },
  },
  {
    name: "partial entry capability keeps the custom-message fallback",
    run: () => {
      const pi = createFakePi({ appendEntry: true })
      registerHookDiagnostics(pi as never)
      pi.startSession("tui")
      sendHookDiagnostics(pi as never, { title: "partial", level: "error", content: "fallback" })

      return pi.entries.length === 0 && pi.messages.length === 1
        ? { ok: true }
        : { ok: false, detail: `messages=${pi.messages.length}, entries=${pi.entries.length}` }
    },
  },
  {
    name: "sendHookDiagnostics emits a structured message with display=true",
    run: () => {
      const pi = createFakePi()
      sendHookDiagnostics(pi as never, {
        title: "Test title",
        level: "info",
        content: "test content",
      })

      if (pi.messages.length !== 1) {
        return { ok: false, detail: `count=${pi.messages.length}` }
      }
      const msg = pi.messages[0]
      const details = msg.details as { title?: string; level?: string; sections?: unknown }
      if (msg.customType !== PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) {
        return { ok: false, detail: `customType=${msg.customType}` }
      }
      if (msg.content !== "test content") {
        return { ok: false, detail: `content=${msg.content}` }
      }
      if (msg.display !== true) {
        return { ok: false, detail: "display flag should be true" }
      }
      if (details.title !== "Test title" || details.level !== "info") {
        return { ok: false, detail: JSON.stringify(details) }
      }
      // sections omitted when not provided.
      if ("sections" in details) {
        return { ok: false, detail: "sections should not be present when caller omitted them" }
      }
      return { ok: true }
    },
  },
  {
    name: "sendHookDiagnostics propagates sections when present",
    run: () => {
      const pi = createFakePi()
      const sections = [
        { label: "errors", lines: ["a", "b"] },
        { label: "info", lines: ["x"] },
      ]
      sendHookDiagnostics(pi as never, {
        title: "T",
        level: "warning",
        content: "c",
        sections,
      })

      const details = pi.messages[0].details as { sections?: unknown; level?: string }
      return details.level === "warning" && JSON.stringify(details.sections) === JSON.stringify(sections)
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(details) }
    },
  },
  {
    name: "sendHookDiagnostics supports error level",
    run: () => {
      const pi = createFakePi()
      sendHookDiagnostics(pi as never, { title: "boom", level: "error", content: "x" })
      const details = pi.messages[0].details as { level?: string }
      return details.level === "error" ? { ok: true } : { ok: false, detail: JSON.stringify(details) }
    },
  },
  {
    name: "registered renderer returns cached width-bounded rows with theme colors",
    run: () => {
      const pi = createFakePi()
      registerHookDiagnostics(pi as never)
      const renderer = pi.renderers.get(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) as (
        message: {
          content: string
          details:
            | {
                title: string
                level: "info" | "warning" | "error"
                sections?: Array<{ label: string; lines: string[] }>
              }
            | undefined
        },
        opts: { expanded: boolean },
        theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
      ) => { render(width: number): string[]; invalidate(): void }

      const colorCalls: string[] = []
      const backgroundCalls: string[] = []
      const theme = {
        fg: (color: string, text: string) => {
          colorCalls.push(`${color}:${text}`)
          return `\x1b[33m${text}\x1b[39m`
        },
        bg: (color: string, text: string) => {
          backgroundCalls.push(`${color}:${text}`)
          return `\x1b[48;5;236m${text}\x1b[49m`
        },
      }
      const component = renderer(
        {
          content: "content that must wrap without overflowing",
          details: {
            title: "diagnostic title",
            level: "warning",
            sections: [{ label: "details", lines: ["section line"] }],
          },
        },
        { expanded: true },
        theme,
      )

      const wideRows = component.render(40)
      const narrowRows = component.render(12)
      const cachedRows = component.render(12)
      const singleColumnRows = component.render(1)
      const ansi = /\x1b\[[0-?]*[ -/]*[@-~]/g
      const bounded = [
        { width: 40, rows: wideRows },
        { width: 12, rows: narrowRows },
        { width: 1, rows: singleColumnRows },
      ].every(({ width, rows }) => rows.every((row) => row.replace(ansi, "").length <= width))
      const renderedText = wideRows.map((row) => row.replace(ansi, "").trimEnd()).join("\n")
      const hasContent =
        renderedText.includes("[WARNING] diagnostic title") &&
        renderedText.includes("content that must wrap") &&
        renderedText.includes("details") &&
        renderedText.includes("section line")
      const cached = cachedRows === narrowRows
      component.invalidate()
      const invalidatedRows = component.render(12)
      const invalidated = invalidatedRows !== narrowRows && JSON.stringify(invalidatedRows) === JSON.stringify(narrowRows)
      const themed =
        colorCalls.includes("warning:[WARNING]") &&
        colorCalls.includes("dim:details") &&
        backgroundCalls.length > 0 &&
        backgroundCalls.every((call) => call.startsWith("customMessageBg:"))

      return bounded && hasContent && cached && invalidated && themed
        ? { ok: true }
        : {
            ok: false,
            detail: JSON.stringify({
              bounded,
              hasContent,
              cached,
              invalidated,
              themed,
              wideRows,
              narrowRows,
              singleColumnRows,
              colorCalls,
            }),
          }
    },
  },
  {
    name: "entry renderer reuses message formatting",
    run: () => {
      const pi = createFakePi({ entryRenderer: true, appendEntry: true })
      registerHookDiagnostics(pi as never)
      const renderer = pi.entryRenderers?.get(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) as (
        entry: { data: { content: string; title: string; level: "error"; sections: Array<{ label: string; lines: string[] }> } },
        opts: { expanded: boolean },
        theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
      ) => { render(width: number): string[]; invalidate(): void }
      const colorCalls: string[] = []
      const theme = {
        fg: (color: string, text: string) => {
          colorCalls.push(`${color}:${text}`)
          return text
        },
        bg: (_color: string, text: string) => text,
      }

      const component = renderer(
        { data: { content: "entry", title: "entry title", level: "error", sections: [{ label: "sec", lines: ["line"] }] } },
        { expanded: true },
        theme,
      )
      const rows = component.render(24)
      component.invalidate()
      const rerenderedRows = component.render(24)

      if (rows === rerenderedRows || rows.some((row) => row.length > 24)) {
        return { ok: false, detail: JSON.stringify({ rows, rerenderedRows }) }
      }

      return colorCalls.includes("error:[ERROR]") && colorCalls.includes("dim:sec")
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(colorCalls) }
    },
  },
  {
    name: "renderer collapses sections when expanded=false",
    run: () => {
      const pi = createFakePi()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerHookDiagnostics(pi as any)
      const renderer = pi.renderers.get(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) as (
        message: { content: string; details: { title: string; level: "info"; sections?: Array<{ label: string; lines: string[] }> } | undefined },
        opts: { expanded: boolean },
        theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
      ) => unknown

      const colorCalls: string[] = []
      const theme = {
        fg: (color: string, text: string) => {
          colorCalls.push(`${color}:${text}`)
          return text
        },
        bg: (_color: string, text: string) => text,
      }

      renderer(
        {
          content: "c",
          details: {
            title: "t",
            level: "info",
            sections: [{ label: "should-not-appear", lines: ["x"] }],
          },
        },
        { expanded: false },
        theme,
      )

      const sectionRendered = colorCalls.some((call) => call === "dim:should-not-appear")
      return sectionRendered ? { ok: false, detail: "section label rendered while collapsed" } : { ok: true }
    },
  },
  {
    name: "renderer uses neutral badge color for info level",
    run: () => {
      const pi = createFakePi()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerHookDiagnostics(pi as any)
      const renderer = pi.renderers.get(PI_YAML_HOOKS_DIAGNOSTICS_MESSAGE_TYPE) as (
        message: { content: string; details: { title: string; level: "info"; sections?: never } | undefined },
        opts: { expanded: boolean },
        theme: { fg: (color: string, text: string) => string; bg: (color: string, text: string) => string },
      ) => unknown

      const colorCalls: string[] = []
      const theme = {
        fg: (color: string, text: string) => {
          colorCalls.push(`${color}:${text}`)
          return text
        },
        bg: (_color: string, text: string) => text,
      }

      renderer(
        { content: "ok", details: { title: "t", level: "info" } },
        { expanded: false },
        theme,
      )

      return colorCalls.some((call) => call.startsWith("dim:[INFO]"))
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(colorCalls) }
    },
  },
]

export function main(): number {
  let failures = 0
  for (const c of cases) {
    try {
      const outcome = c.run()
      if (outcome.ok) {
        console.info(`PASS  ${c.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${c.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${c.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /diagnostics\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  process.exit(main())
}
