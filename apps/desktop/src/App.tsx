import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type { AgentEvent, SidecarMessage } from "./types";

type Bubble =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; done: boolean; stopReason?: string | null }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: unknown }
  | { kind: "raw"; id: string; reply: string }
  | { kind: "system"; id: string; text: string };

function App() {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Map from sidecar msg id → bubble id (assistant streaming aggregates here)
  const assistantBubbleId = useRef<Map<string, string>>(new Map());

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
      push({ kind: "system", id: rid(), text: `sidecar ready (driver gen=${msg.gen ?? "?"})` });
      return;
    }

    if (msg.kind === "agent_event" && msg.event) {
      const ev: AgentEvent = msg.event;
      const id = msg.id;
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
      } else if (ev.kind === "error") {
        push({ kind: "system", id: rid(), text: `error: ${ev.error}` });
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

  async function send() {
    const line = input.trim();
    if (!line) return;
    setInput("");

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
      <header className="px-4 py-3 border-b border-neutral-200 bg-white flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">msword-use</h1>
        <p className="text-xs text-neutral-500">
          v2-alpha · 自然语言操作 Word · 所有改动走修订模式
        </p>
        <div className="ml-auto text-xs text-neutral-400">
          指令前加 <code className="bg-neutral-100 px-1 rounded">/</code> 走原始 RPC（调试）
        </div>
      </header>

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
        className="p-3 border-t border-neutral-200 bg-white flex gap-2"
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
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-2 bg-neutral-900 text-white rounded text-sm disabled:opacity-50"
        >
          发送
        </button>
      </form>
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

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export default App;
