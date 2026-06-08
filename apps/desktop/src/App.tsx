/**
 * Main window: chat history + debug events panel.
 *
 * Architecture (v0.4):
 * - All state lives in Jotai atoms keyed by sessionId. Spotlight-issued
 *   chats and main-window-issued chats share the same atoms; the spotlight
 *   creates a session id, announces it via `chat:start`, and the main
 *   window switches `currentSessionIdAtom` to it.
 * - The single ingestion point is `appendEventAtom`. Every IPC event
 *   (bun:reply, chat:start, driver_restart, etc.) is normalized into one
 *   DebugEvent and folded into ChatTurns via that atom.
 * - The chat pane reads `currentTurnsAtom`; the debug pane reads
 *   `currentEventsAtom`. Switching sessions just updates the atom — no
 *   imperative re-render plumbing.
 */

import { useEffect, useState, useRef, useMemo } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { onTauriEvent } from "./lib/onTauriEvent";
import { JsonView, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";
import {
  appendEventAtom,
  clearAllAtom,
  currentEventsAtom,
  currentSessionIdAtom,
  currentTurnsAtom,
  currentWordCtxAtom,
  sessionIdsAtom,
  setWordCtxAtom,
} from "./state/atoms";
import {
  buildCommands,
  useCommandPalette,
  type SkillEntry,
} from "./components/CommandPalette";
import { piEventToDebugEvent } from "./state/piEventBridge";
import type { ChatTurn, DebugEvent, DebugEventKind, ToolCall, WordContextSnapshot } from "./state/types";
import { rawCall } from "./rpc";

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function rememberAgentEvent(seen: Map<string, number>, key: string): boolean {
  const now = Date.now();
  if (seen.has(key)) return true;
  seen.set(key, now);

  // Keep the cache bounded. Streaming events can be numerous, but duplicate
  // IPC delivery happens immediately, so a short retention window is enough.
  if (seen.size > 5000) {
    const cutoff = now - 120_000;
    for (const [k, ts] of seen) {
      if (ts < cutoff) seen.delete(k);
    }
  }
  return false;
}

function sidecarAgentEventKey(sessionId: string, reqId: string | null, event: any): string {
  const type = event?.type ?? event?.kind ?? "unknown";
  if (type === "message_update") {
    const inner = event?.assistantMessageEvent ?? {};
    return stableKey([
      sessionId,
      reqId,
      type,
      inner.type,
      inner.contentIndex,
      inner.delta ?? inner.content ?? null,
      // Include the stream position so two natural identical deltas are not
      // collapsed. Duplicate IPC deliveries carry the same partial/message.
      inner.partial?.content ?? null,
      event?.message?.content ?? null,
    ]);
  }
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    return stableKey([
      sessionId,
      reqId,
      type,
      event?.toolCallId ?? null,
      event?.toolName ?? null,
      event?.args ?? null,
      event?.partialResult ?? null,
      event?.result ?? null,
      event?.isError ?? null,
    ]);
  }
  return stableKey([sessionId, reqId, type, event]);
}

function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = (v as Record<string, unknown>)[k];
    }
    return out;
  });
}

async function openPerfWindow() {
  const existing = await WebviewWindow.getByLabel("perf");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow("perf", {
    url: "perf.html",
    title: "性能监视器",
    width: 980,
    height: 720,
    resizable: true,
  });
  win.once("tauri://error", (e) => {
    console.error("[perf-window] failed:", e);
  });
}

interface ReferenceInfo {
  name: string;
  path: string;
  paragraphs: number;
}

const WORD_CONTEXT_SCRIPT = `
if (App == null || Doc == null) {
    return new {
        ok = false,
        error = "Word is not attached",
        docName = (string)null,
        fullName = (string)null,
        docCount = 0,
        version = (string)null,
        paragraphCount = 0,
        paragraphIndex = (int?)null,
        paragraphPreview = "",
        selectionText = (string)null,
        selectionEmpty = true,
        selectionStart = (int?)null,
        selectionEnd = (int?)null
    };
}

var sel = App.Selection;
int? idx = null;
int? selStart = null;
int? selEnd = null;
string selText = null;
bool selectionEmpty = true;
try {
    if (sel != null && sel.Range != null) {
        selStart = sel.Range.Start;
        selEnd = sel.Range.End;
        selectionEmpty = sel.Range.Start == sel.Range.End;
        selText = (sel.Text ?? "").Trim('\\r', '\\n', '\\x07');
        for (int i = 1; i <= Doc.Paragraphs.Count; i++) {
            var r = Doc.Paragraphs[i].Range;
            if (sel.Range.Start >= r.Start && sel.Range.Start <= r.End) {
                idx = i;
                break;
            }
        }
    }
} catch { }

string preview = "";
if (idx.HasValue) {
    var t = (Doc.Paragraphs[idx.Value].Range.Text ?? "").Trim('\\r', '\\n', '\\x07', ' ', '\\t');
    preview = t.Length > 120 ? t.Substring(0, 120) : t;
}

return new {
    ok = true,
    error = (string)null,
    docName = Doc.Name,
    fullName = Doc.FullName,
    docCount = App.Documents.Count,
    version = App.Version,
    paragraphCount = Doc.Paragraphs.Count,
    paragraphIndex = idx,
    paragraphPreview = preview,
    selectionText = selText,
    selectionEmpty = selectionEmpty,
    selectionStart = selStart,
    selectionEnd = selEnd
};
`;

