import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type Entry =
  | { kind: "user"; text: string; ts: number }
  | { kind: "reply"; text: string; ts: number }
  | { kind: "log"; text: string; ts: number };

function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlistenReply = listen<string>("bun:reply", (e) => {
      setEntries((es) => [...es, { kind: "reply", text: e.payload, ts: Date.now() }]);
    });
    const unlistenLog = listen<string>("bun:log", (e) => {
      setEntries((es) => [...es, { kind: "log", text: e.payload, ts: Date.now() }]);
    });
    return () => {
      void unlistenReply.then((u) => u());
      void unlistenLog.then((u) => u());
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  async function send() {
    if (!input.trim()) return;
    const line = input;
    setEntries((es) => [...es, { kind: "user", text: line, ts: Date.now() }]);
    setInput("");
    try {
      await invoke("bun_send", { line });
    } catch (err) {
      setEntries((es) => [...es, { kind: "log", text: `error: ${err}`, ts: Date.now() }]);
    }
  }

  return (
    <main className="h-full flex flex-col bg-neutral-50 text-neutral-900">
      <header className="px-4 py-3 border-b border-neutral-200 bg-white">
        <h1 className="text-lg font-semibold">msword-use</h1>
        <p className="text-xs text-neutral-500">
          v2-alpha · type a command (ping, attach, observe.outline, _freeze) and hit enter
        </p>
      </header>

      <section
        ref={scrollRef}
        className="flex-1 p-4 overflow-auto space-y-2 font-mono text-xs"
      >
        {entries.length === 0 && (
          <div className="text-neutral-400">
            Waiting for sidecar to boot... Try `ping` or `observe.outline`.
          </div>
        )}
        {entries.map((e, i) => (
          <EntryView key={i} e={e} />
        ))}
      </section>

      <form
        className="p-3 border-t border-neutral-200 bg-white flex gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          send();
        }}
      >
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="ping"
          className="flex-1 border border-neutral-300 rounded px-3 py-2 text-sm font-mono"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-neutral-900 text-white rounded text-sm"
        >
          Send
        </button>
      </form>
    </main>
  );
}

function EntryView({ e }: { e: Entry }) {
  if (e.kind === "user") {
    return (
      <div>
        <span className="text-blue-700">›</span>{" "}
        <span className="text-neutral-900">{e.text}</span>
      </div>
    );
  }
  if (e.kind === "log") {
    return <div className="text-neutral-400">[log] {e.text}</div>;
  }
  // reply: try to pretty-print JSON
  let pretty = e.text;
  try {
    pretty = JSON.stringify(JSON.parse(e.text), null, 2);
  } catch { /* not JSON, keep raw */ }
  return (
    <pre className="bg-neutral-100 border border-neutral-200 rounded p-2 whitespace-pre-wrap break-words">
      {pretty}
    </pre>
  );
}

export default App;
