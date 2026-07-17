/**
 * Pure helpers that translate SDK event shapes (`ToolCallEvent`,
 * `ToolResultEvent`, session lifecycle events) into the runtime's input
 * envelopes. Kept side-effect-free so they can be exercised in isolation
 * and so the dispatch handlers in `register-adapter.ts` stay focused on
 * orchestration rather than shape massaging.
 *
 * Extracted from `adapter.ts` as part of the P0/P1 refactor; behaviour is
 * unchanged.
 */

import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

import type {
  ToolExecuteAfterInput,
  ToolExecuteBeforeInput,
  ToolExecuteBeforeOutput,
} from "../core/runtime.js";

/** Build the `tool.execute.before` input envelope from a PI `tool_call`. */
export function mapToolCallToBeforeInput(
  event: ToolCallEvent,
  sessionId: string,
): ToolExecuteBeforeInput {
  return {
    tool: event.toolName,
    sessionID: sessionId,
    callID: event.toolCallId,
  };
}

/** Build the `tool.execute.before` output envelope (carries the live args). */
export function mapToolCallToBeforeOutput(event: ToolCallEvent): ToolExecuteBeforeOutput {
  return {
    args: (event.input ?? {}) as Record<string, unknown>,
  };
}

/**
 * Build the `tool.execute.after` input envelope from a PI `tool_result`.
 *
 * OMP 17's unified `edit` tool accepts hashline/apply-patch text under
 * `input`, while its successful result carries authoritative paths and
 * operations in `details`. Translate those details into the existing
 * direct/multi-edit argument shapes so the core path mapper can preserve
 * file.changed semantics. Pi events do not expose `details` and retain their
 * legacy input shape unchanged.
 */
export function mapToolResultToAfterInput(
  event: ToolResultEvent,
  sessionId: string,
): ToolExecuteAfterInput {
  return {
    tool: event.toolName,
    sessionID: sessionId,
    callID: event.toolCallId,
    args: normalizeToolResultArgs(event),
  };
}

type OmpEditResultDetail = {
  readonly path?: unknown;
  readonly sourcePath?: unknown;
  readonly op?: unknown;
  readonly move?: unknown;
  readonly isError?: unknown;
  readonly diff?: unknown;
  readonly oldText?: unknown;
  readonly newText?: unknown;
};

type OmpEditToolResult = ToolResultEvent & {
  readonly isError?: unknown;
  readonly details?: OmpEditResultDetail & {
    readonly perFileResults?: unknown;
  };
};

type OmpWriteToolResult = ToolResultEvent & {
  readonly isError?: unknown;
  readonly details?: {
    readonly resolvedPath?: unknown;
  };
};

const URI_LIKE_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function normalizeToolResultArgs(event: ToolResultEvent): Record<string, unknown> {
  const args = (event.input ?? {}) as Record<string, unknown>;
  if (event.toolName === "write") {
    const ompEvent = event as OmpWriteToolResult;
    const resolvedPath = ompEvent.details?.resolvedPath;
    if (
      typeof resolvedPath === "string" &&
      resolvedPath.trim().length > 0 &&
      !URI_LIKE_PATH_RE.test(resolvedPath)
    ) {
      return withAuthoritativeOmpMutationArgs(args, { path: resolvedPath });
    }

    const requestedPath =
      typeof args.filePath === "string" && args.filePath.trim().length > 0
        ? args.filePath
        : typeof args.file_path === "string" && args.file_path.trim().length > 0
          ? args.file_path
          : typeof args.path === "string" && args.path.trim().length > 0
            ? args.path
            : typeof args.file === "string" && args.file.trim().length > 0
              ? args.file
              : undefined;
    if (ompEvent.isError === true || (requestedPath !== undefined && URI_LIKE_PATH_RE.test(requestedPath))) {
      return withAuthoritativeOmpMutationArgs(args, { edits: [] });
    }

    return args;
  }
  if (event.toolName !== "edit") return args;

  const ompEvent = event as OmpEditToolResult;
  const details = ompEvent.details;
  if (!details || typeof details !== "object") return args;

  if (Array.isArray(details.perFileResults)) {
    const edits = details.perFileResults
      .filter((entry): entry is OmpEditResultDetail => entry !== null && typeof entry === "object")
      .filter((entry) => entry.isError !== true)
      .map(normalizeOmpEditDetail)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
    return withAuthoritativeOmpMutationArgs(args, { edits });
  }

  const hasAppliedEvidence =
    (typeof details.diff === "string" && details.diff.length > 0) ||
    typeof details.oldText === "string" ||
    typeof details.newText === "string";
  if (ompEvent.isError === true && !hasAppliedEvidence) {
    return withAuthoritativeOmpMutationArgs(args, { edits: [] });
  }

  const normalizedDetail = normalizeOmpEditDetail(details);
  return normalizedDetail ? { ...args, ...normalizedDetail } : args;
}