interface WordContextResult {
  ok?: boolean;
  error?: string | null;
  docName?: string | null;
  fullName?: string | null;
  docCount?: number;
  version?: string | null;
  paragraphCount?: number;
  paragraphIndex?: number | null;
  paragraphPreview?: string | null;
  selectionText?: string | null;
  selectionEmpty?: boolean;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

function wordPatchFromResult(result: WordContextResult, source: WordContextSnapshot["source"]): Partial<WordContextSnapshot> {
  return {
    docName: result.docName ?? null,
    fullName: result.fullName ?? null,
    docCount: result.docCount,
    version: result.version ?? undefined,
    paragraphCount: result.paragraphCount,
    selectionText: result.selectionText ?? null,
    selectionEmpty: result.selectionEmpty,
    selectionStart: result.selectionStart ?? null,
    selectionEnd: result.selectionEnd ?? null,
    paragraphIndex: result.paragraphIndex ?? null,
    paragraphPreview: result.paragraphPreview ?? null,
    error: result.ok === false ? result.error ?? "Word context unavailable" : undefined,
    source,
  };
}

function pinnedTargetFromCtx(ctx: WordContextSnapshot | null): Record<string, unknown> | undefined {
  if (!ctx || typeof ctx.paragraphIndex !== "number") return undefined;
  return {
    paragraphIndex: ctx.paragraphIndex,
    docName: ctx.docName ?? undefined,
    fullName: ctx.fullName ?? undefined,
    selectionStart: ctx.selectionStart ?? undefined,
    selectionEnd: ctx.selectionEnd ?? undefined,
    selectionEmpty: ctx.selectionEmpty,
    preview: ctx.paragraphPreview ?? ctx.selectionText ?? undefined,
  };
}

function threadStatus(args: { pending: boolean; events: DebugEvent[]; turns: ChatTurn[] }): string {
  const { pending, events, turns } = args;
  const lastTurn = turns[turns.length - 1];
  let runningTool: ToolCall | undefined;
  if (lastTurn) {
    for (let i = lastTurn.toolCalls.length - 1; i >= 0; i--) {
      const tc = lastTurn.toolCalls[i]!;
      if (tc.result === undefined) {
        runningTool = tc;
        break;
      }
    }
  }
  if (pending && runningTool) return `执行 ${runningTool.name}`;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === "tool_call" && pending) return `执行 ${ev.name}`;
    if (ev.kind === "tool_result" && pending) return "处理工具结果";
    if (ev.kind === "text_delta" && pending) return "LLM 回复中";
    if (ev.kind === "error") return "失败";
    if (ev.kind === "done") return pending ? "收尾中" : "完成";
    if (ev.kind === "user_message" && pending) return "等待 LLM";
  }
  return pending ? "运行中" : "空闲";
}

