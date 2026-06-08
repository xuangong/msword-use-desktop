# pi-agent-core rewrite (W1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace handwritten Anthropic SDK loop + RPC method whitelist with `@earendil-works/pi-agent-core` driving a single-action `exec_csharp` driver. End-to-end demo: spotlight → polish to 公文 style → tracked revision in Word.

**Architecture:** Tauri (Rust) ↔ Bun sidecar (pi-agent-core, `Map<sid,Agent>`) ↔ WordDriver.exe (Roslyn host + COM). Driver protocol simplifies from N RPC methods to one `{id,code}` ↔ `{id,result,stdout,error}` action. Agent uses just two tools: `exec_csharp` (Roslyn-driven Word COM access) and `read` (whitelisted file reads for skill progressive disclosure).

**Tech Stack:** Bun + TypeScript (sidecar), `@earendil-works/pi-agent-core` 0.78.x (pinned), `@earendil-works/pi-ai`, Anthropic API. .NET Framework 4.8 + `Microsoft.CodeAnalysis.CSharp.Scripting` 4.8.0 + Word Interop PIA (driver). Tauri 2 + React + Jotai (UI).

**Spec:** `docs/superpowers/specs/2026-06-06-pi-agent-core-rewrite-design.md`

---

## Phase order

| Phase | File | Purpose | Gates next phase? |
|---|---|---|---|
| 0 | [phase-0-worktree-and-smoke.md](phase-0-worktree-and-smoke.md) | Create worktree; pin pi version; **smoke-test `bun --compile` can bundle pi** (decides packaging A vs B) | Yes — without smoke pass, packaging strategy is unknown |
| 1 | [phase-1-driver-roslyn.md](phase-1-driver-roslyn.md) | Rebuild driver: Roslyn host + single-action protocol; delete old method dispatch | Yes — sidecar tools depend on this |
| 2 | [phase-2-sidecar-supervisor.md](phase-2-sidecar-supervisor.md) | Simplify supervisor/driverClient to `runScript(code)`; delete `@msword/rpc-schema`; smoke test driver pipe | Yes — pi tools depend on this |
| 3a | [phase-3a-skills-bundle.md](phase-3a-skills-bundle.md) | Write 5 SKILL.md files under `apps/agent/skills/`; create empty `apps/agent/docs/` | Yes — `read` tool needs the dirs to exist |
| 3b | [phase-3b-read-tool.md](phase-3b-read-tool.md) | `read` AgentTool with path whitelist; unit tests | Yes — Agent setup uses it |
| 3c | [phase-3c-exec-csharp-tool.md](phase-3c-exec-csharp-tool.md) | `exec_csharp` AgentTool wrapping supervisor; unit tests | Yes — Agent setup uses it |
| 4a | [phase-4a-session-registry.md](phase-4a-session-registry.md) | `Map<sid, Agent>` registry with LRU + idle dispose; unit tests | Yes — index.ts uses it |
| 4b-1 | [phase-4b-1-agent-factory.md](phase-4b-1-agent-factory.md) | `agentFactory` (pi `Agent` ctor wired up with tools/skills/system prompt); rewrite `index.ts` to use SessionRegistry; no deletions yet | Yes — gates 4b-2 |
| 4b-2 | [phase-4b-2-cleanup.md](phase-4b-2-cleanup.md) | Delete `loop.ts`, `anthropic.ts`, `prompts.ts`, `polishText.ts(.test.ts)`; drop `@anthropic-ai/sdk` dep; final sidecar full-build check | Yes — UI consumes new event shape |
| 5 | [phase-5-tauri-snapshot.md](phase-5-tauri-snapshot.md) | Tauri: on hotkey, ask sidecar (raw kind) for `{paragraphIndex, preview}`; emit on `spotlight:invoke` | No — independent of phase 6 |
| 6a | [phase-6a-spotlight-preview.md](phase-6a-spotlight-preview.md) | Spotlight UI shows "📄 第 N 段：『preview…』" strip | No — independent of 6b |
| 6b | [phase-6b-pi-events.md](phase-6b-pi-events.md) | Frontend atoms parse pi-native event names; main-window event rendering updated | No |
| 7 | [phase-7-verify-and-cleanup.md](phase-7-verify-and-cleanup.md) | Run all verification commands; manual e2e with real Word; final cleanup of orphan files | — |

---

## Worktree

All work happens on a new worktree branch. **Phase 0 step 1 creates it.** Subagent-driven implementation should `cd` into that worktree before any task in any phase.

---

## Verification commands (W1 acceptance gate)

These must all pass before claiming W1 done. Phase 7 is responsible for running them in order.

```bash
# 1. driver builds
bun run driver:build

# 2. driver Roslyn unit tests (defined in phase 1)
bun run scripts/test-driver.ts

# 3. sidecar bun --compile (already proved feasible in phase 0)
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/sidecar-test.exe src/index.ts

# 4. sidecar unit tests
cd apps/agent && bun test

# 5. manual e2e (with real Word + ANTHROPIC_API_KEY set):
#    spotlight → 公文 polish → tracked revision visible
```

---

## Out of scope (do NOT do in W1)

- **Sandbox / security hardening for `exec_csharp`** — W1 is **functional capability validation**: prove the LLM can actually drive Office via C# scripts end-to-end. Sandbox / privilege restriction / code review gating gets a dedicated design pass after we have evidence the capability works. Do NOT bolt on partial sandbox measures during W1; they'd just confuse the validation.
- Settings panel for model / API key (W2)
- API key encryption / OS keychain (W2)
- Skill catalog UI / user-uploaded skills
- Cross-process session persistence
- Slash commands (`/skill:polish-gongwen`)
- Permission gating UX (every `exec_csharp` auto-runs in W1)
- Multiple MCP servers / non-Anthropic providers

If a task seems to drift toward any of these, stop and check with the user.

---

## Key constraints lifted from spec / memory

- **No `@anthropic-ai/claude-agent-sdk`, no `claude-agent-acp`, no `agent-client-protocol`, no `pi-coding-agent` (the package).** Only `pi-agent-core` + `pi-ai`. See `~/.claude/projects/.../memory/architecture-direction.md`.
- **Pin pi versions** (not caret). OpenClaw history shows minor bumps break (`cacheControlTtl` → `cacheRetention`).
- **Track Changes invariant** is enforced via skill text + `Track()` global. Don't reject scripts in driver — soft constraint via prompt.
- **Global FIFO** chat queue stays — even with `Map<sid,Agent>`, only one chat runs at a time across all sessions.
- **Pinned target = paragraphIndex** (not char offsets), per Q4 decision.
- **Frontend consumes pi-native events directly** — no translation layer in sidecar (Q5 decision).

---

## Execution choice

After all phases written, you'll be asked to choose between subagent-driven or inline execution.