/**
 * OMP result details describe what actually reached disk, so requested
 * mutation paths must not survive alongside authoritative results. An empty
 * successful set must also remain a non-empty args envelope (`{ edits: [] }`)
 * so the runtime neither parses the raw request nor falls back to pending args.
 */
function withAuthoritativeOmpMutationArgs(
  args: Record<string, unknown>,
  authoritativeArgs: Record<string, unknown>,
): Record<string, unknown> {
  const {
    edits: _requestedEdits,
    input: _input,
    file: _file,
    filePath: _filePath,
    file_path: _filePathSnake,
    path: _path,
    sourcePath: _sourcePath,
    fromPath: _fromPath,
    move: _move,
    rename: _rename,
    toPath: _toPath,
    ...safeArgs
  } = args;

  return { ...safeArgs, ...authoritativeArgs };
}

function normalizeOmpEditDetail(detail: OmpEditResultDetail): Record<string, unknown> | undefined {
  if (typeof detail.path !== "string" || detail.path.trim().length === 0) return undefined;

  return {
    path: detail.path,
    ...(typeof detail.sourcePath === "string" ? { sourcePath: detail.sourcePath } : {}),
    ...(typeof detail.op === "string" ? { op: detail.op } : {}),
    ...(typeof detail.move === "string" ? { move: detail.move } : {}),
  };
}

/** Envelope for the runtime `session.idle` dispatch. */
export function buildSessionIdleEvent(sessionId: string): {
  event: { type: "session.idle"; properties: { sessionID: string } };
} {
  return {
    event: { type: "session.idle", properties: { sessionID: sessionId } },
  };
}

/** Envelope for the runtime `session.created` dispatch. */
export function buildSessionCreatedEvent(sessionId: string): {
  event: { type: "session.created"; properties: { info: { id: string } } };
} {
  // P1-3 fix: do NOT forward `header.parentSession` here. PI's
  // `parentSession` field is a FILE PATH to the parent session's JSONL
  // file, not a session ID. Forwarding it as `parentID` poisoned the
  // runtime's session-state with a non-id value and mis-classified
  // scope:main|child for forked sessions. Instead, omit it and let the
  // runtime resolve lineage lazily via `host.getRootSessionId`, which is
  // wired up to the session-lineage helper that walks parent files
  // correctly.
  return {
    event: { type: "session.created", properties: { info: { id: sessionId } } },
  };
}

/**
 * Envelope for the runtime `session.deleted` dispatch. P1-4: we forward the
 * SDK's optional `reason` field on the envelope so hook authors can tell a
 * graceful shutdown apart from PI tearing the session down for /new, /resume,
 * /fork, or /reload.
 */
export function buildSessionDeletedEvent(
  sessionId: string,
  reason: string | undefined,
): {
  event: { type: "session.deleted"; properties: { info: { id: string }; reason?: string } };
} {
  return {
    event: {
      type: "session.deleted",
      properties: {
        info: { id: sessionId },
        ...(reason ? { reason } : {}),
      },
    },
  };
}

/** Read a string `reason` field from any SDK session-lifecycle event, tolerating absence. */
export function extractReason(event: { reason?: unknown } | undefined): string | undefined {
  return typeof event?.reason === "string" ? event.reason : undefined;
}
