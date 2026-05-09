/**
 * PI adapter for pi-yaml-hooks.
 *
 * Loads hooks.yaml via `core/load-hooks.ts`, constructs the core runtime via
 * `createHooksRuntime`, and forwards every relevant PI event into the
 * runtime's `tool.execute.before` / `tool.execute.after` / `event` dispatch
 * surface.
 *
 * file.changed is synthesized from `tool_result` events for the PI built-in
 * `write` and `edit` tools so that YAML-defined `file.changed` hooks fire on
 * file mutations.
 *
 * Windows guardrail: the bash executor depends on a POSIX bash on PATH. On
 * win32 we emit one warning and register nothing.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import path from "node:path";
import { getPiHooksLogger } from "../core/logger.js";
import { formatHookLoadSummary, loadDiscoveredHooksSnapshot } from "../core/load-hooks.js";
import {
  createHooksRuntime,
  type HooksRuntime,
  type ToolExecuteAfterInput,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
} from "../core/runtime.js";
import { sendHookDiagnostics } from "./diagnostics.js";
import {
  createHostAdapter,
  debugLog,
  isStaleSessionBoundError,
  type ReadonlySessionManager,
  safeGetSessionId,
} from "./host-adapter.js";
import { registerUserBashInterception } from "./user-bash.js";

export { createHostAdapter } from "./host-adapter.js";

/**
 * Register the PI adapter on the given extension API.
 *
 * Installs:
 * - `tool_call`    → runtime `tool.execute.before` (+ block-tool response)
 * - `tool_result`  → Phase 1 snapshot-hook + runtime `tool.execute.after`
 * - `agent_end`    → runtime `session.idle` (when idle + no pending messages)
 * - `session_start`→ runtime `session.created` (on new/startup)
 * - `session_shutdown` / `session_before_switch`
 *                  → Phase 1 worker flush + runtime `session.deleted`
 *                    (lossy compat shim: PI emits these on /new, /resume,
 *                    /fork too — we cannot distinguish them by source event,
 *                    but PI tags each with a `reason` field which we
 *                    forward verbatim on the envelope so hook authors can
 *                    tell graceful shutdowns from session-replacement)
 */
