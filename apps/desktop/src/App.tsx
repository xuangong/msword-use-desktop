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
import { listen } from "@tauri-apps/api/event";
import { JsonView, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
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
import { piEventToDebugEvent } from "./state/piEventBridge";
import type { ChatTurn, DebugEvent, DebugEventKind, ToolCall, WordContextSnapshot } from "./state/types";

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default function App() {
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [pending, setPending] = useState(false);
  const [driverGen, setDriverGen] = useState<number | null>(null);
  const [driverReady, setDriverReady] = useState(false);

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

  // ---- IPC ingestion ----

  useEffect(() => {
    const offReply = listen<string>("bun:reply", (e) => {
      try {
        const msg = JSON.parse(e.payload);
        handleSidecarReply(msg);
      } catch {
        /* not JSON, ignore */
      }
    });
    const offLog = listen<string>("bun:log", (e) => {
      const line = e.payload;
      if (/error|fail|panic|exit|timeout/i.test(line)) {
        const sid = currentSessionId ?? "global";
        appendEvent({
          id: rid(),
          ts: Date.now(),
          sessionId: sid,
          kind: "system",
          text: line,
          severity: "error",
        });
      }
    });
    return () => {
      void offReply.then((u) => u());
      void offLog.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  // Spotlight-initiated chats: receive sessionId + user message + trigger.
  useEffect(() => {
    const off = listen<{
      id: string;
      message: string;
      sessionId?: string;
      trigger?: { title?: string; class?: string; isWord?: boolean; pid?: number };
    }>("chat:start", (e) => {
      const { id, message, sessionId: spotlightSid, trigger } = e.payload;
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
      startPollChat(id, sid);
    });
    return () => {
      void off.then((u) => u());
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

    // pi-shaped agent event envelope: {sessionId, id, kind:"agent_event", event:<piEvent>}
    if (msg.kind === "agent_event" && msg.event) {
      const reqId: string | null = typeof msg.id === "string" ? msg.id : null;
      const debugEv = piEventToDebugEvent(
        { sessionId: sid, id: reqId, kind: "agent_event", event: msg.event },
        { reqId },
      );
      if (debugEv) {
        appendEvent(debugEv);
        // Mark turn as no-longer-pending when we see a terminal event.
        if (debugEv.kind === "done" || debugEv.kind === "error") {
          setPending(false);
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
        }
      }
      return;
    }

    // Raw response (sidecar broadcasts driver RPC results). The spotlight
    // window consumes its own raw replies; main window can ignore.
    if (msg.kind === "raw_response") {
      return;
    }

    // Driver RPC reply (raw) — kept for `/<method>` slash-command flow.
    if (msg.id && msg.result != null) {
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
    const start = Date.now();
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
          // Make sure session lookup works.
          if (msg.id) idToSession.current.set(msg.id, sid);
          handleSidecarReply(msg);
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
      if (!done && Date.now() - start < 60_000) {
        setTimeout(tick, 100);
      } else {
        polledIds.current.delete(chatId);
      }
    };
    setTimeout(tick, 50);
  }

  // ---- main-window send ----

  async function send(textOverride?: string) {
    const line = (textOverride ?? input).trim();
    if (!line) return;
    if (!textOverride) setInput("");
    setLastSent(line);

    const isRaw = line.startsWith("/");
    const id = `chat-${rid()}`;
    // Use existing session if any, else create a new one.
    const sid = currentSessionId ?? `s-${rid()}`;
    if (!currentSessionId) setCurrentSessionId(sid);
    idToSession.current.set(id, sid);

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
      const payload = { id, method, params };
      appendEvent({
        id: rid(),
        ts: Date.now(),
        sessionId: sid,
        kind: "driver_send",
        method: method ?? "",
        params,
        requestId: id,
      });
      setPending(true);
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
        setPending(false);
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
      setPending(true);
      const payload = { kind: "chat", id, message: line };
      try {
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
        setPending(false);
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

  return (
    <main className="h-full flex flex-col bg-neutral-50 text-neutral-900">
      <header className="px-4 py-3 border-b border-neutral-200 bg-white flex items-baseline gap-3 shrink-0">
        <h1 className="text-lg font-semibold">msword-use</h1>
        <p className="text-xs text-neutral-500">v2-alpha · 自然语言操作 Word · 修订模式</p>
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
        {wordCtx && <WordCtxBar ctx={wordCtx} />}
        <div className="ml-auto flex items-center gap-3 text-xs">
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
          <span className="text-neutral-400">
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
            className="p-3 border-t border-neutral-200 bg-white flex gap-2 items-center shrink-0"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              placeholder={pending ? "等待回复..." : "请说... (/ping 走原始 RPC)"}
              disabled={pending}
              className="flex-1 border border-neutral-300 rounded px-3 py-2 text-sm disabled:opacity-50"
            />
            {!pending && lastSent && !input && (
              <button
                type="button"
                onClick={() => send(lastSent)}
                className="px-3 py-2 text-xs text-neutral-600 border border-neutral-300 rounded hover:bg-neutral-50"
              >
                ↻ 重试
              </button>
            )}
            <button
              type="submit"
              disabled={pending}
              className="px-4 py-2 bg-neutral-900 text-white rounded text-sm disabled:opacity-50"
            >
              发送
            </button>
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
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.userText}
        </div>
      </div>

      {turn.toolCalls.map((tc) => (
        <ToolCallView key={tc.toolUseId} tc={tc} />
      ))}

      {(turn.assistantText || turn.streaming) && (
        <div className="flex justify-start">
          <div className="max-w-[85%] bg-white border border-neutral-200 rounded-2xl rounded-tl-sm px-4 py-2 text-sm whitespace-pre-wrap break-words">
            {turn.assistantText || <span className="text-neutral-400">...</span>}
            {turn.streaming && turn.assistantText && (
              <span className="text-neutral-400 animate-pulse">▍</span>
            )}
          </div>
        </div>
      )}

      {turn.error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ❌ {turn.error}
        </div>
      )}
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
function WordCtxBar({ ctx }: { ctx: WordContextSnapshot }) {
  // Strip the trailing " - Word" so the doc name is short.
  const docName =
    ctx.docName ??
    (ctx.triggerTitle
      ? ctx.triggerTitle.replace(/\s*-\s*(Microsoft\s+)?Word\s*$/i, "")
      : null);
  if (!docName && !ctx.selectionText) return null;
  const selPreview = ctx.selectionText
    ? ctx.selectionText.length > 40
      ? ctx.selectionText.slice(0, 40) + "…"
      : ctx.selectionText
    : null;
  return (
    <span className="text-xs text-neutral-500 flex items-center gap-1.5 px-2 py-0.5 bg-neutral-100 rounded">
      <span>📄</span>
      <span className="text-neutral-800 font-medium truncate max-w-[160px]">
        {docName ?? "(未链接)"}
      </span>
      {ctx.paragraphIndex != null && (
        <>
          <span className="text-neutral-400">·</span>
          <span>段 {ctx.paragraphIndex}</span>
        </>
      )}
      {selPreview && (
        <>
          <span className="text-neutral-400">·</span>
          <span className="italic text-neutral-600 truncate max-w-[180px]">"{selPreview}"</span>
        </>
      )}
    </span>
  );
}