export default function App() {
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [pendingRequests, setPendingRequests] = useState<Map<string, string>>(() => new Map());
  const [driverGen, setDriverGen] = useState<number | null>(null);
  const [driverReady, setDriverReady] = useState(false);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [references, setReferences] = useState<ReferenceInfo[]>([]);
  const [refBusy, setRefBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(() => buildCommands(skills), [skills]);
  const palette = useCommandPalette({
    query: input,
    commands,
    onPick: (cmd) => {
      setInput(cmd.fill);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
  });

  const turns = useAtomValue(currentTurnsAtom);
  const events = useAtomValue(currentEventsAtom);
  const wordCtx = useAtomValue(currentWordCtxAtom);
  const [currentSessionId, setCurrentSessionId] = useAtom(currentSessionIdAtom);
  const sessionIds = useAtomValue(sessionIdsAtom);
  const appendEvent = useSetAtom(appendEventAtom);
  const setWordCtx = useSetAtom(setWordCtxAtom);
  const clearAll = useSetAtom(clearAllAtom);

  const scrollRef = useRef<HTMLDivElement>(null);
  const mountedAt = useRef<number>(Date.now());
  /** Map from sidecar reply id (chat-xxx) -> sessionId */
  const idToSession = useRef<Map<string, string>>(new Map());
  /** Polls already running for a given chat id (de-dupe). */
  const polledIds = useRef<Set<string>>(new Set());
  /** Raw pi events already ingested. Guards against duplicate IPC delivery. */
  const seenAgentEvents = useRef<Map<string, number>>(new Map());
  const pendingCount = useMemo(() => {
    if (!currentSessionId) return pendingRequests.size;
    let count = 0;
    for (const sid of pendingRequests.values()) {
      if (sid === currentSessionId) count++;
    }
    return count;
  }, [currentSessionId, pendingRequests]);
  const pending = pendingCount > 0;
  const statusText = useMemo(() => threadStatus({ pending, events, turns }), [pending, events, turns]);

  function markPending(requestId: string, sid: string) {
    setPendingRequests((prev) => {
      const next = new Map(prev);
      next.set(requestId, sid);
      return next;
    });
  }

  function markDone(requestId: string | null | undefined) {
    if (!requestId) return;
    setPendingRequests((prev) => {
      if (!prev.has(requestId)) return prev;
      const next = new Map(prev);
      next.delete(requestId);
      return next;
    });
  }

  function markSessionDone(sid: string) {
    setPendingRequests((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [requestId, requestSid] of next) {
        if (requestSid === sid) {
          next.delete(requestId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  async function refreshWordContext(
    sid: string,
    source: WordContextSnapshot["source"] = "manual",
  ): Promise<WordContextSnapshot | null> {
    try {
      const result = (await rawCall(WORD_CONTEXT_SCRIPT)) as WordContextResult;
      const patch = wordPatchFromResult(result, source);
      setWordCtx({ sessionId: sid, patch });
      return { ...(wordCtx ?? {}), ...patch, refreshedAt: Date.now() };
    } catch (err) {
      setWordCtx({
        sessionId: sid,
        patch: {
          error: `context refresh failed: ${String(err)}`,
          source,
        },
      });
      return wordCtx ?? null;
    }
  }

  async function stopCurrentThread() {
    if (!currentSessionId || !pending) return;
    try {
      await invoke("bun_send", {
        line: JSON.stringify({ kind: "abort", sessionId: currentSessionId }),
      });
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: currentSessionId,
        kind: "system",
        text: "已请求停止当前 thread",
        severity: "warn",
      });
    } catch (err) {
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: currentSessionId,
        kind: "system",
        text: `停止失败: ${err}`,
        severity: "error",
      });
    } finally {
      markSessionDone(currentSessionId);
    }
  }

  // ---- IPC ingestion ----

  useEffect(() => {
    // Subscribe via the module-level singleton so StrictMode double-mount,
    // HMR remounts, and dependency-array changes can never produce >1 Tauri
    // listener for the same channel. Cleanup is synchronous (Set.delete).
    const offReply = onTauriEvent<string>("bun:reply", (payload) => {
      try {
        const msg = JSON.parse(payload);
        handleSidecarReply(msg);
      } catch {
        /* not JSON, ignore */
      }
    });
    const offLog = onTauriEvent<string>("bun:log", (payload) => {
      if (/error|fail|panic|exit|timeout/i.test(payload)) {
        const sid = currentSessionId ?? "global";
        appendEvent({
          id: rid(),
          ts: Date.now(),
          sessionId: sid,
          kind: "system",
          text: payload,
          severity: "error",
        });
      }
    });
    return () => {
      offReply();
      offLog();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  // Spotlight-initiated chats: receive sessionId + user message + trigger.
  useEffect(() => {
    const off = onTauriEvent<{
      id: string;
      message: string;
      sessionId?: string;
      trigger?: { title?: string; class?: string; isWord?: boolean; pid?: number };
    }>("chat:start", (payload) => {
      const { id, message, sessionId: spotlightSid, trigger } = payload;
      const sid = spotlightSid ?? `s-${rid()}`;
      idToSession.current.set(id, sid);
      setCurrentSessionId(sid);
      // Stamp the session's Word context with what Rust captured at hotkey time.
      // Selection text comes later via observe.selection (driver call).
      if (trigger) {
        setWordCtx({
          sessionId: sid,
          patch: {
            triggerTitle: trigger.title,
            triggerClass: trigger.class,
            source: "spotlight",
          },
        });
      }
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        messageId: id,
        kind: "user_message",
        text: message,
      });
      markPending(id, sid);
      startPollChat(id, sid);
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount, sync sidecar status (HMR-safe) + register as reply subscriber.
  useEffect(() => {
    invoke("register_subscriber", { name: "main" }).catch(() => {});
    invoke<{ ready: boolean; gen: number }>("app_status")
      .then((s) => {
        if (s.ready) {
          setDriverReady(true);
          setDriverGen(s.gen);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!currentSessionId || !driverReady) return;
    void refreshWordContext(currentSessionId, "manual");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, driverReady]);

  function handleSidecarReply(msg: any) {
    // Prefer sessionId carried in the envelope (pi-shaped events). Fall back
    // to the legacy idToSession map for v0.3-style replies that didn't carry
    // sessionId. Phase 7 cleanup will assess removing the map.
    const envSid: string | undefined = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    const sid =
      envSid ?? (msg.id && idToSession.current.get(msg.id)) ?? currentSessionId ?? "global";

    if (msg.ready) {
      setDriverReady(true);
      setDriverGen(msg.gen ?? 1);
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "system",
        text: `驱动就绪 gen=${msg.gen ?? "?"}`,
        severity: "info",
      });
      return;
    }
    if (msg.kind === "driver_restart") {
      setDriverGen(msg.to ?? null);
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "system",
        text: `⚠️ 驱动重启 gen ${msg.from} → ${msg.to}(${msg.reason ?? "?"})`,
        severity: "warn",
      });
      return;
    }
    if (msg.gen != null) setDriverGen(msg.gen);

    // Sidecar broadcasts its skills inventory at startup and after every
    // /reload-skills — track it so the command palette stays in sync.
    if (msg.kind === "skills:list" && Array.isArray(msg.skills)) {
      setSkills(msg.skills as SkillEntry[]);
      return;
    }
    if (msg.kind === "skills:reloaded") {
      const txt =
        `↻ skills reloaded: ${msg.before} → ${msg.after}` +
        (msg.diagnostics > 0 ? ` (${msg.diagnostics} warning)` : "");
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "system",
        text: txt,
        severity: "info",
      });
      return;
    }
    if (msg.kind === "references:list" && Array.isArray(msg.references)) {
      setReferences(msg.references as ReferenceInfo[]);
      return;
    }
    if (msg.kind === "chat:steered") {
      markDone(msg.id);
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        messageId: msg.id,
        kind: "done",
        stopReason: "steered",
        finalText: "",
      });
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        messageId: msg.id,
        kind: "system",
        text: `补充上下文已插入当前 loop${msg.targetId ? ` (${msg.targetId})` : ""}`,
        severity: "info",
      });
      return;
    }
    if (msg.kind === "reference:attached" && msg.reference) {
      const r = msg.reference as ReferenceInfo;
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "system",
        text: msg.reused ? `📎 已使用现有参考: ${r.name}` : `📎 已附加参考: ${r.name} (${r.paragraphs} 段)`,
        severity: "info",
      });
      return;
    }
    if (msg.kind === "reference:detached") {
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "system",
        text: `📎 已移除参考: ${msg.name}`,
        severity: "info",
      });
      return;
    }

    // pi-shaped agent event envelope: {sessionId, id, kind:"agent_event", event:<piEvent>}
    if (msg.kind === "agent_event" && msg.event) {
      const reqId: string | null = typeof msg.id === "string" ? msg.id : null;
      if (rememberAgentEvent(seenAgentEvents.current, sidecarAgentEventKey(sid, reqId, msg.event))) {
        return;
      }
      const debugEv = piEventToDebugEvent(
        { sessionId: sid, id: reqId, kind: "agent_event", event: msg.event },
        { reqId },
      );
      if (debugEv) {
        appendEvent(debugEv);
        // Mark only this request as no-longer-pending. Supplemental messages
        // may already be queued for the same session.
        if (debugEv.kind === "done" || debugEv.kind === "error") {
          markDone(reqId);
        }
        // Side effects for tool_call inputs and tool_result previews —
        // preserved from the v0.3 ingest path because the spotlight UI relies
        // on the Word context strip being kept in sync.
        if (debugEv.kind === "tool_call") {
          const inp: any = debugEv.input;
          if (inp && typeof inp === "object") {
            const patch: Partial<WordContextSnapshot> = {};
            if (typeof inp.paragraph_index === "number") {
              patch.paragraphIndex = inp.paragraph_index;
            }
            if (Object.keys(patch).length > 0) {
              setWordCtx({ sessionId: sid, patch });
            }
          }
        } else if (debugEv.kind === "tool_result") {
          const r: any = debugEv.result;
          if (r && typeof r === "object" && r.preview_original) {
            setWordCtx({
              sessionId: sid,
              patch: {
                selectionText: r.preview_original,
                paragraphIndex: r.paragraph_index ?? null,
              },
            });
          }
          void refreshWordContext(sid, "post-chat");
        }
      }
      return;
    }

    // Raw response (sidecar broadcasts driver RPC results). The spotlight
    // window consumes its own raw replies; main window can ignore.
    if (msg.kind === "raw_response") {
      markDone(msg.id);
      return;
    }

    // Driver RPC reply (raw) — kept for `/<method>` slash-command flow.
    if (msg.id && msg.result != null) {
      markDone(msg.id);
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "driver_recv",
        requestId: msg.id,
        result: msg.result,
        error: null,
      });
    } else if (msg.error) {
      markDone(msg.id);
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "driver_recv",
        requestId: msg.id,
        error: msg.error,
      });
    }
  }

  // ---- chat poll (Tauri 2 emit_to → listen unreliable in this webview) ----

  function startPollChat(chatId: string, sid: string) {
    if (polledIds.current.has(chatId)) return;
    polledIds.current.add(chatId);
    let done = false;
    const tick = async () => {
      if (done) return;
      const replies = await invoke<string[]>("spotlight_take_reply", {
        subscriber: "main",
        id: chatId,
      }).catch(() => [] as string[]);
      for (const raw of replies) {
        try {
          const msg = JSON.parse(raw);
          // Maintain id→session lookup so the bun:reply listener (which is the
          // SOLE event-dispatch path) can resolve sessionId. Do NOT call
          // handleSidecarReply here — the listener already did that. Calling it
          // a second time would double-append every text_delta. The polling
          // path exists ONLY to drain this subscriber queue (otherwise it grows
          // unbounded) and to detect the agent_end / error stop signal so we
          // can clean up this request's pending marker.
          if (msg.id) idToSession.current.set(msg.id, sid);
          if (msg.kind === "chat:steered" || msg.kind === "raw_response" || msg.kind === "error") {
            done = true;
          }
          // Pi-shaped events use `event.type`; v0.3 used `event.kind`. Accept both
          // for resilience while the bridge phase settles.
          if (msg.kind === "agent_event") {
            const t = msg.event?.type ?? msg.event?.kind;
            if (t === "agent_end" || t === "error" || t === "done") {
              done = true;
            }
          }
        } catch { /* ignore */ }
      }
      if (!done) {
        setTimeout(tick, 100);
      } else {
        polledIds.current.delete(chatId);
        markDone(chatId);
      }
    };
    setTimeout(tick, 50);
  }

  // ---- main-window send ----

  async function send(textOverride?: string) {
    const line = (textOverride ?? input).trim();
    if (!line) return;
    const wasPending = pending;
    if (!textOverride) setInput("");
    setLastSent(line);

    const isRaw = line.startsWith("/");
    const id = `chat-${rid()}`;
    // Use existing session if any, else create a new one.
    const sid = currentSessionId ?? `s-${rid()}`;
    if (!currentSessionId) setCurrentSessionId(sid);
    idToSession.current.set(id, sid);

    // Built-in command: /reload-skills — fan out to sidecar protocol directly,
    // do NOT route through driver RPC (the sidecar will broadcast skills:list +
    // skills:reloaded, which the bun:reply listener picks up).
    if (line === "/reload-skills") {
      try {
        await invoke("bun_send", {
          line: JSON.stringify({ kind: "reload-skills", id }),
        });
      } catch (err) {
        appendEvent({
          id: rid(),
          ts: Date.now(),
          sessionId: sid,
          kind: "system",
          text: `invoke failed: ${err}`,
          severity: "error",
        });
      }
      return;
    }

    // /skill:<name> [args] — treat as a chat message; the sidecar's
    // expandSkillCommand prepends the formatted SKILL.md so the LLM sees it
    // without an extra read() call.
    const isSkillCmd = /^\/skill:[\w-]+/.test(line);
    if (isSkillCmd) {
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        messageId: id,
        kind: "user_message",
        text: line,
      });
      markPending(id, sid);
      try {
        const ctxForRequest = await refreshWordContext(sid, "manual");
        const pinnedTarget = pinnedTargetFromCtx(ctxForRequest ?? wordCtx);
        const payload: any = {
          kind: "chat",
          id,
          sessionId: sid,
          mode: wasPending ? "steer" : "prompt",
          message: line,
        };
        if (pinnedTarget) payload.pinnedTarget = pinnedTarget;
        await invoke("bun_send", { line: JSON.stringify(payload) });
        startPollChat(id, sid);
      } catch (err) {
        appendEvent({
          id: rid(),
          ts: Date.now(),
          sessionId: sid,
          kind: "system",
          text: `invoke failed: ${err}`,
          severity: "error",
        });
        markDone(id);
      }
      return;
    }

    if (isRaw) {
      const parts = line.slice(1).split(/\s+/);
      const method = parts[0];
      let params: any = {};
      if (parts.length > 1) {
        try {
          params = JSON.parse(parts.slice(1).join(" "));
        } catch {
          params = {};
        }
      }
      const code =
        params == null || (typeof params === "object" && Object.keys(params).length === 0)
          ? method
          : `${method}:${JSON.stringify(params)}`;
      const payload = { kind: "raw", id, code };
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "driver_send",
        method: method ?? "",
        params,
        requestId: id,
      });
      markPending(id, sid);
      try {
        await invoke("bun_send", { line: JSON.stringify(payload) });
      } catch (err) {
        appendEvent({
          id: rid(),
          ts: Date.now(),
          sessionId: sid,
          kind: "system",
          text: `invoke failed: ${err}`,
          severity: "error",
        });
        markDone(id);
      }
    } else {
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        messageId: id,
        kind: "user_message",
        text: line,
      });
      markPending(id, sid);
      try {
        const ctxForRequest = await refreshWordContext(sid, "manual");
        const pinnedTarget = pinnedTargetFromCtx(ctxForRequest ?? wordCtx);
        const payload: any = {
          kind: "chat",
          id,
          sessionId: sid,
          mode: wasPending ? "steer" : "prompt",
          message: line,
        };
        if (pinnedTarget) payload.pinnedTarget = pinnedTarget;
        await invoke("bun_send", { line: JSON.stringify(payload) });
        startPollChat(id, sid);
      } catch (err) {
        appendEvent({
          id: rid(),
          ts: Date.now(),
          sessionId: sid,
          kind: "system",
          text: `invoke failed: ${err}`,
          severity: "error",
        });
        markDone(id);
      }
    }
  }

  // Auto-scroll only when near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [turns]);

  async function attachReference() {
    if (refBusy) return;
    setRefBusy(true);
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Word", extensions: ["docx", "doc"] }],
      });
      if (!picked) return;
      const path = typeof picked === "string" ? picked : Array.isArray(picked) ? picked[0] : null;
      if (!path) return;
      const id = `ref-${rid()}`;
      await invoke("bun_send", {
        line: JSON.stringify({ kind: "attach-reference", id, path }),
      });
    } catch (err) {
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: currentSessionId ?? "global",
        kind: "system",
        text: `参考文档附加失败: ${err}`,
        severity: "error",
      });
    } finally {
      setRefBusy(false);
    }
  }

  async function detachReference(name: string) {
    const id = `ref-${rid()}`;
    try {
      await invoke("bun_send", {
        line: JSON.stringify({ kind: "detach-reference", id, name }),
      });
    } catch (err) {
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: currentSessionId ?? "global",
        kind: "system",
        text: `参考文档移除失败: ${err}`,
        severity: "error",
      });
    }
  }

  return (
    <main className="h-full flex flex-col bg-neutral-50 text-neutral-900">
      <header className="px-4 py-3 border-b border-neutral-200 bg-white flex items-center gap-2 shrink-0 overflow-hidden">
        <div className="flex items-baseline gap-2 shrink-0 min-w-0">
          <h1 className="text-lg font-semibold whitespace-nowrap">msword-use</h1>
          <p className="hidden lg:block text-xs text-neutral-500 whitespace-nowrap">
            v2-alpha · 自然语言操作 Word · 修订模式
          </p>
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
            className="text-xs px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50 text-neutral-700"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            菜单 ▾
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute left-0 top-full mt-1 z-50 bg-white border border-neutral-200 rounded shadow-lg min-w-[160px] py-1 text-sm"
            >
              <button
                role="menuitem"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                  void openPerfWindow();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100"
              >
                性能监视器
              </button>
            </div>
          )}
        </div>
        {sessionIds.length > 0 && (
          <select
            value={currentSessionId ?? ""}
            onChange={(e) => setCurrentSessionId(e.currentTarget.value || null)}
            className="text-xs border border-neutral-300 rounded px-1.5 py-0.5 bg-white"
            title="切换会话"
          >
            {sessionIds.map((id, i) => (
              <option key={id} value={id}>
                会话 {i + 1}
              </option>
            ))}
          </select>
        )}
        <WordCtxBar
          ctx={wordCtx}
          onRefresh={() => {
            if (currentSessionId && driverReady) void refreshWordContext(currentSessionId, "manual");
          }}
        />
        <div className="hidden xl:flex items-center gap-1.5 shrink-0 overflow-hidden max-w-[20rem]">
          {references.map((r) => (
            <span
              key={r.name}
              className="text-xs bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 text-emerald-800 flex items-center gap-1 shrink-0"
              title={r.path}
            >
              <span>📎</span>
              <span className="font-medium truncate max-w-[140px]">{r.name}</span>
              <span className="text-emerald-600">· {r.paragraphs} 段</span>
              <button
                type="button"
                onClick={() => detachReference(r.name)}
                className="text-emerald-600 hover:text-red-600 ml-0.5"
                title="移除"
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={attachReference}
            disabled={refBusy || !driverReady}
            className="text-xs border border-dashed border-neutral-300 rounded px-1.5 py-0.5 text-neutral-600 hover:bg-neutral-50 hover:border-neutral-400 disabled:opacity-30"
            title="附加参考文档（只读，仅作为参考；当前文档才是修改目标）"
          >
            + 参考文档
          </button>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs shrink-0">
          <button
            type="button"
            onClick={clearAll}
            disabled={sessionIds.length === 0}
            className="text-neutral-500 hover:text-neutral-900 disabled:opacity-30"
            title="清空所有会话"
          >
            🗑 清空
          </button>
          <span className={driverReady ? "text-green-700" : "text-amber-600"}>
            <span
              className={
                "inline-block w-1.5 h-1.5 rounded-full mr-1 " +
                (driverReady ? "bg-green-500" : "bg-amber-500 animate-pulse")
              }
            />
            驱动 {driverReady ? `gen=${driverGen ?? "?"}` : <BootTimer startedAt={mountedAt.current} />}
          </span>
          <span className="hidden 2xl:inline text-neutral-400 whitespace-nowrap">
            指令前加 <code className="bg-neutral-100 px-1 rounded">/</code> 走原始 RPC
          </span>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: chat */}
        <div className="flex-1 flex flex-col min-w-0">
          <section ref={scrollRef} className="flex-1 p-4 overflow-auto space-y-4">
            {turns.length === 0 ? (
              <div className="text-neutral-400 text-sm">
                试试：在 Word 里选段，按 <kbd className="bg-neutral-100 px-1 rounded">Ctrl+Alt+J</kbd>{" "}
                唤起 spotlight 输入指令。或在下方输入框直接打 <span className="font-mono">"把这段改成公文"</span>。
              </div>
            ) : (
              turns.map((t) => <TurnView key={t.id} turn={t} />)
            )}
          </section>

          <form
            className="p-3 border-t border-neutral-200 bg-white flex flex-col gap-2 shrink-0"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {palette.render()}
            <div className="flex gap-2 items-center">
              <input
                ref={inputRef}
                autoFocus
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Palette consumes ArrowUp/Down/Tab/Enter when open; otherwise
                  // falls through to form submit on Enter.
                  palette.handleKey(e);
                }}
                placeholder={pending ? "运行中，可继续补充上下文..." : "请说... (输入 / 看命令；/ping 走原始 RPC)"}
                className="flex-1 border border-neutral-300 rounded px-3 py-2 text-sm"
              />
              <span
                className={
                  "shrink-0 text-xs min-w-[5.5rem] " +
                  (pending ? "text-amber-700" : "text-neutral-500")
                }
                title="当前 thread 状态"
              >
                <span
                  className={
                    "inline-block w-1.5 h-1.5 rounded-full mr-1 " +
                    (pending ? "bg-amber-500 animate-pulse" : "bg-neutral-300")
                  }
                />
                {pendingCount > 1 ? `${statusText} +${pendingCount - 1}` : statusText}
              </span>
              {!pending && lastSent && !input && (
                <button
                  type="button"
                  onClick={() => send(lastSent)}
                  className="px-3 py-2 text-xs text-neutral-600 border border-neutral-300 rounded hover:bg-neutral-50"
                >
                  ↻ 重试
                </button>
              )}
              {pending && (
                <button
                  type="button"
                  onClick={() => void stopCurrentThread()}
                  disabled={!currentSessionId}
                  className="px-3 py-2 text-xs text-red-700 border border-red-200 rounded hover:bg-red-50 disabled:opacity-30 disabled:hover:bg-transparent"
                  title="停止当前 thread（请求 agent abort；正在执行的 Word 脚本最多等待驱动超时）"
                >
                  停止
                </button>
              )}
              <button
                type="submit"
                disabled={!input.trim()}
                className="px-4 py-2 bg-neutral-900 text-white rounded text-sm disabled:opacity-50"
              >
                {pending ? "补充" : "发送"}
              </button>
            </div>
          </form>
        </div>

        {/* Right: debug panel */}
        <aside className="w-96 border-l border-neutral-200 bg-white overflow-hidden shrink-0 flex flex-col">
          <DebugPanel events={events} />
        </aside>
      </div>
    </main>
  );
}