export function registerAdapter(pi: ExtensionAPI): void {
  const logger = getPiHooksLogger();

  if (process.platform === "win32") {
    // eslint-disable-next-line no-console
    console.warn(
      "[pi-yaml-hooks] bash hooks require a POSIX bash on PATH; Windows is unsupported. Extension is a no-op.",
    );
    logger.warn("adapter_disabled", "Windows is unsupported; extension registered as a no-op.", {
      details: { platform: process.platform },
    });
    return;
  }

  // P1 #8 fix: matchesAnyPath / matchesAllPaths conditions use node:path
  // matchesGlob, which exists from Node 22.0.0. Older Node throws TypeError
  // inside shouldRunHook's catch block, silently making path-conditioned
  // hooks never match. Fail loudly at startup instead.
  if (typeof (path as { matchesGlob?: unknown }).matchesGlob !== "function") {
    // eslint-disable-next-line no-console
    console.error(
      `[pi-yaml-hooks] node:path.matchesGlob is unavailable on this Node runtime (${process.version}). ` +
        `pi-yaml-hooks requires Node >= 22.0.0 for path conditions to work. Extension is a no-op.`,
    );
    logger.error("adapter_disabled", "node:path.matchesGlob is unavailable; extension registered as a no-op.", {
      details: { nodeVersion: process.version },
    });
    return;
  }

  logger.info("adapter_start", "PI hooks adapter initialized.", {
    details: { platform: process.platform, nodeVersion: process.version },
  });

  // Runtime is created lazily on the first event so that `ctx.cwd` is
  // available and we honour the project's hooks.yaml location. Once built,
  // we cache the runtime keyed by cwd so subsequent cwd changes in the same
  // process (should PI ever support that) pick up the right project config.
  //
  // P2 #18: bound the runtime + latestContexts maps with an LRU eviction so
  // long-lived processes that move between many directories (e.g. monorepo
  // tooling) do not retain runtimes for cwds we will never see again. Maps
  // preserve insertion order, so we promote on access by re-setting the key.
  const runtimes = new Map<string, HooksRuntime>();
  // P2-23: track cwds whose runtime construction is currently in-flight so
  // a re-entrant call (e.g. an early hook firing during construction) can
  // see and reuse the partially-built runtime instead of triggering a
  // second `loadDiscoveredHooksSnapshot` + `createHooksRuntime`. Today
  // construction is synchronous so reentry is the only realistic dual-load
  // path; if we ever make `loadDiscoveredHooksSnapshot` async, this slot
  // also gives us a place to stash the in-flight Promise.
  const constructingRuntimes = new Set<string>();
  const callIdsToSessionIds = new Map<string, string>();
  // Track the most recently observed ExtensionContext per cwd so that the
  // HostAdapter UI methods (notify/confirm/setStatus) can reach ctx.ui even
  // though they live outside the event handler scope. The ctx is replayed
  // for each PI event, so "last seen" is the right handle to use.
  const latestContexts = new Map<string, ExtensionContext>();
  const MAX_CWD_ENTRIES = 8;

  function touchCwd(cwd: string): void {
    // P2-6 fix: prod LRU promotion goes through the same helper used by
    // tests so the eviction policy has a single implementation.
    touchLruEntry(latestContexts, cwd);
    touchLruEntry(runtimes, cwd);
  }

  function evictIfNeeded(): void {
    // P2-6 fix: same — prod eviction reuses the shared helper. The companion
    // map keeps both maps in sync as the oldest entries are dropped.
    evictLruEntries(latestContexts, MAX_CWD_ENTRIES, runtimes);
    evictLruEntries(runtimes, MAX_CWD_ENTRIES, latestContexts);
  }
  // P1 #4 fix: PI emits both session_before_switch AND session_shutdown for
  // the same logical /new, /resume, /fork transition. Track which session
  // ids we have already fired session.deleted for so cleanup hooks do not
  // double-run. Entries are cleared shortly after to keep the set bounded.
  const deletedSessionIds = new Set<string>();
  function markSessionDeleted(sessionId: string): boolean {
    if (deletedSessionIds.has(sessionId)) return false;
    deletedSessionIds.add(sessionId);
    // Drop the marker after a few seconds — long enough to absorb the
    // before_switch/shutdown pair, short enough not to leak forever.
    setTimeout(() => deletedSessionIds.delete(sessionId), 5_000).unref?.();
    return true;
  }

  function rememberContext(cwd: string, ctx: ExtensionContext): void {
    // Promote this cwd to most-recent, then evict oldest if over the cap.
    if (latestContexts.has(cwd)) latestContexts.delete(cwd);
    latestContexts.set(cwd, ctx);
    touchCwd(cwd);
    evictIfNeeded();
  }

  function getRuntimeFor(cwd: string): HooksRuntime {
    const existing = runtimes.get(cwd);
    if (existing) {
      touchCwd(cwd);
      return existing;
    }

    // P2-23: if construction for this cwd is already in flight, refuse to
    // start a second one. Any caller that re-enters mid-construction (e.g.
    // a hook running during initial load that itself dispatches another
    // event) would otherwise trigger a duplicate `loadDiscoveredHooksSnapshot`
    // and `createHooksRuntime`. The in-flight runtime will be in `runtimes`
    // momentarily; throwing is preferable to silently returning a stale
    // runtime, since legitimate re-entry is a programming error.
    if (constructingRuntimes.has(cwd)) {
      throw new Error(
        `[pi-yaml-hooks] runtime construction is already in flight for ${cwd}; a hook fired during initial load is the most likely cause.`,
      );
    }
    constructingRuntimes.add(cwd);
    try {
      // P1 #3 fix: do not close over a particular sessionManager. Read the
      // current one from the latest ctx on every host call so /new, /resume,
      // /fork get the correct lineage.
      const getLiveSessionManager = (): ReadonlySessionManager | undefined =>
        latestContexts.get(cwd)?.sessionManager;
      const host = createHostAdapter(pi, cwd, getLiveSessionManager, () => latestContexts.get(cwd));
      const loaded = loadDiscoveredHooksSnapshot({ projectDir: cwd });
      if (loaded.errors.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `[pi-yaml-hooks] Failed to load some hooks; continuing with valid hooks:\n${loaded.errors
            .map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
            .join("\n")}`,
        );
        logger.error("config_load", "Hook loading reported validation errors.", {
          cwd,
          details: {
            files: loaded.files,
            errors: loaded.errors.map((error) => ({
              filePath: error.filePath,
              path: error.path,
              code: error.code,
              message: error.message,
            })),
          },
        });
        sendHookDiagnostics(pi, {
          title: "Hook configuration issues",
          level: "warning",
          content: `Hook loading found ${loaded.errors.length} validation issue(s). Valid hooks, if any, stayed active.`,
          sections: [
            {
              label: "Files",
              lines: loaded.files,
            },
            {
              label: "Validation errors",
              lines: loaded.errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`),
            },
          ],
        });
      }
      const summary = formatHookLoadSummary(loaded);
      // eslint-disable-next-line no-console
      console.info(summary);
      logger.info("config_load", "Hook configuration loaded.", {
        cwd,
        details: { files: loaded.files, summary, sources: loaded.sources },
      });
      const runtime = createHooksRuntime(host, {
        directory: cwd,
        hooks: loaded.hooks,
        initialSignature: loaded.signature,
        reloadDiscoveredHooks: true,
      });
      runtimes.set(cwd, runtime);
      evictIfNeeded();
      return runtime;
    } finally {
      constructingRuntimes.delete(cwd);
    }
  }

  registerUserBashInterception(pi, {
    getRuntimeFor,
    rememberContext,
    getSessionId: (ctx) => safeGetSessionId(ctx.sessionManager),
  });

  // ---- tool_call ----
  // PI's tool_call handler may return { block: true, reason } to stop
  // execution before the tool runs (see dist/core/extensions/types.d.ts:
  // ToolCallEventResult). The core runtime throws on block; we translate.
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;

    const runtime = getRuntimeFor(ctx.cwd);
    callIdsToSessionIds.set(event.toolCallId, sessionId);

    const input: ToolExecuteBeforeInput = {
      tool: event.toolName,
      sessionID: sessionId,
      callID: event.toolCallId,
    };
    const output: ToolExecuteBeforeOutput = {
      args: (event.input ?? {}) as Record<string, unknown>,
    };

    try {
      await runtime["tool.execute.before"](input, output);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debugLog(`tool.execute.before blocked ${event.toolName}: ${reason}`);
      // P2 #18 fix: blocked tool calls never produce a tool_result, so the
      // tool_result handler that normally cleans up callIdsToSessionIds will
      // never fire. Drop the entry here so the map does not leak.
      callIdsToSessionIds.delete(event.toolCallId);
      // The runtime calls host.abort() internally when a `stop` behaviour hook
      // fires; we also report the block back to PI so the tool doesn't run.
      return { block: true, reason };
    }
  });

  // ---- tool_result ----
  // Dispatch tool.after.* through the core runtime. The runtime emits
  // file.changed for mutation tools (write/edit) internally — see
  // src/core/runtime.ts:282 — so YAML file.changed hooks fire from this path.
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    // P2-7 fix: prefer the recorded callIdsToSessionIds entry over the live
    // ctx session id. The recorded entry is the session that was active
    // when the tool_call fired, which is authoritative for routing this
    // call's after-hooks. Falling back to the live ctx is only useful
    // when the call straddled a /new|/resume — and even then routing the
    // after-hook to the *new* session is incorrect, but it is at least a
    // session that exists. Live ctx is the fallback, not the primary.
    const sessionId = callIdsToSessionIds.get(event.toolCallId) ?? safeGetSessionId(ctx.sessionManager);

    if (sessionId) {
      try {
        const runtime = getRuntimeFor(ctx.cwd);
        const input: ToolExecuteAfterInput = {
          tool: event.toolName,
          sessionID: sessionId,
          callID: event.toolCallId,
          args: (event.input ?? {}) as Record<string, unknown>,
        };
        await runtime["tool.execute.after"](input);
      } catch (error) {
        reportDispatchFailure(logger, {
          cwd: ctx.cwd,
          event: `tool.after.${event.toolName}`,
          sessionId,
          details: { toolCallId: event.toolCallId },
        }, error);
      } finally {
        callIdsToSessionIds.delete(event.toolCallId);
      }
    } else {
      callIdsToSessionIds.delete(event.toolCallId);
    }
  });

  // ---- agent_end ----
  // Fire session.idle once the agent loop ends AND no messages are queued.
  pi.on("agent_end", async (_event, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;
    if (!ctx.isIdle || !ctx.isIdle()) return;
    if (ctx.hasPendingMessages && ctx.hasPendingMessages()) return;

    try {
      const runtime = getRuntimeFor(ctx.cwd);
      await runtime.event({
        event: { type: "session.idle", properties: { sessionID: sessionId } },
      });
    } catch (error) {
      reportDispatchFailure(logger, { cwd: ctx.cwd, event: "session.idle", sessionId }, error);
    }
  });

  // ---- session_start ----
  // Filter to genuine session creation (new/startup). resume/reload/fork are
  // existing sessions being re-entered; firing session.created there would
  // overfire hooks that are meant to run once per fresh session.
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    if (event.reason !== "new" && event.reason !== "startup") return;
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;

    // P1-3 fix: do NOT forward `header.parentSession` here. PI's
    // `parentSession` field is a FILE PATH to the parent session's JSONL
    // file, not a session ID. Forwarding it as `parentID` poisoned the
    // runtime's session-state with a non-id value and mis-classified
    // scope:main|child for forked sessions. Instead, omit it and let the
    // runtime resolve lineage lazily via `host.getRootSessionId`, which is
    // wired up to the session-lineage helper that walks parent files
    // correctly.
    try {
      const runtime = getRuntimeFor(ctx.cwd);
      await runtime.event({
        event: {
          type: "session.created",
          properties: { info: { id: sessionId } },
        },
      });
    } catch (error) {
      reportDispatchFailure(logger, { cwd: ctx.cwd, event: "session.created", sessionId }, error);
    }
  });

  // ---- session_shutdown ----
  // P1-4 fix: forward the SDK's `reason` field on the envelope so hook
  // authors can distinguish a graceful shutdown ("quit") from PI internally
  // tearing down for /new, /resume, /fork, or /reload. session_shutdown
  // also fires on terminal exit; the runtime re-entry after the process
  // dies is harmless.
  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;
    if (!markSessionDeleted(sessionId)) return; // already fired via before_switch

    const reason = typeof event?.reason === "string" ? event.reason : undefined;
    try {
      const runtime = getRuntimeFor(ctx.cwd);
      await runtime.event({
        event: {
          type: "session.deleted",
          properties: {
            info: { id: sessionId },
            ...(reason ? { reason } : {}),
          },
        },
      });
    } catch (error) {
      reportDispatchFailure(
        logger,
        {
          cwd: ctx.cwd,
          event: "session.deleted",
          sessionId,
          ...(reason ? { details: { reason } } : {}),
        },
        error,
      );
    }
  });

  // ---- session_before_switch ----
  // P1-4 fix: forward the SDK's `reason` ("new" | "resume") on the envelope.
  // session_shutdown also fires for the same logical transition; whichever
  // arrives first wins (markSessionDeleted dedupes), so the reason actually
  // delivered to hooks may be either of the two.
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;
    if (!markSessionDeleted(sessionId)) return; // session_shutdown already fired

    const reason = typeof event?.reason === "string" ? event.reason : undefined;
    try {
      const runtime = getRuntimeFor(ctx.cwd);
      await runtime.event({
        event: {
          type: "session.deleted",
          properties: {
            info: { id: sessionId },
            ...(reason ? { reason } : {}),
          },
        },
      });
    } catch (error) {
      reportDispatchFailure(
        logger,
        {
          cwd: ctx.cwd,
          event: "session.deleted",
          sessionId,
          details: { trigger: "session_before_switch", ...(reason ? { reason } : {}) },
        },
        error,
      );
    }
  });
}

/** Backwards-compat alias for the Phase 1 export name. */
export const registerPhase1Adapter = registerAdapter;

/**
 * Promote `cwd` to most-recent. If the key exists, it is re-inserted so that
 * Map iteration order places it last (the freshest entry). Used by both the
 * production runtime (via `touchCwd`) and unit tests (via `__testing__`),
 * so the LRU eviction policy has a single source of truth (P2-6).
 */
function touchLruEntry<T>(map: Map<string, T>, cwd: string): void {
  if (!map.has(cwd)) return;
  const value = map.get(cwd) as T;
  map.delete(cwd);
  map.set(cwd, value);
}

/**
 * Drop oldest entries from `map` (and `companion`, if provided) until at
 * most `maxEntries` remain. Returns the keys that were evicted. Shared
 * between the production `evictIfNeeded` and the test surface (P2-6).
 */
function evictLruEntries<T>(
  map: Map<string, T>,
  maxEntries: number,
  companion?: Map<string, unknown>,
): string[] {
  const evicted: string[] = [];
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
    companion?.delete(oldest);
    evicted.push(oldest);
  }
  return evicted;
}

/**
 * Test-only re-export of the production LRU helpers. Tests verify the
 * eviction policy via these functions; production code uses the same
 * implementations inline (see `touchCwd` / `evictIfNeeded` above).
 *
 * Also exposes `isStaleSessionBoundError` so unit tests can pin known
 * SDK-emitted error messages against the regex (P2-9).
 */
export const __testing__ = {
  touchLruEntry,
  evictLruEntries,
  isStaleSessionBoundError,
};

export function reportDispatchFailure(
  logger: ReturnType<typeof getPiHooksLogger>,
  context: {
    cwd: string;
    event: string;
    sessionId?: string;
    details?: Record<string, unknown>;
  },
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("adapter_dispatch", "PI adapter dispatch failed.", {
    cwd: context.cwd,
    event: context.event,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    details: { ...(context.details ?? {}), error: message },
  });
  // eslint-disable-next-line no-console
  console.error(`[pi-yaml-hooks] ${context.event} dispatch failed: ${message}`);
}

function safeGetSessionId(sessionManager: ReadonlySessionManager | undefined): string | undefined {
  if (!sessionManager) return undefined;
  try {
    const id = sessionManager.getSessionId();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function isStaleSessionBoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stale|invalidated|replaced session|session-bound/i.test(message);
}

function debugLog(message: string): void {
  if (process.env.PI_YAML_HOOKS_DEBUG) {
    getPiHooksLogger().debug("adapter_debug", message)
    // eslint-disable-next-line no-console
    console.warn(`[pi-yaml-hooks] ${message}`);
  }
}
