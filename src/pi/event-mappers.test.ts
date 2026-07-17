import { getToolAffectedPaths, getToolFileChanges } from "../core/tool-paths.js";
import { mapToolResultToAfterInput } from "./event-mappers.js";

type ToolResultMapperEvent = Parameters<typeof mapToolResultToAfterInput>[0];

interface Case {
  readonly name: string;
  readonly run: () => { ok: boolean; detail?: string };
}

const MUTATION_ARG_KEYS = [
  "edits",
  "input",
  "file",
  "filePath",
  "file_path",
  "path",
  "sourcePath",
  "fromPath",
  "move",
  "rename",
  "toPath",
] as const;

const cases: Case[] = [
  {
    name: "all-failed OMP multi-file edit exposes no mutation paths or file.changed trigger",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        {
          toolName: "edit",
          toolCallId: "omp-all-failed",
          input: {
            input: [
              "[src/failed.ts#A1B2]",
              "SWAP 1.=1:",
              "+failed",
              "[src/skipped.ts#C3D4]",
              "SWAP 1.=1:",
              "+skipped",
            ].join("\n"),
            path: "src/requested.ts",
            filePath: "src/requested-again.ts",
            sourcePath: "src/requested-source.ts",
            move: "src/requested-destination.ts",
            requestTag: "retain-safe-metadata",
          },
          details: {
            perFileResults: [
              { path: "/repo/src/failed.ts", isError: true },
              { path: "/repo/src/also-failed.ts", isError: true },
            ],
          },
        } as unknown as ToolResultMapperEvent,
        "session-omp",
      );

      const args = mapped.args ?? {};
      const changes = getToolFileChanges(mapped.tool, args);
      const paths = getToolAffectedPaths(mapped.tool, args);
      const hasEmptyEdits = Array.isArray(args.edits) && args.edits.length === 0;
      const retainedUnsafeKey = MUTATION_ARG_KEYS
        .filter((key) => key !== "edits")
        .find((key) => Object.hasOwn(args, key));
      const ok = hasEmptyEdits &&
        changes.length === 0 &&
        paths.length === 0 &&
        retainedUnsafeKey === undefined &&
        args.requestTag === "retain-safe-metadata";

      return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ args, changes, paths, retainedUnsafeKey }) };
    },
  },
  {
    name: "failed OMP single-file edit details expose no mutation paths or file.changed trigger",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        {
          toolName: "edit",
          toolCallId: "omp-single-failed",
          input: {
            input: "[src/requested.ts#A1B2]\nSWAP 1.=1:\n+failed",
            requestTag: "retain-single-failure-metadata",
          },
          isError: true,
          details: {
            path: "/repo/src/requested.ts",
            diff: "",
          },
        } as unknown as ToolResultMapperEvent,
        "session-omp",
      );

      const args = mapped.args ?? {};
      const changes = getToolFileChanges(mapped.tool, args);
      const paths = getToolAffectedPaths(mapped.tool, args);
      const ok = Array.isArray(args.edits) &&
        args.edits.length === 0 &&
        changes.length === 0 &&
        paths.length === 0 &&
        !Object.hasOwn(args, "input") &&
        !Object.hasOwn(args, "path") &&
        args.requestTag === "retain-single-failure-metadata";

      return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ args, changes, paths }) };
    },
  },
  {
    name: "mixed OMP multi-file edit exposes only successful result paths",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        {
          toolName: "edit",
          toolCallId: "omp-partial-success",
          input: {
            input: [
              "[src/applied.ts#A1B2]",
              "SWAP 1.=1:",
              "+applied",
              "[src/failed.ts#C3D4]",
              "SWAP 1.=1:",
              "+failed",
              "[src/skipped.ts#E5F6]",
              "SWAP 1.=1:",
              "+skipped",
            ].join("\n"),
          },
          isError: true,
          details: {
            perFileResults: [
              { path: "/repo/src/applied.ts", op: "update" },
              { path: "/repo/src/failed.ts", op: "update", isError: true },
            ],
          },
        } as unknown as ToolResultMapperEvent,
        "session-omp",
      );

      const args = mapped.args ?? {};
      const paths = getToolAffectedPaths(mapped.tool, args);
      const expected = ["/repo/src/applied.ts"];
      return JSON.stringify(paths) === JSON.stringify(expected) && !Object.hasOwn(args, "input")
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ args, paths }) };
    },
  },
];

export function main(): number {
  let failures = 0;
  for (const testCase of cases) {
    try {
      const outcome = testCase.run();
      if (outcome.ok) {
        console.info(`PASS  ${testCase.name}`);
      } else {
        failures += 1;
        console.info(`FAIL  ${testCase.name} -- ${outcome.detail ?? "no detail"}`);
      }
    } catch (error) {
      failures += 1;
      console.info(`FAIL  ${testCase.name} -- threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.info(`\n${cases.length - failures}/${cases.length} passed`);
  return failures === 0 ? 0 : 1;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /event-mappers\.test\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  process.exit(main());
}
