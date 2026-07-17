import { getToolFileChanges } from "../core/tool-paths.js"
import { mapToolResultToAfterInput } from "./event-mappers.js"

interface Case {
  readonly name: string
  readonly run: () => { ok: boolean; detail?: string }
}

type ToolResultEventInput = Parameters<typeof mapToolResultToAfterInput>[0]

function asToolResultEvent(event: Record<string, unknown>): ToolResultEventInput {
  return event as unknown as ToolResultEventInput
}

const cases: Case[] = [
  {
    name: "legacy Pi tool_result input is preserved unchanged",
    run: () => {
      const input = { path: "/repo/src/pi.ts", oldText: "before", newText: "after" }
      const mapped = mapToolResultToAfterInput(
        asToolResultEvent({ toolName: "edit", toolCallId: "pi-1", input }),
        "session-pi",
      )
      return mapped.tool === "edit" &&
          mapped.callID === "pi-1" &&
          mapped.sessionID === "session-pi" &&
          mapped.args === input
        ? { ok: true }
        : { ok: false, detail: JSON.stringify(mapped) }
    },
  },
  {
    name: "OMP single-file edit details authoritatively override hashline payload path",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        asToolResultEvent({
          toolName: "edit",
          toolCallId: "omp-hashline",
          input: { input: "[stale.ts#A1B2]\nSWAP 1.=1:\n+updated" },
          details: { diff: "", path: "/repo/src/actual.ts", op: "update" },
        }),
        "session-omp",
      )
      const changes = getToolFileChanges(mapped.tool, mapped.args ?? {})
      return changes.length === 1 && changes[0].operation === "modify" && changes[0].path === "/repo/src/actual.ts"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ mapped, changes }) }
    },
  },
  {
    name: "OMP multi-file apply_patch details preserve successful result operations",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        asToolResultEvent({
          toolName: "edit",
          toolCallId: "omp-apply-patch",
          input: { input: "*** Begin Patch\n*** Update File: stale.ts\n@@\n*** End Patch" },
          details: {
            diff: "",
            perFileResults: [
              { path: "/repo/src/new.ts", op: "create", diff: "" },
              { path: "/repo/src/to.ts", sourcePath: "/repo/src/from.ts", op: "update", move: "/repo/src/to.ts", diff: "" },
              { path: "/repo/src/failed.ts", op: "update", diff: "", isError: true },
            ],
          },
        }),
        "session-omp",
      )
      const changes = getToolFileChanges(mapped.tool, mapped.args ?? {})
      const summary = changes.map((change) =>
        change.operation === "rename"
          ? `rename:${change.fromPath}->${change.toPath}`
          : `${change.operation}:${change.path}`,
      )
      const expected = ["create:/repo/src/new.ts", "rename:/repo/src/from.ts->/repo/src/to.ts"]
      return JSON.stringify(summary) === JSON.stringify(expected)
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ mapped, summary }) }
    },
  },
]

export async function main(): Promise<number> {
  let failures = 0
  for (const testCase of cases) {
    try {
      const outcome = testCase.run()
      if (outcome.ok) {
        console.info(`PASS  ${testCase.name}`)
      } else {
        failures += 1
        console.info(`FAIL  ${testCase.name} -- ${outcome.detail ?? "no detail"}`)
      }
    } catch (error) {
      failures += 1
      console.info(`FAIL  ${testCase.name} -- threw ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`)
  return failures === 0 ? 0 : 1
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /event-mappers\.test\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().then((code) => process.exit(code))
}
