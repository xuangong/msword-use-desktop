import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type {
  AgentEvent,
  SidecarMessage,
  WordContext,
  WordSelection,
  WordOutline,
  WordAttach,
} from "./types";

type Bubble =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean; stopReason?: string | null }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: unknown }
  | { kind: "raw"; id: string; reply: string }
  | { kind: "system"; id: string; text: string };

function App() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [pending, setPending] = useState(false);
  const [driverGen, setDriverGen] = useState<number | null>(null);
  const [driverReady, setDriverReady] = useState(false);
  const [wordCtx, setWordCtx] = useState<WordContext | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Map from sidecar msg id → bubble id (assistant streaming aggregates here)
  const assistantBubbleId = useRef<Map<string, string>>(new Map());
  // Pending Word-context request ids — sidecar replies for these update the
  // right panel instead of inserting a chat bubble.
  const ctxPending = useRef<Map<string, "attach" | "selection" | "outline">>(new Map());

  const refreshContext = useCallback(async () => {
    if (!driverReady) return;
    for (const method of ["attach", "observe.selection", "observe.outline"] as const) {
      const id = `ctx:${method}:${rid()}`;
      ctxPending.current.set(id, method.replace("observe.", "") as any);
      try {
        await invoke("bun_send", { line: JSON.stringify({ id, method, params: {} }) });
      } catch {
        ctxPending.current.delete(id);
      }
    }
  }, [driverReady]);

  useEffect(() => {
    const unlistenReply = listen<string>("bun:reply", (e) => {
      try {
        const msg: SidecarMessage = JSON.parse(e.payload);
        handleSidecarMessage(msg);
      } catch {
        push({ kind: "system", id: rid(), text: `parse fail: ${e.payload}` });
      }
    });
    const unlistenLog = listen<string>("bun:log", (e) => {
      push({ kind: "system", id: rid(), text: e.payload });
    });
    return () => {
      void unlistenReply.then((u) => u());
      void unlistenLog.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [bubbles]);

  // Initial context fetch when sidecar becomes ready.
  useEffect(() => {
    if (driverReady) refreshContext();
  }, [driverReady, refreshContext]);

  // Auto-refresh context every 5s while idle.
  useEffect(() => {
    if (!driverReady || pending) return;
    const t = setInterval(refreshContext, 5000);
    return () => clearInterval(t);
  }, [driverReady, pending, refreshContext]);

  function push(b: Bubble) {
    setBubbles((bs) => [...bs, b]);
  }

  function updateAssistantText(msgId: string, deltaText: string) {
    setBubbles((bs) => {
      let bubbleId = assistantBubbleId.current.get(msgId);
      if (!bubbleId) {
        bubbleId = rid();
        assistantBubbleId.current.set(msgId, bubbleId);
        return [...bs, { kind: "assistant", id: bubbleId, text: deltaText, done: false }];
      }
      return bs.map((b) =>
        b.kind === "assistant" && b.id === bubbleId
          ? { ...b, text: b.text + deltaText }
          : b,
      );
    });
  }

  function finishAssistant(msgId: string, stopReason: string | null) {
    setBubbles((bs) => {
      const bubbleId = assistantBubbleId.current.get(msgId);
      if (!bubbleId) return bs;
      return bs.map((b) =>
        b.kind === "assistant" && b.id === bubbleId ? { ...b, done: true, stopReason } : b,
      );
    });
    setPending(false);
  }

  function handleSidecarMessage(msg: SidecarMessage) {
    if (msg.ready) {
      setDriverReady(true);
      setDriverGen(msg.gen ?? 1);
      push({ kind: "system", id: rid(), text: `驱动就绪 (gen=${msg.gen ?? "?"})` });
      return;
    }

    if (msg.kind === "driver_restart") {
      setDriverGen(msg.to ?? null);
      push({
        kind: "system",
        id: rid(),
        text: `⚠️ 驱动重启 gen ${msg.from} → ${msg.to}（原因：${msg.reason ?? "未知"}）`,
      });
      return;
    }

    if (msg.gen != null) setDriverGen(msg.gen);

    // Context (right-panel) requests: don't show in chat.
    if (msg.id && ctxPending.current.has(msg.id)) {
      const which = ctxPending.current.get(msg.id)!;
      ctxPending.current.delete(msg.id);
      setWordCtx((prev) => {
        const next: WordContext = {
          attach: prev?.attach ?? null,
          selection: prev?.selection ?? null,
          outline: prev?.outline ?? null,
          refreshedAt: Date.now(),
          error: msg.error ?? undefined,
        };
        if (!msg.error && msg.result) {
          if (which === "attach") next.attach = msg.result as WordAttach;
          if (which === "selection") next.selection = msg.result as WordSelection;
          if (which === "outline") next.outline = msg.result as WordOutline;
        }
        return next;
      });
      return;
    }

    if (msg.kind === "agent_event" && msg.event) {
      const ev: AgentEvent = msg.event;
      const id = msg.id ?? "";
      if (ev.kind === "text_delta") {
        updateAssistantText(id, ev.text);
      } else if (ev.kind === "tool_call") {
        push({ kind: "tool", id: ev.id, name: ev.name, input: ev.input });
      } else if (ev.kind === "tool_result") {
        setBubbles((bs) =>
          bs.map((b) =>
            b.kind === "tool" && b.id === ev.id ? { ...b, result: ev.result } : b,
          ),
        );
      } else if (ev.kind === "done") {
        finishAssistant(id, ev.stopReason ?? null);
        // Pull fresh Word state after the agent finished editing.
        setTimeout(refreshContext, 100);
      } else if (ev.kind === "error") {
        push({ kind: "system", id: rid(), text: `❌ ${ev.error}` });
        setPending(false);
      }
      return;
    }

    // raw RPC reply
    push({
      kind: "raw",
      id: msg.id ?? rid(),
      reply: JSON.stringify(msg, null, 2),
    });
    setPending(false);
  }

  async function send(textOverride?: string) {
    const line = (textOverride ?? input).trim();
    if (!line) return;
    if (!textOverride) setInput("");
    setLastSent(line);

    // `/` prefix = raw RPC, otherwise = chat
    const isRaw = line.startsWith("/");
    const id = rid();

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
      push({ kind: "user", id: rid(), text: line });
      setPending(true);
      try {
        await invoke("bun_send", { line: JSON.stringify(payload) });
      } catch (err) {
        push({ kind: "system", id: rid(), text: `invoke failed: ${err}` });
        setPending(false);
      }
    } else {
      push({ kind: "user", id: rid(), text: line });
      setPending(true);
      const payload = { kind: "chat", id, message: line };
      try {
        await invoke("bun_send", { line: JSON.stringify(payload) });
      } catch (err) {
        push({ kind: "system", id: rid(), text: `invoke failed: ${err}` });
        setPending(false);
      }
    }
  }

  return (
    <main className="h-full flex flex-col bg-neutral-50 text-neutral-900">
      <header className="px-4 py-3 border-b border-neutral-200 bg-white flex items-baseline gap-3 shrink-0">
        <h1 className="text-lg font-semibold">msword-use</h1>
        <p className="text-xs text-neutral-500">
          v2-alpha · 自然语言操作 Word · 所有改动走修订模式
        </p>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className={driverReady ? "text-green-700" : "text-amber-600"}>
            <span className={"inline-block w-1.5 h-1.5 rounded-full mr-1 " + (driverReady ? "bg-green-500" : "bg-amber-500 animate-pulse")} />
            驱动 {driverReady ? `gen=${driverGen ?? "?"}` : "启动中…"}
          </span>
          <span className="text-neutral-400">
            指令前加 <code className="bg-neutral-100 px-1 rounded">/</code> 走原始 RPC
          </span>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: chat */}
        <div className="flex-1 flex flex-col min-w-0">
          <section ref={scrollRef} className="flex-1 p-4 overflow-auto space-y-3">
            {bubbles.length === 0 && (
              <div className="text-neutral-400 text-sm">
                试试：在 Word 里选一段文字，然后输入 <span className="font-mono">"把这段改成公文风格"</span>
              </div>
            )}
            {bubbles.map((b) => (
              <BubbleView key={b.id + ":" + b.kind} b={b} />
            ))}
          </section>

          <form
            className="p-3 border-t border-neutral-200 bg-white flex gap-2 items-center"
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
                title={`重试: ${lastSent}`}
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

        {/* Right: Word context panel */}
        <aside className="w-80 border-l border-neutral-200 bg-white overflow-auto shrink-0">
          <WordContextPanel ctx={wordCtx} onRefresh={refreshContext} />
        </aside>
      </div>
    </main>
  );
}

