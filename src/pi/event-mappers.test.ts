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
    name: "partially applied OMP single-file edit preserves diff and snapshot evidenced paths",
    run: () => {
      const evidenceCases = [
        {
          name: "non-empty diff",
          details: {
            path: "/repo/src/diff-applied.ts",
            diff: "@@ -1 +1 @@\n-before\n+after",
          },
        },
        {
          name: "before/after snapshots",
          details: {
            path: "/repo/src/snapshot-applied.ts",
            diff: "",
            oldText: "before",
            newText: "after",
          },
        },
      ] as const;

      for (const evidenceCase of evidenceCases) {
        const mapped = mapToolResultToAfterInput(
          {
            toolName: "edit",
            toolCallId: `omp-single-partial-${evidenceCase.name}`,
            input: {
              input: "[src/unapplied-request.ts#A1B2]\nSWAP 1.=1:\n+requested",
            },
            isError: true,
            details: evidenceCase.details,
          } as unknown as ToolResultMapperEvent,
          "session-omp",
        );
        const paths = getToolAffectedPaths(mapped.tool, mapped.args ?? {});
        if (paths.length !== 1 || paths[0] !== evidenceCase.details.path) {
          return {
            ok: false,
            detail: JSON.stringify({ evidence: evidenceCase.name, args: mapped.args, paths }),
          };
        }
      }

      return { ok: true };
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
  {
    name: "failed OMP write without resolved path exposes no mutation paths or file.changed trigger",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        {
          toolName: "write",
          toolCallId: "omp-write-failed",
          input: {
            path: "/repo/src/requested.ts",
            content: "not written",
            requestTag: "retain-write-metadata",
          },
          isError: true,
          details: {},
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
        !Object.hasOwn(args, "path") &&
        args.content === "not written" &&
        args.requestTag === "retain-write-metadata";

      return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ args, changes, paths }) };
    },
  },
  {
    name: "OMP write resolved filesystem path is authoritative for partial and URI-backed success",
    run: () => {
      const evidenceCases = [
        {
          name: "partial aggregate error",
          requestedPath: "/repo/src/requested.ts",
          resolvedPath: "/repo/src/partially-written.ts",
          isError: true,
        },
        {
          name: "successful internal URI",
          requestedPath: "local://reports/output.txt",
          resolvedPath: "/repo/.pi/local/reports/output.txt",
          isError: false,
        },
      ] as const;

      for (const evidenceCase of evidenceCases) {
        const mapped = mapToolResultToAfterInput(
          {
            toolName: "write",
            toolCallId: `omp-write-${evidenceCase.name}`,
            input: {
              path: evidenceCase.requestedPath,
              content: "written",
            },
            isError: evidenceCase.isError,
            details: {
              resolvedPath: evidenceCase.resolvedPath,
            },
          } as unknown as ToolResultMapperEvent,
          "session-omp",
        );
        const paths = getToolAffectedPaths(mapped.tool, mapped.args ?? {});
        if (paths.length !== 1 || paths[0] !== evidenceCase.resolvedPath) {
          return {
            ok: false,
            detail: JSON.stringify({ evidence: evidenceCase.name, args: mapped.args, paths }),
          };
        }
      }

      return { ok: true };
    },
  },
  {
    name: "successful OMP write to internal URI without resolved filesystem path emits no file change",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        {
          toolName: "write",
          toolCallId: "omp-write-xd-success",
          input: {
            path: "xd://mounted-tool",
            content: "{\"subject\":\"example\"}",
          },
          isError: false,
          details: {},
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
        !Object.hasOwn(args, "path");

      return ok ? { ok: true } : { ok: false, detail: JSON.stringify({ args, changes, paths }) };
    },
  },
  {
    name: "successful ordinary filesystem write preserves requested path without result details",
    run: () => {
      const mapped = mapToolResultToAfterInput(
        {
          toolName: "write",
          toolCallId: "omp-write-filesystem-success",
          input: {
            path: "/repo/src/written.ts",
            content: "written",
          },
          isError: false,
          details: {},
        } as unknown as ToolResultMapperEvent,
        "session-omp",
      );
      const paths = getToolAffectedPaths(mapped.tool, mapped.args ?? {});
      return paths.length === 1 && paths[0] === "/repo/src/written.ts"
        ? { ok: true }
        : { ok: false, detail: JSON.stringify({ args: mapped.args, paths }) };
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
