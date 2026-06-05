/**
 * Jotai store for chat sessions + debug events.
 *
 * Pattern borrowed from a2aDebugApp's `chat-atoms.ts`: per-session Map atom
 * + derived "current session" facade. Writers (event sources from sidecar /
 * Rust IPC) just append into the map keyed by sessionId; any reader pane
 * that's showing that sessionId picks it up automatically.
 */

import { atom } from "jotai";
import type { ChatTurn, DebugEvent, ToolCall, WordContextSnapshot } from "./types";

/** Currently focused session in the main window's chat view. */
export const currentSessionIdAtom = atom<string | null>(null);

/** All known sessions, in chronological order they were first seen. */
export const sessionIdsAtom = atom<string[]>([]);

/** sessionId -> ChatTurn[] (rendered in the chat bubble area). */
export const chatTurnsBySessionAtom = atom<Map<string, ChatTurn[]>>(new Map());

/** sessionId -> DebugEvent[] (rendered in the debug panel + raw inspector). */
export const debugEventsBySessionAtom = atom<Map<string, DebugEvent[]>>(new Map());

/** sessionId -> WordContextSnapshot (which Word doc this session is linked
 * to, and what was selected when the agent ran). Updated by the spotlight
 * trigger and by the agent's own observe.selection calls. */
export const wordCtxBySessionAtom = atom<Map<string, WordContextSnapshot>>(new Map());

/** Cap per-session debug events so a long session doesn't OOM. */
const DEBUG_CAP = 1000;

// ----- derived (read-only) -----

export const currentTurnsAtom = atom((get) => {
  const id = get(currentSessionIdAtom);
  if (!id) return [];
  return get(chatTurnsBySessionAtom).get(id) ?? [];
});

export const currentEventsAtom = atom((get) => {
  const id = get(currentSessionIdAtom);
  if (!id) return [];
  return get(debugEventsBySessionAtom).get(id) ?? [];
});

export const currentWordCtxAtom = atom((get) => {
  const id = get(currentSessionIdAtom);
  if (!id) return null;
  return get(wordCtxBySessionAtom).get(id) ?? null;
});

// ----- write-only actions -----

/** Merge a partial WordContextSnapshot into the given session's ctx. */
export const setWordCtxAtom = atom(
  null,
  (get, set, payload: { sessionId: string; patch: Partial<WordContextSnapshot> }) => {
    const map = new Map(get(wordCtxBySessionAtom));
    const prev = map.get(payload.sessionId) ?? {};
    map.set(payload.sessionId, { ...prev, ...payload.patch, refreshedAt: Date.now() });
    set(wordCtxBySessionAtom, map);
  },
);

/**
 * Append a debug event AND fold it into the corresponding ChatTurn.
 * This is the single ingestion point for sidecar/IPC traffic.
 */
export const appendEventAtom = atom(null, (get, set, ev: DebugEvent) => {
  // 1. Ensure session is registered.
  const ids = get(sessionIdsAtom);
  if (!ids.includes(ev.sessionId)) {
    set(sessionIdsAtom, [...ids, ev.sessionId]);
  }

  // 2. Append to debug events map (bounded).
  const dbgMap = new Map(get(debugEventsBySessionAtom));
  const list = dbgMap.get(ev.sessionId) ?? [];
  const trimmed = list.length >= DEBUG_CAP ? list.slice(-DEBUG_CAP + 1) : list;
  dbgMap.set(ev.sessionId, [...trimmed, ev]);
  set(debugEventsBySessionAtom, dbgMap);

  // 3. Fold into ChatTurns when relevant.
  const turnsMap = new Map(get(chatTurnsBySessionAtom));
  const turns = turnsMap.get(ev.sessionId) ?? [];
  const updated = applyEventToTurns(turns, ev);
  if (updated !== turns) {
    turnsMap.set(ev.sessionId, updated);
    set(chatTurnsBySessionAtom, turnsMap);
  }
});

/**
 * Apply one event to the turn list; returns the updated list (or the same
 * reference if the event isn't turn-relevant). Pure for predictability.
 */
function applyEventToTurns(turns: ChatTurn[], ev: DebugEvent): ChatTurn[] {
  switch (ev.kind) {
    case "user_message": {
      // Start a new turn keyed by messageId (or the event id).
      const turnId = ev.messageId ?? ev.id;
      return [
        ...turns,
        {
          sessionId: ev.sessionId,
          id: turnId,
          startedAt: ev.ts,
          userText: ev.text,
          assistantText: "",
          toolCalls: [],
          stopReason: null,
          streaming: true,
        },
      ];
    }
    case "text_delta": {
      // Append to the current (last streaming) turn's assistantText.
      const idx = lastStreamingIdx(turns);
      if (idx < 0) return turns;
      const out = turns.slice();
      out[idx] = { ...out[idx]!, assistantText: out[idx]!.assistantText + ev.text };
      return out;
    }
    case "tool_call": {
      const idx = lastStreamingIdx(turns);
      if (idx < 0) return turns;
      const out = turns.slice();
      const tc: ToolCall = {
        toolUseId: ev.toolUseId,
        name: ev.name,
        input: ev.input,
        startedAt: ev.ts,
      };
      out[idx] = { ...out[idx]!, toolCalls: [...out[idx]!.toolCalls, tc] };
      return out;
    }
    case "tool_result": {
      const idx = lastStreamingIdx(turns);
      if (idx < 0) return turns;
      const turn = turns[idx]!;
      const tcIdx = turn.toolCalls.findIndex((t) => t.toolUseId === ev.toolUseId);
      if (tcIdx < 0) return turns;
      const newTcs = turn.toolCalls.slice();
      newTcs[tcIdx] = { ...newTcs[tcIdx]!, result: ev.result, ok: ev.ok };
      const out = turns.slice();
      out[idx] = { ...turn, toolCalls: newTcs };
      return out;
    }
    case "done": {
      const idx = lastStreamingIdx(turns);
      if (idx < 0) return turns;
      const out = turns.slice();
      const turn = out[idx]!;
      out[idx] = {
        ...turn,
        streaming: false,
        stopReason: ev.stopReason,
        // Prefer the final text from `done` if it's longer (covers the case
        // where text_delta events were missed for some reason).
        assistantText: ev.finalText.length > turn.assistantText.length
          ? ev.finalText
          : turn.assistantText,
      };
      return out;
    }
    case "error": {
      const idx = lastStreamingIdx(turns);
      if (idx < 0) return turns;
      const out = turns.slice();
      out[idx] = { ...out[idx]!, streaming: false, error: ev.error };
      return out;
    }
    default:
      return turns;
  }
}

function lastStreamingIdx(turns: ChatTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.streaming) return i;
  }
  // Fallback: last turn (allows text_delta to roll into a finished turn if
  // events arrive out of order — shouldn't happen but doesn't hurt).
  return turns.length - 1;
}

/** Clear all sessions (header "🗑 清空" button). */
export const clearAllAtom = atom(null, (_get, set) => {
  set(currentSessionIdAtom, null);
  set(sessionIdsAtom, []);
  set(chatTurnsBySessionAtom, new Map());
  set(debugEventsBySessionAtom, new Map());
  set(wordCtxBySessionAtom, new Map());
});
