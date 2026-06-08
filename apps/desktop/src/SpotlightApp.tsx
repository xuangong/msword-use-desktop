/**
 * Spotlight — the transient always-on-top input window invoked by Ctrl+Alt+J.
 *
 * Lifecycle:
 *   1. Rust hotkey handler captures foreground HWND/PID/title + a snapshot of
 *      the active Word paragraph (paragraph_index + preview), emits
 *      `spotlight:invoke` with that context, then shows + focuses this window.
 *   2. We read the event and render the context strip ("第 N 段：「...」"). The
 *      paragraph snapshot from the invoke event is the pinned target — we do
 *      NOT re-query Word for the selection, since by the time the user types
 *      and hits Enter the selection may have drifted.
 *   3. User types a command, hits Enter → we send a chat message to the
 *      sidecar tagged with sessionId and pinnedTarget.
 *   4. Stream events render inline (tiny progress line + final summary).
 *   5. On success, auto-hide after ~600ms; on error or Esc, hide immediately.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onTauriEvent } from "./lib/onTauriEvent";
import {
  buildCommands,
  useCommandPalette,
  type SkillEntry,
} from "./components/CommandPalette";

interface SpotlightInvoke {
  trigger_hwnd: number;
  trigger_pid: number;
  trigger_title: string;
  trigger_class: string;
  is_word: boolean;
  seq: number;
  /** 1-based paragraph index for the active Word selection, or null if
   *  not focused on Word / snapshot fetch failed. */
  paragraph_index: number | null;
  /** Up to 80 chars of the active paragraph's text. Empty string when no
   *  selection / not Word focused. */
  preview: string;
}

type AgentEvent = any;

type Phase = "idle" | "thinking" | "tool" | "success" | "error";

function dlog(...args: unknown[]) {
  const msg = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  console.log("[spotlight]", msg);
  invoke("debug_log", { msg }).catch(() => {});
}

