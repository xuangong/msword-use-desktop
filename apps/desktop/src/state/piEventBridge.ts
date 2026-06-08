/**
 * Translate a pi-agent-core AgentEvent into the v0.3 DebugEvent shape that
 * the existing atoms / ChatTurn renderer consumes.
 *
 * The sidecar emits pi-native events verbatim (per spec Q5). This module is
 * the only place in the app that knows pi's event names. If pi changes the
 * event shape (minor version), the fix lives here.
 *
 * Returns null when the event is something the UI doesn't render (e.g.
 * `turn_start`, `message_end`). null is meant to be filtered out by the caller.
 */

import type { DebugEvent } from "./types";

/** Wrapper envelope written by the sidecar (apps/agent/src/index.ts). */
export interface SidecarEnvelope {
  sessionId: string;
  id: string | null;
  kind: "agent_event";
  event: PiEvent;
}

/** Subset of pi's AgentEvent we care about. Other shapes are accepted as `any`. */
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown }
  | { type: "message_start"; message?: { role?: string; content?: unknown } }
  | { type: "message_update"; message?: unknown; assistantMessageEvent?: AssistantMessageEvent }
  | { type: "message_end"; message?: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "error"; error: string }
  | { type: string; [key: string]: unknown };

export type AssistantMessageEvent =
  | { type: "text_delta"; delta?: string; content?: string }
  | { type: "text_start" | "text_end"; content?: string }
  | { type: string; [k: string]: unknown };

let nextSyntheticId = 1;
function synthId(prefix: string): string {
  return `${prefix}_${Date.now()}_${nextSyntheticId++}`;
}

export interface BridgeContext {
  /** Per-call request id from the envelope. Used as messageId so multiple
   * events from the same turn fold into one ChatTurn. */
  reqId: string | null;
}

/**
 * Convert one pi event (with envelope context) into 0..1 DebugEvent.
 * Returns null when nothing should be rendered for that event.
 */
export function piEventToDebugEvent(
  envelope: SidecarEnvelope,
  ctx: BridgeContext,
): DebugEvent | null {
  const { sessionId } = envelope;
  const event = envelope.event;
  const ts = Date.now();
  const messageId = ctx.reqId ?? undefined;

  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "message_end":
      return null;

    case "message_start": {
      // Skip ALL message_start events. Rationale:
      //   - For the user message: the UI already echoed it locally when the
      //     prompt was submitted (spotlight chat:start → App.tsx, or main
      //     window send). pi re-emits message_start every turn during a
      //     multi-turn REPL, which would duplicate the user bubble N times.
      //   - For the assistant message: text_delta / agent_end already drive
      //     the UI; an empty assistant marker would be redundant.
      // Single source of truth for user text = the original local echo.
      return null;
    }

    case "message_update": {
      const inner = (event as any).assistantMessageEvent;
      if (!inner || inner.type !== "text_delta") return null;
      const delta =
        typeof inner.delta === "string" ? inner.delta : typeof inner.content === "string" ? inner.content : "";
      if (!delta) return null;
      return {
        kind: "text_delta",
        id: synthId("delta"),
        ts,
        sessionId,
        messageId,
        text: delta,
      };
    }

    case "tool_execution_start": {
      const e = event as any;
      return {
        kind: "tool_call",
        id: synthId("tc"),
        ts,
        sessionId,
        messageId,
        toolUseId: e.toolCallId,
        name: e.toolName,
        input: e.args,
      };
    }

    case "tool_execution_end": {
      const e = event as any;
      return {
        kind: "tool_result",
        id: synthId("tr"),
        ts,
        sessionId,
        messageId,
        toolUseId: e.toolCallId,
        name: e.toolName,
        result: e.result,
        ok: !e.isError,
      };
    }

    case "agent_end": {
      return {
        kind: "done",
        id: synthId("done"),
        ts,
        sessionId,
        messageId,
        stopReason: "end_turn",
        finalText: "",
      };
    }

    case "error": {
      const e = event as any;
      return {
        kind: "error",
        id: synthId("err"),
        ts,
        sessionId,
        messageId,
        error: typeof e.error === "string" ? e.error : JSON.stringify(e.error ?? null),
      };
    }

    default:
      // Surface unrecognised events as a `system` info entry so they appear
      // in the debug panel but don't disrupt chat turns.
      return {
        kind: "system",
        id: synthId("sys"),
        ts,
        sessionId,
        messageId,
        text: `pi-event:${event.type}`,
        severity: "info",
      };
  }

  // Lifecycle events such as `turn_start` / `message_end` are intentionally
  // filtered above. They are useful protocol markers, but noisy in this UI.
}