function BubbleView({ b }: { b: Bubble }) {
  if (b.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm whitespace-pre-wrap">
          {b.text}
        </div>
      </div>
    );
  }
  if (b.kind === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] bg-white border border-neutral-200 rounded-2xl rounded-tl-sm px-4 py-2 text-sm whitespace-pre-wrap">
          {b.text || <span className="text-neutral-400">…思考中</span>}
          {!b.done && b.text && <span className="text-neutral-400 animate-pulse"> ▍</span>}
        </div>
      </div>
    );
  }
  if (b.kind === "tool") {
    return <ToolBubble b={b} />;
  }
  if (b.kind === "raw") {
    let pretty = b.reply;
    try { pretty = JSON.stringify(JSON.parse(b.reply), null, 2); } catch {}
    return (
      <pre className="font-mono text-xs bg-neutral-100 border border-neutral-200 rounded p-2 whitespace-pre-wrap break-words">
        {pretty}
      </pre>
    );
  }
  return <div className="text-xs text-neutral-400">[sys] {b.text}</div>;
}

function ToolBubble({ b }: { b: Extract<Bubble, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => {
    const inputStr = JSON.stringify(b.input);
    return `${b.name}(${inputStr.length > 60 ? inputStr.slice(0, 60) + "…" : inputStr})`;
  }, [b]);
  const ok = b.result == null ? "pending" : (b.result as any)?.ok === false ? "error" : "ok";

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] w-full">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-left w-full text-xs font-mono border border-neutral-200 bg-neutral-50 rounded px-2 py-1 hover:bg-neutral-100"
        >
          <span className={
            ok === "ok" ? "text-green-700"
              : ok === "error" ? "text-red-700"
              : "text-neutral-400"
          }>
            {ok === "ok" ? "✓" : ok === "error" ? "✗" : "…"}
          </span>{" "}
          <span className="text-neutral-700">{summary}</span>
          <span className="text-neutral-400 ml-2">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="border border-t-0 border-neutral-200 rounded-b bg-white p-2 text-xs font-mono space-y-2">
            <div>
              <div className="text-neutral-500 mb-1">input:</div>
              <pre className="bg-neutral-50 p-2 rounded whitespace-pre-wrap">
                {JSON.stringify(b.input, null, 2)}
              </pre>
            </div>
            <div>
              <div className="text-neutral-500 mb-1">result:</div>
              <pre className="bg-neutral-50 p-2 rounded whitespace-pre-wrap">
                {b.result == null ? "…" : JSON.stringify(b.result, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WordContextPanel({
  ctx,
  onRefresh,
}: {
  ctx: WordContext | null;
  onRefresh: () => void;
}) {
  return (
    <div className="p-4 space-y-4 text-sm">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-neutral-800">Word 上下文</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-neutral-500 hover:text-neutral-900"
        >
          ↻ 刷新
        </button>
      </div>

      {!ctx && <div className="text-neutral-400 text-xs">加载中…</div>}

      {ctx?.error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {ctx.error}
        </div>
      )}

      {ctx?.attach && (
        <section>
          <div className="text-xs text-neutral-500 mb-1">活动文档</div>
          <div className="font-medium">{ctx.attach.activeDoc ?? <span className="text-neutral-400">（无）</span>}</div>
          <div className="text-xs text-neutral-500 mt-1">
            Word {ctx.attach.version} · {ctx.attach.documents} 份文档打开
          </div>
        </section>
      )}

      {ctx?.selection && (
        <section>
          <div className="text-xs text-neutral-500 mb-1">当前选区</div>
          {ctx.selection.isEmpty ? (
            <div className="text-neutral-400 text-xs">（无选区，光标在 段 {ctx.selection.paragraphIndex ?? "?"} ）</div>
          ) : (
            <div>
              <div className="bg-blue-50 border border-blue-100 rounded p-2 text-xs whitespace-pre-wrap line-clamp-6">
                {ctx.selection.text.trim() || "(空)"}
              </div>
              <div className="text-xs text-neutral-400 mt-1">
                {ctx.selection.end - ctx.selection.start} 字符
                {ctx.selection.paragraphIndex && ` · 段 ${ctx.selection.paragraphIndex}`}
                {ctx.selection.page && ` · 第 ${ctx.selection.page} 页`}
              </div>
            </div>
          )}
        </section>
      )}

      {ctx?.outline && ctx.outline.outline.length > 0 && (
        <section>
          <div className="text-xs text-neutral-500 mb-1">
            大纲 · {ctx.outline.outline.length} / {ctx.outline.total}
            {ctx.outline.truncated && " （截断）"}
          </div>
          <ul className="space-y-1">
            {ctx.outline.outline.map((n, i) => (
              <li
                key={i}
                className="text-xs truncate"
                style={{ paddingLeft: (n.level - 1) * 12 }}
              >
                <span className="text-neutral-400 mr-1">H{n.level}</span>
                {n.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {ctx?.outline && ctx.outline.outline.length === 0 && (
        <div className="text-xs text-neutral-400">(文档没有 heading 段落)</div>
      )}

      {ctx?.refreshedAt && (
        <div className="text-xs text-neutral-300 pt-2 border-t border-neutral-100">
          {new Date(ctx.refreshedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default App;