// ============================================================
// Chat turn renderer
// ============================================================

function TurnView({ turn }: { turn: ChatTurn }) {
  const toolById = useMemo(() => {
    const map = new Map<string, ToolCall>();
    for (const tc of turn.toolCalls) map.set(tc.toolUseId, tc);
    return map;
  }, [turn.toolCalls]);
  const blocks = turn.blocks ?? [];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.userText}
        </div>
      </div>

      {blocks.length > 0 ? (
        blocks.map((block, index) => {
          if (block.kind === "text") {
            return (
              <AssistantTextBlock
                key={block.id}
                text={block.text}
                streaming={turn.streaming && index === blocks.length - 1}
              />
            );
          }
          const tc = toolById.get(block.toolUseId);
          return tc ? <ToolCallView key={block.id} tc={tc} /> : null;
        })
      ) : (
        <>
          {turn.toolCalls.map((tc) => (
            <ToolCallView key={tc.toolUseId} tc={tc} />
          ))}
          {(turn.assistantText || turn.streaming) && (
            <AssistantTextBlock text={turn.assistantText} streaming={turn.streaming} />
          )}
        </>
      )}

      {turn.streaming && blocks.length > 0 && blocks[blocks.length - 1]?.kind === "tool" && (
        <AssistantTextBlock text="" streaming />
      )}

      {turn.error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ❌ {turn.error}
        </div>
      )}
    </div>
  );
}

