/**
 * PI session-lifecycle wiring: `session_start`, `session_shutdown`, and
 * `session_before_switch` handlers, plus the dedupe tombstone that absorbs
 * the duplicate session.deleted PI emits for the same logical /new, /resume,
 * /fork transition.
 *
 * Extracted from `adapter.ts` as part of the P0/P1 refactor; behaviour is
 * unchanged and the registration order matches the original adapter.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import type { getPiHooksLogger } from "../core/logger.js";
import type { HookHostKind } from "../core/host-profile.js";
import type { HooksRuntime } from "../core/runtime.js";
import {
  buildSessionCreatedEvent,
  buildSessionDeletedEvent,
  extractReason,
} from "./event-mappers.js";
import { safeGetSessionId } from "./host-adapter.js";

export interface SessionLifecycleDeps {
  /** Returns the runtime for `cwd`, lazily constructing it on first use. */
  getRuntimeFor(cwd: string): HooksRuntime;
  /** Records the freshest ExtensionContext for this cwd. */
  rememberContext(cwd: string, ctx: ExtensionContext): void;
  /** Logger reference (already constructed by the caller). */
  logger: ReturnType<typeof getPiHooksLogger>;
  /** Shared dispatch-failure reporter for adapter handlers. */
  reportDispatchFailure(
    logger: ReturnType<typeof getPiHooksLogger>,
    context: {
      cwd: string;
      event: string;
      sessionId?: string;
      details?: Record<string, unknown>;
    },
    error: unknown,
  ): void;
}

/**
 * Install `session_start`, `session_shutdown`, and `session_before_switch`
 * handlers on the given `pi`. Returns nothing — registration is the side
 * effect.
 */
export function installSessionLifecycleHandlers(
  pi: ExtensionAPI,
  deps: SessionLifecycleDeps,
  hostKind: HookHostKind = "pi",
): void {
  const { getRuntimeFor, rememberContext, logger, reportDispatchFailure } = deps;

  // P1 #4 fix: PI emits both session_before_switch AND session_shutdown for
  // the same logical /new, /resume, /fork transition. Track which session
  // ids we have already fired session.deleted for so cleanup hooks do not
  // double-run. Entries are cleared shortly after to keep the set bounded.
  const deletedSessionIds = new Set<string>();
  let lastLifecycleHandledOmpSessionId: string | undefined;
  let pendingOmpSwitch:
    | { readonly cwd: string; readonly sessionId: string; readonly reason?: string }
    | undefined;
  function markSessionDeleted(sessionId: string): boolean {
    if (deletedSessionIds.has(sessionId)) return false;
    deletedSessionIds.add(sessionId);
    if (lastLifecycleHandledOmpSessionId === sessionId) lastLifecycleHandledOmpSessionId = undefined;
    // Drop the marker after a few seconds — long enough to absorb the
    // before_switch/shutdown pair, short enough not to leak forever.
    setTimeout(() => deletedSessionIds.delete(sessionId), 5_000).unref?.();
    return true;
  }

  const dispatchSessionDeleted = async (
    cwd: string,
    sessionId: string,
    reason: string | undefined,
    details?: Record<string, unknown>,
  ): Promise<void> => {
    if (!markSessionDeleted(sessionId)) return;
    try {
      const runtime = getRuntimeFor(cwd);
      await runtime.event(buildSessionDeletedEvent(sessionId, reason));
    } catch (error) {
      reportDispatchFailure(
        logger,
        {
          cwd,
          event: "session.deleted",
          sessionId,
          ...(details ? { details } : reason ? { details: { reason } } : {}),
        },
        error,
      );
    }
  };

  const dispatchSessionCreated = async (ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;
    if (hostKind === "omp") {
      if (lastLifecycleHandledOmpSessionId === sessionId) return;
      lastLifecycleHandledOmpSessionId = sessionId;
    }

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
      await runtime.event(buildSessionCreatedEvent(sessionId));
    } catch (error) {
      reportDispatchFailure(logger, { cwd: ctx.cwd, event: "session.created", sessionId }, error);
    }
  };

  // ---- session_start ----
  // Pi exposes explicit new/startup reasons. OMP's startup may be reasonless;
  // explicit non-create reasons are marked handled so a following reasonless
  // start cannot misclassify reload/resume/fork/handoff as startup.
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const reason = extractReason(event);
    if (hostKind === "pi") {
      if (reason !== "new" && reason !== "startup") return;
    } else if (reason !== undefined && reason !== "new" && reason !== "startup") {
      const sessionId = safeGetSessionId(ctx.sessionManager);
      if (sessionId) lastLifecycleHandledOmpSessionId = sessionId;
      return;
    }
    await dispatchSessionCreated(ctx);
  });

  if (hostKind === "omp") {
    // OMP-only compatibility event; importing OMP runtime types here would
    // break the Pi 0.74/0.79 SDK matrix this shared adapter must preserve.
    const ompSessionEventApi = pi as unknown as {
      on(
        event: "session_switch",
        handler: (event: { reason?: unknown }, ctx: ExtensionContext) => Promise<void>,
      ): void;
    };
    ompSessionEventApi.on("session_switch", async (event, ctx): Promise<void> => {
      rememberContext(ctx.cwd, ctx);
      const completedSwitch = pendingOmpSwitch;
      pendingOmpSwitch = undefined;
      if (completedSwitch) {
        await dispatchSessionDeleted(
          completedSwitch.cwd,
          completedSwitch.sessionId,
          completedSwitch.reason,
          {
            trigger: "session_before_switch",
            ...(completedSwitch.reason ? { reason: completedSwitch.reason } : {}),
          },
        );
      }
      const reason = extractReason(event);
      if (reason === "new") {
        await dispatchSessionCreated(ctx);
        return;
      }

      // OMP emits session_switch after replacing its authoritative manager.
      // Mark the replacement session handled for non-new transitions so the
      // reasonless session_start that follows cannot create it accidentally.
      const sessionId = safeGetSessionId(ctx.sessionManager);
      if (sessionId) lastLifecycleHandledOmpSessionId = sessionId;
    });
  }

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
    if (pendingOmpSwitch?.sessionId === sessionId) pendingOmpSwitch = undefined;
    await dispatchSessionDeleted(ctx.cwd, sessionId, extractReason(event));
  });

  // ---- session_before_switch ----
  // Pi dispatches immediately and relies on the shutdown pair dedupe. OMP's
  // aggregate can still be cancelled after this handler returns, so capture
  // its old session and defer deletion until session_switch proves success.
  pi.on("session_before_switch", async (event: SessionBeforeSwitchEvent, ctx: ExtensionContext): Promise<void> => {
    rememberContext(ctx.cwd, ctx);
    const sessionId = safeGetSessionId(ctx.sessionManager);
    if (!sessionId) return;
    const reason = extractReason(event);
    if (hostKind === "omp") {
      pendingOmpSwitch = { cwd: ctx.cwd, sessionId, ...(reason ? { reason } : {}) };
      return;
    }

    await dispatchSessionDeleted(
      ctx.cwd,
      sessionId,
      reason,
      { trigger: "session_before_switch", ...(reason ? { reason } : {}) },
    );
  });
}
