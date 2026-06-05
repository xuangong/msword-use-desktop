# Spec: pi-agent-core rewrite — sidecar core + driver simplification (W1)

**Date:** 2026-06-06
**Status:** Approved (brainstorming complete; ready for writing-plans)
**Scope:** W1 only — pi integration, driver protocol simplification, exec_csharp+read tools, session lifecycle. Settings panel (W2) is a separate spec.

---

## Context

Current v0.3 architecture handwrites the agent loop using `@anthropic-ai/sdk` directly, with a whitelist of Word operations exposed as RPC methods (`polish.replaceRange`, `polish.addComment`, several `observe.*`). Adding Word capabilities means changing four places (`drivers/WordDriver/Methods/*.cs`, `Program.cs` dispatch, `schema/methods.json`, agent tool spec) — does not scale to "hundreds of Word operations".

We considered two wrong directions before settling:
1. **ACP / claude-agent-acp / @anthropic-ai/claude-agent-sdk** — rejected. These wrap a "finished brain" (Claude Code's CLI internals) we cannot retune. Hurts vertical non-coding tasks: it Glob/Grep's instead of editing fonts; it auto-fixes Chinese punctuation; tool whitelist cannot be enforced. See `memory/architecture-direction.md` for the full case.
2. **Hand-write Anthropic SDK loop ourselves** — rejected. Prompt caching, context overflow, auto-compact, abort/steer are all "runtime quality" code that's easy to get wrong. Not our differentiator.

**Chosen direction:** adopt `@earendil-works/pi-agent-core` as the agent runtime (library, not framework — see `memory/pi-integration-boundaries.md`). Replace driver's RPC method table with a single-action script-execution pipe. Teach the model to drive Word COM via C# scripts (`exec_csharp`), with `read` for skill progressive disclosure. Skills in `agentskills.io` standard, loaded by pi.

This spec covers the W1 worktree — the minimal slice that proves the new agent loop end-to-end. W2 (settings panel for model/API key) is deferred to a separate spec.

---

## Approved decisions (from brainstorming)

| # | Topic | Decision |
|---|---|---|
| Q1 | Multi-session concurrency | **Global FIFO retained.** One chat at a time across all sessions. Word is a single instance — parallel writes race anyway. |
| Q2 | Skill source | **Hand-written only.** `apps/agent/skills/` bundle; no community submodules; no user uploads. |
| Q3 | `read` tool path roots | **Two whitelisted dirs:** `apps/agent/skills/` + `apps/agent/docs/` (docs left empty in W1, structure reserved). |
| Q4 | Pinned target mechanism | **Pin paragraphIndex, not char offsets.** Preamble tells LLM "current target: paragraph 6". Spotlight UI shows "📄 第 N 段：『preview…』" so user visually confirms. |
| Q5 | Frontend protocol | **Frontend consumes pi-native events directly.** No translation layer in sidecar. Atoms parse `message_update.assistantMessageEvent.text_delta` etc. |
| Q6 | Model / API key config | **Settings panel (deferred to W2).** W1 stays on env var (current behavior). |
| Q7 | `polish_text` legacy tool | **Delete immediately.** Skill + exec_csharp is the only path. No fallback. |
| Q8 | Sidecar packaging | **Validate `bun --compile` first.** Smoke-test pi imports compile-bundle cleanly. If yes → keep current single-exe model. If no → switch to "bun runtime + script" packaging. |

**Overall path: P2** — two worktrees. W1 = agent core rewrite. W2 = settings panel (separate spec, separate worktree).

---

## Architecture

```
┌─────────────────────────────────────────┐
│ Tauri (Rust)                            │
│  • spotlight hotkey / overlay window    │
│  • on trigger: ask sidecar for selection│
│    snapshot {paragraphIndex, preview}   │
│  • API key/model via env var (W1)       │
└──────────────┬──────────────────────────┘
               │ NDJSON over stdio
               │ (envelope passes pi-native events through)
               ▼
┌─────────────────────────────────────────┐
│ Bun sidecar (apps/agent)                │
│  • pi-agent-core agent loop             │
│  • Map<sessionId, Agent>                │
│  • Global FIFO chat queue (preserved)   │
│  • Tools registered:                    │
│    - exec_csharp(code)  → driver        │
│    - read(path)         → fs whitelist  │
│  • Skills: pi.loadSkills(['skills/'])   │
│  • bun build --compile (smoke gate)     │
└──────────────┬──────────────────────────┘
               │ stdio pipe — single-action protocol:
               │   sidecar → driver: {id, code}
               │   driver → sidecar: {id, result, stdout, error}
               ▼
┌─────────────────────────────────────────┐
│ WordDriver.exe (.NET 4.8)               │
│  • main loop (line-delimited JSON)      │
│  • Roslyn host (CSharpScript)           │
│  • COM session attach + self-heal       │
│  • Globals: Doc, App, Track(), Print()  │
└──────────────┬──────────────────────────┘
               │ COM
               ▼
            Microsoft Word
```

**Why all three processes still exist:**
- Word COM requires .NET Framework 4.8 (Office Interop PIA does not support .NET Core/5+); a separate driver process is unavoidable.
- Long-lived `Word.Application` reference + 10s hang detector + kill+respawn supervisor is the core resilience layer.
- Bun sidecar is where the agent runtime lives because Anthropic SDK + pi-agent-core are TS/Node-shaped.
- Tauri owns hotkey, window, foreground HWND capture (Windows-API stuff Bun cannot do cleanly).

---

## Components

### Sidecar (largest change)

| File | Role |
|---|---|
| `apps/agent/src/index.ts` | Process entry. Reads NDJSON commands from stdin, dispatches by `kind`, writes pi-native events back. Owns the global FIFO chat queue (preserved from v0.3). |
| `apps/agent/src/agent/sessionRegistry.ts` *(new)* | `Map<sessionId, Agent>` with LRU (keep last 10) + 30min idle dispose. `getOrCreate(sid)` is lazy. |
| `apps/agent/src/agent/tools/execCsharp.ts` *(new)* | pi `AgentTool`. Parameters: `{code: string}`. Forwards to `Supervisor.runScript(code)`. |
| `apps/agent/src/agent/tools/read.ts` *(new)* | pi `AgentTool`. Parameters: `{path: string}`. Path whitelist = `apps/agent/skills/` ∪ `apps/agent/docs/`. Rejects path traversal. |
| `apps/agent/src/agent/skills.ts` *(new)* | At startup calls `pi.loadSkills([skillsDir])`; exposes `buildSystemPrompt(skills)` that concatenates `BASE_SYSTEM_PROMPT` + `pi.formatSkillsForSystemPrompt(skills)`. |
| `apps/agent/src/rpc/supervisor.ts` *(simplified)* | Drops method/params API. Single new method: `runScript(code, signal?) → {result, stdout, error}`. Hang detection + kill+respawn unchanged. |
| `apps/agent/src/rpc/driverClient.ts` *(simplified)* | Drops `MethodName`/`Params`/`Result` types. Single send/recv: `{id, code}` ↔ `{id, result, stdout, error}`. |

**Deleted from sidecar:**
- `apps/agent/src/agent/loop.ts` (handwritten loop)
- `apps/agent/src/agent/tools/polishText.ts` + test
- `apps/agent/src/agent/prompts.ts` (merged into skills.ts; `BASE_SYSTEM_PROMPT` stays as a const)
- `apps/agent/src/llm/anthropic.ts` (pi owns LLM)
- `packages/rpc-schema/` (entire workspace package — driver no longer has method table)
- `scripts/gen-rpc-types.ts`

### Driver (medium change)

| File | Role |
|---|---|
| `drivers/WordDriver/Program.cs` *(simplified)* | Main loop only: read stdin line → JSON parse → run Roslyn → write JSON back. No dispatch table. |
| `drivers/WordDriver/Roslyn/Host.cs` *(new)* | `CSharpScript.RunAsync` host. `Globals` class exposes `Doc`, `App`, `Track(Action)`, `Print(object)`. Assembly whitelist: `Microsoft.Office.Interop.Word`, `mscorlib`, `System.Core`, `System.Linq`, `System.Text.RegularExpressions`. |
| `drivers/WordDriver/WordSession.cs` *(unchanged)* | Attach + self-heal logic stays as-is. |
| `drivers/WordDriver/RevisionScope.cs` *(new — extracted from old Polish.cs)* | RAII wrapper used by `Track()` global. |

**Deleted from driver:**
- `drivers/WordDriver/Methods/Observe.cs`, `Polish.cs`
- `drivers/WordDriver/schema/methods.json`

### Tauri (small change)

| File | Role |
|---|---|
| `apps/desktop/src-tauri/src/lib.rs` | On hotkey: invoke sidecar `kind:"raw"` with a small Roslyn snippet that returns `{paragraphIndex, preview}`. Forward result to spotlight `spotlight:invoke` event. `bun_send` IPC stays as-is. |

### Frontend (small change)

| File | Role |
|---|---|
| `apps/desktop/src/state/atoms.ts` | Event parser changes from current `agent_event{kind:...}` to pi-native event names (`message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `error`). Bucket-by-sid logic unchanged. |
| `apps/desktop/src/SpotlightApp.tsx` | Display `📄 第 N 段：「preview…」` strip on top of the input, fed by `spotlight:invoke` payload. |
| `apps/desktop/src/App.tsx` | Update event rendering for new event names. Preserve atoms-by-sid model. |

### Workspace resources (new)

```
apps/agent/skills/
  polish-gongwen/SKILL.md
  polish-hetong/SKILL.md
  polish-lunwen/SKILL.md
  word-com-cheatsheet/SKILL.md
  track-changes-protocol/SKILL.md

apps/agent/docs/             ← reserved, empty in W1
```

Each `SKILL.md` follows agentskills.io frontmatter (`name`, `description`, body). Progressive disclosure: only name+description goes into systemPrompt; full body loaded by LLM via `read`.

---

## Data flow

### Phase A: spotlight trigger

1. User selects paragraph 6 in Word, presses Ctrl+Alt+J.
2. Rust `capture_foreground()` grabs HWND/title/class. Stores `LAST_INVOKE`.
3. Rust sends `{kind:"raw", id:"snap_xxx", code:<C# snippet>}` to sidecar. The snippet computes `paragraphIndex` (1-based, derived from `App.Selection.Paragraphs[1].Range.Start` matched against `Doc.Paragraphs`) and a `preview` (first ~80 chars of the paragraph text, trimmed of `\r\n\x07\t `). The exact snippet text is finalised during implementation but produces a `{paragraphIndex, preview}` object.
4. Sidecar forwards to driver via single-action pipe; driver Roslyn runs; returns `{result:{paragraphIndex:6, preview:"…"}, stdout:"", error:null}`.
5. Sidecar writes `{id:"snap_xxx", kind:"snap_result", paragraphIndex:6, preview:"…"}` back to Tauri.
6. Tauri emits `spotlight:invoke` with snap data; spotlight UI shows `📄 第 6 段：「关于…」` + input box.

### Phase B: user submits prompt

7. User types `把这段改成公文风格`, Enter.
8. Frontend mints `sid_X`, stores in atoms (chatTurns / wordCtx by sid), invokes Tauri `acp_send_prompt`.
9. Tauri forwards: `{kind:"chat", id:"req_yyy", sessionId:"sid_X", message:"…", pinnedTarget:{paragraphIndex:6, preview:"…"}}`.
10. Sidecar's global FIFO picks up the job:
    - `SessionRegistry.getOrCreate("sid_X")` → first time, `new Agent({initialState:{systemPrompt: BASE+skills, model, tools:[execCsharp, read]}, transport: ProviderTransport({getApiKey})})`; `agent.subscribe(evt => write({sessionId, id, kind:"agent_event", event:evt}))`.
    - Compose user message: `"[当前操作目标：第 6 段，预览：关于…的通知…] 把这段改成公文风格"`.
    - `agent.prompt(userMessage)`.

### Phase C: agent REPL multi-turn (pi-driven)

- **turn 1:** LLM sees the systemPrompt's `<available_skills>` XML block (produced by `formatSkillsForSystemPrompt`) → calls `read("skills/polish-gongwen/SKILL.md")` to load the full skill body.
- **turn 2:** LLM calls `exec_csharp("Print(Doc.Paragraphs[6].Range.Text)")` to inspect current text.
- **turn 3:** LLM calls `exec_csharp("Track(() => { var rng = Doc.Paragraphs[6].Range; rng.Text = \"…\\r\"; Doc.Comments.Add(rng, \"[AI: 公文] …\"); });")` — Word now shows tracked revision + comment.
- **turn 4:** LLM emits text deltas summarising what changed.
- pi emits `agent_end`, loop terminates.

### Phase D: event passthrough

Each pi event is wrapped in a thin routing envelope (sessionId + request id) and written to stdout. The envelope is for routing only; the inner `event` field is the pi-native event verbatim — no field renaming, no shape translation.

```json
{"sessionId":"sid_X","id":"req_yyy","kind":"agent_event","event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"已将"}}}
{"sessionId":"sid_X","id":"req_yyy","kind":"agent_event","event":{"type":"tool_execution_start","toolName":"read","toolCallId":"…","args":{"path":"skills/polish-gongwen/SKILL.md"}}}
... (etc) ...
{"sessionId":"sid_X","id":"req_yyy","kind":"agent_event","event":{"type":"agent_end","messages":[…]}}
```

Frontend bucket-by-sid logic unchanged; only the event name parsing changes.

### Phase E: multi-turn follow-up

11. User in main window types `再缩短 30%` against `sid_X`.
12. Frontend invokes Tauri with `sessionId:"sid_X"`.
13. Sidecar `SessionRegistry.getOrCreate("sid_X")` → cache hit, reuse Agent.
14. `agent.prompt("再缩短 30%")` — pi internal message history already contains turn 1-4 from before; LLM sees the prior rewrite and shortens incrementally.

No persistence code: this works purely from in-memory pi state.

### Phase F: abort / errors

- **Esc:** frontend invokes `agent_abort(sessionId)`; sidecar calls `agent.abort()`; pi cancels LLM stream + tool execute; emits cancelled event.
- **Driver hang:** supervisor's 10s timeout fires; kill + respawn; in-flight `exec_csharp` rejects with `DriverRestart`; pi treats as tool error; LLM decides next action.
- **LLM API error:** pi's internal retry; on exhaustion emits `error` event; sidecar forwards.

---

## Error handling

| Error type | Layer | Handling | User experience |
|---|---|---|---|
| Roslyn compile error | driver | Return `{error:"compile_error: <diagnostics>"}` | LLM auto-retries; debug panel shows diagnostics |
| Roslyn runtime exception | driver | Return `{error:"runtime_error: <Type>: <msg>"}` | Same |
| COM disconnected (Word closed) | driver `WordSession.IsDisconnected` | Reset cached App; re-attach once; throw `Word.Application not found` if still failing | LLM informs user "请确认 Word 已打开" |
| Driver hang | supervisor (10s) | Kill + respawn; reject in-flight as `DriverRestart` | Front-end shows "驱动已重启" |
| Driver crash | supervisor exit listener | Same path as hang | Same |
| LLM API error | pi internal retry | pi handles backoff; on exhaustion emits `error` | Front-end shows the error |
| Path traversal in `read` | read tool | Reject `{error:"path not allowed: <path>"}` | LLM picks legal path |
| User abort (Esc) | sidecar | `agent.abort()` cancels stream + tool exec | UI shows "已取消" |
| Session not in registry | SessionRegistry | Lazy-create; LRU evicts only idle, never running | Transparent |
| `bun --compile` fails to bundle pi | smoke gate (W1 step 1) | Switch to packaging plan B (bun runtime + script) | Invisible to user; affects packaging only |

### Key invariants

1. **Track Changes** — all mutations route through the `Track()` global. Skill `track-changes-protocol` enforces by documentation. Soft constraint: we don't reject scripts that touch `Doc.TrackRevisions` directly because read-only access has legitimate edge cases. The invariant is enforced via prompt + skill, not driver-side rejection.
2. **Pinned target** — preamble passes `paragraphIndex` (not char offsets). If the index is out of range (user deleted paragraphs), `Doc.Paragraphs[N]` throws `IndexOutOfRange`; LLM falls back to observing.
3. **Global FIFO** — two chats never run concurrently. Second one queues.
4. **Single driver PID per supervisor** — respawn rejects all in-flight from old PID.

---

## Test strategy

### Must-test (W1 acceptance gate)

1. **Bun --compile validation** *(earliest, decides A vs B packaging)*: minimal `import { Agent } from "@earendil-works/pi-agent-core"` script → `bun build --compile` → run. **Pass → packaging A; fail → packaging B.**
2. **Driver Roslyn host unit test** *(no Word required)*: compile fixtures (typo, runtime divide-by-zero, valid return) → assert `{result, stdout, error}` shape.
3. **SessionRegistry unit test**: `getOrCreate` idempotent; LRU eviction kicks at N+1; `dispose` then `getOrCreate` rebuilds.
4. **Sidecar e2e (mocked driver)**: mock Supervisor returns canned results. Run a chat; assert:
   - skill name+description appears in `systemPrompt`
   - `read` tool gets invoked and returns SKILL.md body
   - `exec_csharp` tool forwards code to mock driver and propagates result
   - pi events stream out as `agent_event` envelopes on stdout
5. **Manual e2e with real Word**: open Word doc → press Ctrl+Alt+J → verify paragraph preview shown → submit `把这段改成公文风格` → Word shows tracked revision + `[AI:公文]` comment.

### Should-test

6. `read("../../../etc/passwd")` rejected; `read("skills/polish-gongwen/SKILL.md")` succeeds.
7. Driver hang: send `while(true){}` script; supervisor kill+respawn within 10s; next call works.
8. Multi-session isolation: sid_A and sid_B independent message histories.
9. Multi-turn continuity: sid_X second prompt sees first prompt's rewrite in pi internal history.

### Could-test (non-blocking)

10. Abort propagates an `AbortSignal` into our tool `execute`.
11. Periodic CI smoke against latest pi version (catch breaking renames early).

### Won't-test (YAGNI)

- Restart persistence (W1 does not persist)
- Multi-provider (Anthropic only)
- Cross-session global coordination (does not exist)

### Verification commands (must pass before claiming W1 done)

```bash
# 1. driver builds
bun run driver:build

# 2. driver Roslyn unit tests
# (test runner defined as part of W1 step "driver: build Roslyn host" — likely
#  a small Bun script that pipes fixtures into WordDriver.exe and asserts the
#  JSON response shape. No Word required for these.)

# 3. sidecar bun --compile (decides packaging A vs B)
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/sidecar-test.exe src/index.ts

# 4. sidecar unit tests
cd apps/agent && bun test

# 5. manual e2e (with real Word + ANTHROPIC_API_KEY set):
#    spotlight → 公文 polish → tracked revision visible
```

---

## Out of scope (W2 or later)

- Settings panel for model / API key (W2 spec)
- API key encryption / OS keychain (W2)
- Skill catalog UI / user-uploaded skills (later — see `memory/architecture-direction.md` decision to keep skills bundle-only for now)
- Cross-process session persistence (deliberately deferred — pi's `harness/session/jsonl-repo.ts` ready when needed)
- Slash commands (`/skill:polish-gongwen`) — UI buttons fill this role for now
- Permission UX (every `exec_csharp` auto-runs in W1; gated UX is later)
- Multiple MCP servers / Anthropic-non-default providers