export default function SpotlightApp() {
  const [ctx, setCtx] = useState<SpotlightInvoke | null>(null);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusText, setStatusText] = useState<string>("");
  const [hint, setHint] = useState<string>("");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingChatId = useRef<string | null>(null);
  const skillsRequested = useRef(false);
  const skillsPollTimer = useRef<number | null>(null);

  const commands = useMemo(() => buildCommands(skills), [skills]);
  const palette = useCommandPalette({
    query: input,
    commands,
    onPick: (cmd) => {
      setInput(cmd.fill);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
  });

  const reset = useCallback(() => {
    setInput("");
    setPhase("idle");
    setStatusText("");
    setHint("");
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const applySkillsList = useCallback((msg: any) => {
    if (msg.kind !== "skills:list" || !Array.isArray(msg.skills)) return false;
    setSkills(msg.skills as SkillEntry[]);
    skillsRequested.current = false;
    dlog("skills loaded", msg.skills.length);
    return true;
  }, []);

  // Register as a reply subscriber so Rust fans out replies to our queue.
  useEffect(() => {
    invoke("register_subscriber", { name: "spotlight" })
      .then(() => requestSkillsList())
      .catch(() => requestSkillsList());
  }, []);

  useEffect(() => {
    return () => {
      if (skillsPollTimer.current != null) {
        window.clearTimeout(skillsPollTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;
    const resize = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        const height = Math.ceil(root.getBoundingClientRect().height);
        invoke("spotlight_resize", { height: Math.max(92, Math.min(320, height)) }).catch(() => {});
      });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  function requestSkillsList(force = false) {
    if (!force && skillsRequested.current) return;
    skillsRequested.current = true;
    const id = `skills:${Math.random().toString(36).slice(2, 10)}`;

    if (skillsPollTimer.current != null) {
      window.clearTimeout(skillsPollTimer.current);
      skillsPollTimer.current = null;
    }

    const poll = async (attempt = 0) => {
      const replies = await invoke<string[]>("spotlight_take_reply", {
        subscriber: "spotlight",
        id,
      }).catch(() => [] as string[]);
      for (const raw of replies) {
        try {
          if (applySkillsList(JSON.parse(raw))) return;
        } catch {
          /* ignore */
        }
      }
      if (attempt >= 30 || !skillsRequested.current) {
        skillsRequested.current = false;
        return;
      }
      skillsPollTimer.current = window.setTimeout(() => poll(attempt + 1), 100);
    };

    invoke("bun_send", {
      line: JSON.stringify({ kind: "list-skills", id }),
    })
      .then(() => {
        skillsPollTimer.current = window.setTimeout(() => poll(), 50);
      })
      .catch((err) => {
        skillsRequested.current = false;
        dlog("list-skills failed", String(err));
        skillsPollTimer.current = window.setTimeout(() => requestSkillsList(true), 500);
      });
  }

  useEffect(() => {
    /** Apply a new invocation context: reset state. The paragraph snapshot
     *  (paragraph_index + preview) is part of the invoke payload itself —
     *  no separate selection fetch needed. */
    const applyInvoke = (payload: SpotlightInvoke) => {
      dlog("applyInvoke", payload);
      setCtx((prev) => {
        // Skip if it's the exact same seq we already processed.
        if (prev && prev.seq === payload.seq) return prev;
        reset();
        if (!payload.is_word) {
          setHint(`触发时前台是 ${payload.trigger_class || "(未知)"}，将操作当前活动 Word 文档`);
        }
        return payload;
      });
    };

    // 1. On mount, pull the latest invocation context (fixes the race where
    // Rust emit fires before the webview has registered listeners).
    invoke<SpotlightInvoke | null>("spotlight_get_invoke")
      .then((payload) => {
        dlog("initial pull", payload);
        if (payload) applyInvoke(payload);
      })
      .catch((err) => dlog("initial pull failed", String(err)));

    // 2. Also listen for live invocations while we're already mounted.
    // Use the browser-process singleton so StrictMode / HMR can never produce
    // >1 Tauri listener for the same channel.
    const offInvoke = onTauriEvent<SpotlightInvoke>("spotlight:invoke", (payload) => {
      applyInvoke(payload);
    });

    const offReply = onTauriEvent<string>("bun:reply", (payload) => {
      try {
        const msg = JSON.parse(payload);

        if (msg.ready === true) {
          requestSkillsList(true);
          return;
        }

        // Sidecar pushes its skills inventory at startup and after every
        // reload — track it so the command palette stays in sync.
        if (applySkillsList(msg)) {
          return;
        }

        if (msg.kind === "skills:reloaded") {
          setStatusText(
            `↻ skills reloaded: ${msg.before} → ${msg.after}` +
              (msg.diagnostics > 0 ? ` (${msg.diagnostics} warning)` : ""),
          );
          setPhase("success");
          setTimeout(() => setPhase("idle"), 1500);
          return;
        }

        // Chat agent events are handled only by the polling path below.
        // Handling them here as well double-applies every text/tool event.
      } catch {
        /* not JSON, ignore */
      }
    });

    return () => {
      offInvoke();
      offReply();
    };
  }, [reset, applySkillsList]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        invoke("spotlight_hide");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Poll the latest invoke whenever the window becomes visible (e.g. after
  // the hotkey shows it). This is the most reliable trigger because the
  // visibilitychange event fires every time Tauri unhides the window,
  // even if our listen() somehow missed the spotlight:invoke event.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (skills.length === 0) requestSkillsList(true);
      invoke<SpotlightInvoke | null>("spotlight_get_invoke")
        .then((payload) => {
          dlog("visibility pull", payload);
          if (!payload) return;
          // Reuse applyInvoke logic via a fresh setCtx with seq dedup.
          setCtx((prev) => {
            if (prev && prev.seq === payload.seq) return prev;
            reset();
            if (!payload.is_word) {
              setHint(`触发时前台是 ${payload.trigger_class || "(未知)"}，将操作当前活动 Word 文档`);
            }
            return payload;
          });
        })
        .catch((err) => dlog("visibility pull failed", String(err)));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reset, skills.length]);

  // Robustness fallback: Tauri 2 event delivery to the spotlight webview is
  // unreliable in some configurations. Poll the latest invocation every
  // 250ms — this is cheap (just an IPC round-trip to a static memory cell)
  // and guarantees we pick up any new seq within a quarter second of the
  // hotkey firing, regardless of whether the event listener fired.
  useEffect(() => {
    const t = setInterval(() => {
      invoke<SpotlightInvoke | null>("spotlight_get_invoke")
        .then((payload) => {
          if (!payload) return;
          setCtx((prev) => {
            if (prev && prev.seq === payload.seq) return prev;
            dlog("poll picked up new invoke", payload);
            reset();
            if (!payload.is_word) {
              setHint(`触发时前台是 ${payload.trigger_class || "(未知)"}，将操作当前活动 Word 文档`);
            }
            return payload;
          });
        })
        .catch(() => {});
    }, 250);
    return () => clearInterval(t);
  }, [reset]);

  async function send() {
    const message = input.trim();
    if (!message) return;
    if (phase === "thinking" || phase === "tool") return;

    // Built-in commands shortcut into the sidecar protocol directly without
    // going through the chat path. They DON'T create a new session.
    if (message === "/reload-skills") {
      const id = `cmd:${Math.random().toString(36).slice(2, 10)}`;
      setPhase("thinking");
      setStatusText("重新扫描 skills...");
      try {
        await invoke("bun_send", {
          line: JSON.stringify({ kind: "reload-skills", id }),
        });
        // The sidecar emits `skills:list` + `skills:reloaded`; the bun:reply
        // listener flips phase + statusText for us.
        setInput("");
      } catch (err) {
        setPhase("error");
        setStatusText(String(err));
      }
      return;
    }

    const id = `chat:${Math.random().toString(36).slice(2, 10)}`;
    // Generate sessionId BEFORE the bun_send so the sidecar tags this chat
    // with a real sid (not literal "undefined"). The same sid is announced
    // to the main window so it can group all events from this chat.
    const sessionId = `s-${Math.random().toString(36).slice(2, 10)}`;
    pendingChatId.current = id;
    setPhase("thinking");
    setStatusText("思考中...");
    dlog("send chat", { id, sessionId, message, ctx });

    // Build the chat payload. We pin the user's paragraph target NOW so the
    // agent doesn't re-read Application.Selection later (which can drift
    // while the LLM is thinking, the user clicks, focus changes, etc.).
    // The paragraph snapshot was captured by Rust at hotkey time and arrived
    // via the spotlight:invoke event in `ctx`.
    const payload: any = { kind: "chat", id, sessionId, message };
    if (ctx && ctx.paragraph_index != null) {
      payload.pinnedTarget = {
        paragraphIndex: ctx.paragraph_index,
        preview: ctx.preview,
      };
      dlog("payload includes pinnedTarget", payload.pinnedTarget);
    } else {
      dlog("no pinnedTarget — ctx missing paragraph_index", { ctx });
    }

    try {
      await invoke("bun_send", { line: JSON.stringify(payload) });
      // Tell the main window to render the user bubble + start polling.
      await invoke("announce_chat", { id, message, sessionId }).catch(() => {});
    } catch (err) {
      setPhase("error");
      setStatusText(String(err));
      return;
    }

    // Poll the chat event stream from the Rust reply cache. A chat call
    // produces multiple events (text_delta, tool_call, tool_result, done).
    let done = false;
    const tick = async () => {
      if (pendingChatId.current !== id) return; // superseded
      const replies = await invoke<string[]>("spotlight_take_reply", { subscriber: "spotlight", id }).catch(() => [] as string[]);
      for (const raw of replies) {
        try {
          const msg = JSON.parse(raw);
          dlog("polled chat", msg);
          handleAgentReply(msg);
          const t = msg.event?.type ?? msg.event?.kind;
          if (msg.kind === "agent_event" && (t === "agent_end" || t === "done" || t === "error")) {
            done = true;
          }
        } catch {
          /* ignore */
        }
      }
      if (done) return;
      setTimeout(tick, 100);
    };
    setTimeout(tick, 50);
  }

  /** Handle one parsed agent event reply (from poll or listen). */
  const handleAgentReply = useCallback((msg: any) => {
    if (msg.kind !== "agent_event" || msg.id !== pendingChatId.current) return;
    const ev: AgentEvent = msg.event;
    const type = ev?.type ?? ev?.kind;

    if (type === "tool_execution_start" || type === "tool_call") {
      setPhase("tool");
      setStatusText(`执行 ${ev.toolName ?? ev.name ?? "tool"}...`);
    } else if (type === "tool_execution_end" || type === "tool_result") {
      const r = (ev.details ?? ev.result) as any;
      if (r?.ok === false) {
        setPhase("error");
        setStatusText(r?.error ?? "失败");
      } else if (r?.style) {
        setStatusText(`${r.style} · ${r.originalChars}→${r.newChars} 字`);
      }
    } else if (
      type === "text_delta" ||
      (type === "message_update" && ev.assistantMessageEvent?.type === "text_delta")
    ) {
      setPhase((p) => (p === "tool" ? p : "thinking"));
    } else if (type === "agent_end" || type === "done") {
      setPhase((p) => {
        if (p === "error") return p;
        setStatusText((s) => s || "完成");
        setTimeout(() => invoke("spotlight_hide"), 700);
        return "success";
      });
      pendingChatId.current = null;
    } else if (type === "error") {
      setPhase("error");
      setStatusText(ev.error ?? ev.message ?? "失败");
      pendingChatId.current = null;
    }
  }, []);

  const docName = filenameOf(ctx?.trigger_title ?? "");
  const noSelection = !ctx || ctx.paragraph_index == null;
  const showHintLine = !!hint || noSelection;

  return (
    <div ref={rootRef} className="font-sans w-[720px] overflow-hidden" style={{ background: "transparent" }}>
      <div className="m-2 rounded-2xl shadow-2xl ring-1 ring-black/10 bg-white/95 backdrop-blur-md overflow-hidden">
        {ctx && ctx.paragraph_index != null && (
          <div
            className="px-3 py-1.5 text-xs text-neutral-600 border-b border-neutral-100 truncate"
            title={ctx.preview /* full preview on hover, in case truncated */}
          >
            📄 第 {ctx.paragraph_index} 段：「{ctx.preview || "(空段落)"}」
          </div>
        )}
        {ctx && ctx.paragraph_index == null && ctx.is_word === false && (
          <div
            className="px-3 py-1.5 text-xs text-amber-700 bg-amber-50/60 border-b border-amber-200 truncate"
            title={ctx.trigger_title}
          >
            ⚠️ 当前不在 Word 窗口（{ctx.trigger_class || "未知"}）
          </div>
        )}
        {palette.render()}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex items-center px-4 py-3 gap-3"
        >
          <PhaseDot phase={phase} />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Let the palette swallow Up/Down/Tab/Enter when it's open
              // and useful. handleKey returns false → fall through to the
              // form's normal Enter-to-submit behavior.
              palette.handleKey(e);
            }}
            placeholder="把选中文字改成公文 / 翻成英文…  (输入 / 看命令)"
            disabled={phase === "thinking" || phase === "tool"}
            className="flex-1 bg-transparent outline-none text-base placeholder-neutral-400 disabled:opacity-50"
          />
          <kbd className="text-[10px] text-neutral-400 bg-neutral-100 px-1.5 py-0.5 rounded">
            Esc
          </kbd>
        </form>

        {(docName || showHintLine || statusText) && (
          <div className="border-t border-neutral-100 px-4 py-2 text-xs text-neutral-600 flex items-center gap-2">
            {docName && (
              <>
                <span>📄</span>
                <span className="font-medium text-neutral-800 truncate max-w-[180px]">
                  {docName}
                </span>
              </>
            )}
            {ctx && ctx.paragraph_index != null && (
              <>
                <span className="text-neutral-300">·</span>
                <span>段 {ctx.paragraph_index}</span>
                {ctx.preview && (
                  <>
                    <span className="text-neutral-300">·</span>
                    <span className="italic text-neutral-500 truncate max-w-[260px]">
                      "{ctx.preview.trim().slice(0, 40)}"
                    </span>
                  </>
                )}
              </>
            )}
            {showHintLine && (
              <span className="text-amber-700">
                {hint || "未选中文字。请在 Word 中先选段文字。"}
              </span>
            )}
            {statusText && phase !== "idle" && (
              <span
                className={
                  "ml-auto " +
                  (phase === "error"
                    ? "text-red-700"
                    : phase === "success"
                    ? "text-green-700"
                    : "text-neutral-500")
                }
              >
                {statusText}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PhaseDot({ phase }: { phase: Phase }) {
  const cls = {
    idle: "bg-blue-500",
    thinking: "bg-amber-400 animate-pulse",
    tool: "bg-amber-500 animate-pulse",
    success: "bg-green-500",
    error: "bg-red-500",
  }[phase];
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

function filenameOf(title: string): string {
  const m = title.match(/^(.+?)\s+-\s+(Microsoft\s+)?Word$/i);
  return m ? m[1]! : title;
}
