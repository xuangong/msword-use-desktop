/**
 * Single normalized event type that captures everything that happens during
 * a chat session — agent streaming, tool calls, tool results, sidecar driver
 * traffic, system messages, errors. The discriminant `kind` is the routing
 * key for filtering (debug panel) and rendering (chat bubbles vs raw rows).
 *
 * Pattern borrowed from a2aDebugApp's `JsonRpcLogEntry` (single struct with
 * `direction` discriminant + cross-link ids).
 */

export interface DebugEventBase {
  /** Auto-generated id, unique per event for React keys + scrollIntoView. */
  id: string;
  /** Wall-clock ms when this event was created on the React side. */
  ts: number;
  /** Which chat session this belongs to. spotlight-issued chat creates one. */
  sessionId: string;
  /** Chat message id this event relates to (e.g. an Anthropic message_id).
   * Multiple events share a messageId; used to render a single ChatTurn. */
  messageId?: string;
}

export type DebugEvent =
  | (DebugEventBase & { kind: "user_message"; text: string })
  | (DebugEventBase & { kind: "text_delta"; text: string })
  | (DebugEventBase & {
      kind: "tool_call";
      toolUseId: string;
      name: string;
      input: unknown;
    })
  | (DebugEventBase & {
      kind: "tool_result";
      toolUseId: string;
      name: string;
      result: unknown;
      ok: boolean;
    })
  | (DebugEventBase & { kind: "done"; stopReason: string | null; finalText: string })
  | (DebugEventBase & { kind: "error"; error: string })
  | (DebugEventBase & { kind: "system"; text: string; severity?: "info" | "warn" | "error" })
  | (DebugEventBase & {
      kind: "driver_send";
      method: string;
      params?: unknown;
      requestId?: string;
    })
  | (DebugEventBase & {
      kind: "driver_recv";
      requestId?: string;
      result?: unknown;
      error?: string | null;
    })
  | (DebugEventBase & {
      kind: "llm_request";
      model: string;
      system: string;
      messages: unknown;
      tools: unknown;
      cacheSystem: boolean;
      maxTokens: number;
    })
  | (DebugEventBase & {
      kind: "llm_response";
      stopReason: string | null;
      text: string;
      toolUses: unknown;
      usage?: unknown;
    });

export type DebugEventKind = DebugEvent["kind"];

/**
 * Aggregated narrative of one user-message → agent-reply unit. Events with the
 * same messageId roll up into one ChatTurn for the main chat view. The debug
 * panel still has access to the raw events.
 */
export interface ChatTurn {
  /** The chat session this turn lives in. */
  sessionId: string;
  /** Stable id for this turn (= the messageId of the agent reply, or
   * a synthetic id stamped at user-message time). */
  id: string;
  /** Wall-clock ms when the turn started. */
  startedAt: number;
  /** What the user said. */
  userText: string;
  /** Streaming-aggregated text from the agent (concat of text_delta events). */
  assistantText: string;
  /** Tool calls in arrival order. ToolCall.result fills in when tool_result arrives. */
  toolCalls: ToolCall[];
  /** stop_reason of the agent turn (set on `done`). null = still in progress. */
  stopReason: string | null;
  /** Last error if any. */
  error?: string;
  /** True until we see a `done` event for this turn. */
  streaming: boolean;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  /** Becomes non-undefined when the matching tool_result arrives. */
  result?: unknown;
  /** Succeeded / failed flag; undefined if still running. */
  ok?: boolean;
  startedAt: number;
}

/**
 * "What Word document was this session linked to, and what was selected?"
 * Stored per-session so switching sessions shows the right context for that
 * session's history, not just the live state.
 */
export interface WordContextSnapshot {
  /** Document name (e.g. "gongwen_sample.docx"). */
  docName?: string | null;
  /** Total documents open in this Word instance. */
  docCount?: number;
  /** Word version (e.g. "16.0"). */
  version?: string;
  /** Trigger window title captured by Rust at hotkey time. */
  triggerTitle?: string;
  /** Trigger window class — "OpusApp" means it's a Word window. */
  triggerClass?: string;
  /** Selection text — null if no selection. */
  selectionText?: string | null;
  /** 1-based paragraph index of the selection start. */
  paragraphIndex?: number | null;
  /** Last refresh timestamp. */
  refreshedAt?: number;
  /** Last error if any. */
  error?: string;
  /** What initiated this snapshot. */
  source?: "init" | "manual" | "spotlight" | "post-chat";
}