function AssistantTextBlock({ text, streaming }: { text: string; streaming: boolean }) {
  if (!text && !streaming) return null;
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] bg-white border border-neutral-200 rounded-2xl rounded-tl-sm px-4 py-2 text-sm break-words assistant-md">
        {text
          ? <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
          : <span className="text-neutral-400">...</span>}
        {streaming && text && (
          <span className="text-neutral-400 animate-pulse">▍</span>
        )}
      </div>
    </div>
  );
}

function ToolCallView({ tc }: { tc: ToolCall }) {
  const [open, setOpen] = useState(false);
  const status = tc.result == null ? "pending" : tc.ok === false ? "error" : "ok";
  const dot =
    status === "ok" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-amber-500 animate-pulse";
  const summary = useMemo(() => {
    const inp = JSON.stringify(tc.input);
    return inp.length > 60 ? inp.slice(0, 60) + "…" : inp;
  }, [tc.input]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-left w-full text-xs font-mono border border-neutral-200 bg-neutral-50 rounded px-2 py-1 hover:bg-neutral-100 flex items-center gap-2"
        >
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
          <span className="text-neutral-700 font-semibold">{tc.name}</span>
          <span className="text-neutral-500 truncate flex-1">{summary}</span>
          <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="border border-t-0 border-neutral-200 rounded-b bg-white p-2 text-xs space-y-2">
            <div>
              <div className="text-neutral-500 mb-1">input:</div>
              <JsonView data={tc.input as object} style={defaultStyles} shouldExpandNode={() => true} />
            </div>
            {tc.result !== undefined && (
              <div>
                <div className="text-neutral-500 mb-1">result:</div>
                <JsonView
                  data={tc.result as object}
                  style={defaultStyles}
                  shouldExpandNode={() => true}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Debug panel (right-side)
// ============================================================

function DebugPanel({ events }: { events: DebugEvent[] }) {
  const [filter, setFilter] = useState<"all" | DebugEventKind>("all");
  const visible = useMemo(
    () => (filter === "all" ? events : events.filter((e) => e.kind === filter)),
    [events, filter],
  );
  // We render newest-first.
  const reversed = useMemo(() => [...visible].reverse(), [visible]);

  return (
    <>
      <div className="px-4 py-3 border-b border-neutral-200 flex items-center gap-2 shrink-0">
        <h2 className="text-sm font-semibold text-neutral-800">事件</h2>
        <span className="text-xs text-neutral-400">
          {visible.length}/{events.length}
        </span>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
          className="ml-auto text-xs border border-neutral-300 rounded px-1.5 py-0.5 bg-white"
        >
          <option value="all">全部</option>
          <option value="user_message">user</option>
          <option value="llm_request">llm_request</option>
          <option value="llm_response">llm_response</option>
          <option value="text_delta">text_delta</option>
          <option value="tool_call">tool_call</option>
          <option value="tool_result">tool_result</option>
          <option value="done">done</option>
          <option value="error">error</option>
          <option value="driver_send">driver_send</option>
          <option value="driver_recv">driver_recv</option>
          <option value="system">system</option>
        </select>
      </div>
      <div className="flex-1 overflow-auto">
        {reversed.length === 0 ? (
          <div className="p-4 text-xs text-neutral-400">
            暂无事件。在 Word 选段，按 Ctrl+Alt+J 唤起 spotlight。
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {reversed.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function EventRow({ ev }: { ev: DebugEvent }) {
  const [open, setOpen] = useState(false);
  const time = new Date(ev.ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const summary = summaryOf(ev);
  const cls = colorOf(ev.kind);

  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-neutral-50 text-left"
      >
        <span className="text-neutral-400 font-mono shrink-0">{time}</span>
        <span className={`font-mono px-1 rounded shrink-0 ${cls}`}>{ev.kind}</span>
        <span className="truncate text-neutral-700 flex-1">{summary}</span>
        <span className="text-neutral-300 shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 text-[10px] bg-neutral-50">
          <JsonView data={ev as unknown as object} style={defaultStyles} shouldExpandNode={() => true} />
        </div>
      )}
    </li>
  );
}

function summaryOf(ev: DebugEvent): string {
  switch (ev.kind) {
    case "user_message":
      return ev.text.slice(0, 80);
    case "text_delta":
      return JSON.stringify(ev.text);
    case "tool_call":
      return `${ev.name}(${JSON.stringify(ev.input).slice(0, 60)})`;
    case "tool_result":
      return `${ev.name} → ${ev.ok ? "ok" : "fail"}`;
    case "done":
      return `stop=${ev.stopReason}`;
    case "error":
      return ev.error;
    case "system":
      return ev.text;
    case "driver_send":
      return `→ ${ev.method}`;
    case "driver_recv":
      return ev.error ? `← error: ${ev.error}` : `← ${ev.requestId ?? "(?)"}`;
    case "llm_request": {
      const msgCount = Array.isArray(ev.messages) ? ev.messages.length : 0;
      const toolCount = Array.isArray(ev.tools) ? ev.tools.length : 0;
      return `${ev.model} · ${msgCount} msgs · ${toolCount} tools`;
    }
    case "llm_response": {
      const u: any = ev.usage ?? {};
      const cache = u.cache_read_input_tokens ? ` cache_read=${u.cache_read_input_tokens}` : "";
      return `stop=${ev.stopReason} · in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"}${cache}`;
    }
  }
}

function colorOf(kind: DebugEventKind): string {
  switch (kind) {
    case "user_message": return "text-blue-700 bg-blue-50";
    case "text_delta": return "text-neutral-600 bg-neutral-100";
    case "tool_call": return "text-purple-700 bg-purple-50";
    case "tool_result": return "text-purple-700 bg-purple-50";
    case "done": return "text-green-700 bg-green-50";
    case "error": return "text-red-700 bg-red-50";
    case "system": return "text-neutral-600 bg-neutral-100";
    case "driver_send": return "text-amber-700 bg-amber-50";
    case "driver_recv": return "text-amber-700 bg-amber-50";
    case "llm_request": return "text-indigo-700 bg-indigo-50";
    case "llm_response": return "text-indigo-700 bg-indigo-50";
  }
}

function BootTimer({ startedAt }: { startedAt: number }) {
  const [secs, setSecs] = useState(((Date.now() - startedAt) / 1000).toFixed(1));
  useEffect(() => {
    const t = setInterval(() => {
      setSecs(((Date.now() - startedAt) / 1000).toFixed(1));
    }, 100);
    return () => clearInterval(t);
  }, [startedAt]);
  return <>启动中 {secs}s…</>;
}

/** Compact "linked to <doc> · 段 N · selection" strip in the header. */
function WordCtxBar({
  ctx,
  onRefresh,
}: {
  ctx: WordContextSnapshot | null;
  onRefresh: () => void;
}) {
  if (!ctx) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="text-xs text-neutral-500 flex items-center gap-1.5 px-2 py-0.5 bg-neutral-100 rounded hover:bg-neutral-200 shrink min-w-0 whitespace-nowrap"
        title="刷新当前 Word 文档和选区"
      >
        <span>文档未刷新</span>
      </button>
    );
  }
  // Strip the trailing " - Word" so the doc name is short.
  const docName =
    ctx.docName ??
    (ctx.triggerTitle
      ? ctx.triggerTitle.replace(/\s*-\s*(Microsoft\s+)?Word\s*$/i, "")
      : null);
  const selSource = ctx.selectionText || ctx.paragraphPreview || "";
  const selPreview = selSource
    ? selSource.length > 40
      ? selSource.slice(0, 40) + "…"
      : selSource
    : null;
  const selectionLabel =
    ctx.selectionEmpty === false
      ? ctx.selectionStart != null && ctx.selectionEnd != null
        ? `选区 ${ctx.selectionStart}-${ctx.selectionEnd}`
        : "有选区"
      : ctx.paragraphIndex != null
        ? "光标"
        : "无选区";
  const updated = ctx.refreshedAt ? new Date(ctx.refreshedAt).toLocaleTimeString() : null;
  return (
    <button
      type="button"
      onClick={onRefresh}
      className={
        "text-xs text-neutral-500 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-neutral-200 shrink min-w-0 max-w-[42vw] overflow-hidden whitespace-nowrap " +
        (ctx.error ? "bg-red-50 text-red-700" : "bg-neutral-100")
      }
      title={[
        ctx.error ? `error: ${ctx.error}` : null,
        ctx.fullName ?? ctx.triggerTitle ?? null,
        updated ? `updated: ${updated}` : null,
      ].filter(Boolean).join("\n")}
    >
      <span className="text-neutral-800 font-medium truncate min-w-0 max-w-[12rem]">
        {docName ?? "(未链接文档)"}
      </span>
      {ctx.paragraphCount != null && (
        <>
          <span className="text-neutral-400 shrink-0">·</span>
          <span className="shrink-0">{ctx.paragraphCount} 段</span>
        </>
      )}
      {ctx.paragraphIndex != null && (
        <>
          <span className="text-neutral-400 shrink-0">·</span>
          <span className="shrink-0">段 {ctx.paragraphIndex}</span>
        </>
      )}
      <span className="text-neutral-400 shrink-0">·</span>
      <span className="shrink-0">{selectionLabel}</span>
      {selPreview && (
        <>
          <span className="text-neutral-400 shrink-0">·</span>
          <span className="italic text-neutral-600 truncate min-w-0 max-w-[12rem]">"{selPreview}"</span>
        </>
      )}
    </button>
  );
}
