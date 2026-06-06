/**
 * Bun sidecar entry point — pi-agent-core era.
 *
 * Stdin protocol (line-delimited JSON from Tauri):
 *   {"kind":"chat","id":"<reqId>","sessionId":"<sid>","message":"<text>","pinnedTarget":{paragraphIndex,preview}?}
 *   {"kind":"raw","id":"<reqId>","code":"<C# script>"}
 *   {"kind":"abort","sessionId":"<sid>"}
 *   {"kind":"shutdown"}
 *
 * Stdout protocol (line-delimited JSON to Tauri):
 *   {"ready":true,"driverExe":"...","gen":1}                                       (startup)
 *   {"sessionId":"<sid>","id":"<reqId>","kind":"agent_event","event":<pi-AgentEvent>}  (per pi event)
 *   {"id":"<reqId>","kind":"raw_response","result":...,"stdout":"...","error":null}    (per raw)
 *   {"kind":"driver_restart","from":1,"to":2,"reason":"hang"}                          (supervisor)
 *
 * Concurrency:
 *   - chat requests are SERIALIZED through a single global FIFO chain (per spec Q1)
 *   - raw and abort run concurrently with the chat chain (they don't touch the
 *     same Word selection in adversarial ways: raw is for fast snapshots,
 *     abort is targeted at one session)
 */

import { resolve } from "node:path";
import { Supervisor } from "./rpc/supervisor";
import { loadSkills } from "@earendil-works/pi-agent-core";
// NodeExecutionEnv lives only on the /node subpath (not on the package root).
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { resolveAllowedRoots } from "./agent/skillsRoot";
import { makeAgentFactory } from "./agent/agentFactory";
import { SessionRegistry } from "./agent/sessionRegistry";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

// ---------- Windows path-normalization wrapper for pi's NodeExecutionEnv ----------
//
// pi-agent-core 0.78.1's `loadSkills` and its path helpers (`relativeEnvPath`,
// `fileInfoFromStats`) are POSIX-centric: they `split("/")` on returned paths
// and prefix-match with `${root}/`. Node's `path.resolve` returns Windows-style
// backslash paths on Windows, which break both.
//
// This thin wrapper rewrites `path` and recomputes `name` for every FileInfo
// returned by NodeExecutionEnv so pi sees forward-slash paths everywhere.
// Does not affect file-system access — `node:fs` accepts either separator on
// Windows.
//
// Track upstream fix; remove when pi-agent-core handles Windows paths.
function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash === -1 ? p : p.slice(slash + 1);
}

class PosixNodeExecutionEnv extends NodeExecutionEnv {
  async fileInfo(p: string) {
    const r = await super.fileInfo(p);
    if (r.ok) {
      const path = toPosixPath(r.value.path);
      return { ok: true as const, value: { ...r.value, path, name: basename(path) } };
    }
    return r;
  }
  async listDir(p: string, abortSignal?: AbortSignal) {
    const r = await super.listDir(p, abortSignal);
    if (r.ok) {
      return {
        ok: true as const,
        value: r.value.map((e) => {
          const path = toPosixPath(e.path);
          return { ...e, path, name: basename(path) };
        }),
      };
    }
    return r;
  }
}

// ---------- driver supervisor ----------

const driverExe =
  process.env.MSWORD_DRIVER_EXE ??
  resolve(import.meta.dir, "../../../drivers/WordDriver/bin/Debug/net48/WordDriver.exe");

const supervisor = new Supervisor({ exePath: driverExe, callTimeoutMs: 10_000 });
supervisor.onGenChange = (info) => {
  write({ kind: "driver_restart", from: info.from, to: info.to, reason: info.reason });
};

// ---------- skills ----------

const roots = resolveAllowedRoots();
const env = new PosixNodeExecutionEnv({ cwd: resolve(roots.skills, "..") });
const { skills, diagnostics } = await loadSkills(env, [roots.skills]);
for (const d of diagnostics) {
  // Warnings about malformed SKILL.md — surface to stderr so a dev sees them
  // without polluting the protocol stream.
  process.stderr.write(`[skills] ${d.code} at ${d.path}: ${d.message}\n`);
}

// ---------- agent registry ----------

const agentFactory = makeAgentFactory({ supervisor, skills });

/** sid → request id of the in-flight prompt, if any. Used to tag events. */
const currentPromptId = new Map<string, string>();
/** sid → unsubscribe fn returned by Agent.subscribe; called on dispose so the
 *  contract is explicit rather than relying on GC after registry eviction. */
const unsubscribers = new Map<string, () => void>();

const registry = new SessionRegistry<Agent>({
  agentFactory: (sid) => {
    const agent = agentFactory(sid);
    // Subscribe each Agent's events at creation time. The listener captures
    // the sid in closure; pi never changes a Session's sid post-construction.
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      // We don't have the per-prompt request id here. The sidecar correlates
      // by sid; the UI keys events by sid in atoms. The id field is filled
      // when the prompt was issued (see runChat below).
      const reqId = currentPromptId.get(sid) ?? null;
      write({ sessionId: sid, id: reqId, kind: "agent_event", event });
    });
    unsubscribers.set(sid, unsubscribe);
    return agent;
  },
  onDispose: (sid) => {
    const unsub = unsubscribers.get(sid);
    if (unsub) {
      try { unsub(); } catch { /* best-effort */ }
      unsubscribers.delete(sid);
    }
    currentPromptId.delete(sid);
  },
});

// ---------- writer ----------

function write(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

write({ ready: true, driverExe, gen: supervisor.generation });

// ---------- chat FIFO ----------

let chatChain: Promise<void> = Promise.resolve();

function enqueueChat(fn: () => Promise<void>): Promise<void> {
  const next = chatChain.then(fn, fn);
  chatChain = next.catch(() => {});
  return next;
}

// ---------- main loop ----------

let buf = "";
const decoder = new TextDecoder("utf-8");
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handleLine(line);
  }
}

function handleLine(line: string) {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch (err) {
    write({ id: null, kind: "error", error: `parse_error: ${err}` });
    return;
  }

  switch (req.kind) {
    case "chat":
      void enqueueChat(() => runChat(req));
      return;
    case "raw":
      void runRaw(req);
      return;
    case "abort":
      runAbort(req);
      return;
    case "shutdown":
      void runShutdown();
      return;
    default:
      write({ id: req.id ?? null, kind: "error", error: `unknown kind: ${req.kind}` });
  }
}

interface PinnedTarget {
  paragraphIndex?: number;
  preview?: string;
}

interface ChatReq {
  id: string;
  sessionId: string;
  message: string;
  pinnedTarget?: PinnedTarget;
}

async function runChat(req: ChatReq) {
  const { id, sessionId, message, pinnedTarget } = req;
  const agent = registry.getOrCreate(sessionId);
  currentPromptId.set(sessionId, id);

  const userText = pinnedTarget?.paragraphIndex
    ? composePromptWithTarget(message, pinnedTarget)
    : message;

  try {
    await agent.prompt(userText);
  } catch (err: any) {
    write({
      sessionId,
      id,
      kind: "agent_event",
      event: { type: "error", error: String(err?.message ?? err) } as any,
    });
  } finally {
    currentPromptId.delete(sessionId);
  }
}

function composePromptWithTarget(message: string, target: PinnedTarget): string {
  const lines = ["[当前操作目标]"];
  if (target.paragraphIndex) lines.push(`段落索引: ${target.paragraphIndex}`);
  if (target.preview) lines.push(`段落预览: ${target.preview}`);
  lines.push("");
  lines.push(message);
  return lines.join("\n");
}

interface RawReq {
  id: string;
  code: string;
}

async function runRaw(req: RawReq) {
  const { id, code } = req;
  try {
    const resp = await supervisor.runScript(code);
    write({
      id,
      kind: "raw_response",
      result: resp.result,
      stdout: resp.stdout,
      error: resp.error,
    });
  } catch (err: any) {
    write({
      id,
      kind: "raw_response",
      result: null,
      stdout: "",
      error: String(err?.message ?? err),
    });
  }
}

interface AbortReq {
  sessionId: string;
}

function runAbort(req: AbortReq) {
  if (!registry.has(req.sessionId)) return;
  const agent = registry.getOrCreate(req.sessionId);
  agent.abort();
}

async function runShutdown() {
  registry.disposeAll();
  await supervisor.shutdown();
  process.exit(0);
}
