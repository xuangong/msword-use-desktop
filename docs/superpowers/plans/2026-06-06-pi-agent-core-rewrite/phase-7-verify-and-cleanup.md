# Phase 7 — End-to-end verification + final cleanup

**Goal:** Run every automated verification command, perform the manual end-to-end smoke with real Word, delete remaining orphaned v0.3 files, and write a phase-7 result note that documents the W1 acceptance.

**No new features in this phase.** It's the gate between "code written" and "W1 declared done".

**Files:**
- Delete (final orphan sweep): `scripts/test-sidecar.ts`, `scripts/test-chat.ts` (v0.3 NDJSON-RPC test scripts that no longer apply)
- Delete: `apps/agent/scripts/smoke-pi-bundle.ts` (phase 0 throwaway)
- Possibly modify: `apps/desktop/src/App.tsx` to remove the `idToSession` fallback if 6b proved it unnecessary
- Create: `docs/superpowers/plans/2026-06-06-pi-agent-core-rewrite/phase-7-result.md` — sign-off note

**Why phase 7:** Phases 1-6 each had local verification, but only end-to-end exercises the chain *together* — the 6b bridge against a real pi event stream from a real Roslyn-driven Word session. Bugs that survive unit tests usually live in the seams.

---

## Pre-flight: full repo build

Before running anything else, prove the repo builds end-to-end. Any failure here means an earlier phase's "acceptance" wasn't real.

- [ ] **Task 7.0.1: TypeScript over the whole repo**

```bash
cd apps/agent && bunx tsc --noEmit
cd ../..
cd apps/desktop && bunx tsc --noEmit
cd ../..
```

Expected: zero errors in both. Pre-existing `App.tsx` warnings about v0.3 chat code may surface; if they're errors (not warnings), we have to fix them before claiming W1 done. Most common offender: stale references to `polish_text` in the `App.tsx` debug rendering. If found, edit them to either:
- Render via the generic `system` event path (preferred — least change), or
- Delete the dead code if the surrounding block is purely v0.3.

- [ ] **Task 7.0.2: Cargo build for Tauri**

```bash
cd apps/desktop/src-tauri && cargo build
cd ../../..
```

Expected: succeeds.

- [ ] **Task 7.0.3: Driver build**

```bash
bun run driver:build
```

Expected: succeeds.

- [ ] **Task 7.0.4: Sidecar bun --compile**

```bash
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/sidecar-w1-final.exe src/index.ts
cd ../..
```

Expected: a working exe.

If anything fails, **stop and fix** before continuing.

---

## Automated test gauntlet

- [ ] **Task 7.1.1: Driver Roslyn smoke**

```bash
bun run scripts/test-driver.ts
```

Expected: 6 ticks (from phase 1).

- [ ] **Task 7.1.2: Full sidecar test suite**

```bash
cd apps/agent && bun test
cd ../..
```

Expected: every test from phases 1-4b passes. Roughly 25-30 tests across:

- `src/rpc/ndjson.test.ts`
- `src/rpc/supervisor.test.ts`
- `src/rpc/runScript.test.ts` (driver-aware integration; needs driver built)
- `src/agent/buildSystemPrompt.test.ts`
- `src/agent/sessionRegistry.test.ts`
- `src/agent/tools/read.test.ts`
- `src/agent/tools/execCsharp.test.ts`

Snapshot output of `bun test` to your terminal log so you can paste it in the phase-7 result note (Task 7.4.1).

- [ ] **Task 7.1.3: Frontend bridge tests**

```bash
cd apps/desktop && bun test src/state/piEventBridge.test.ts
cd ../..
```

Expected: 10 ticks (from phase 6b).

If `bun test` from `apps/desktop` doesn't find or run the test, check that phase 6b's `package.json` adjustment (adding `@types/bun`) actually committed. If the file didn't get the `@types/bun` dev dep, run:
```bash
cd apps/desktop && bun add -d @types/bun
cd ../..
```
and re-test. Commit the package.json change as part of this phase (`chore(ui): add bun-types for tests`).

---

## Manual end-to-end smoke

This is the W1 north-star test. Do not skip.

**Setup checklist:**
- [ ] Microsoft Word installed and runnable
- [ ] At least one `.docx` file with a few Chinese paragraphs (use `gongwen_sample.docx` from the v1 repo, or create one with 5-6 short Chinese paragraphs)
- [ ] `ANTHROPIC_API_KEY` exported in the shell where you'll `bun run dev`
- [ ] Latest pi packages installed (`bun install` from worktree root within the last commit)
- [ ] Driver built (`bun run driver:build`)

- [ ] **Task 7.2.1: Open Word with the sample doc**

Click into a body paragraph (not a heading). Note the visible text — you'll verify the agent picks the right paragraph.

- [ ] **Task 7.2.2: Launch the app**

```bash
bun run dev
```

Expected:
- Tauri main window opens
- Sidecar `ready` event reaches the UI (visible as a system event in the debug panel)
- No red error log
- Within ~2s, the main window's status indicator shows "ready" / driver gen=1

- [ ] **Task 7.2.3: Hotkey from Word**

Click into Word's body paragraph (e.g. paragraph 3), press **Ctrl+Alt+J**.

Expected:
- Spotlight window opens within 200ms
- Top strip shows `📄 第 3 段：「<first 80 chars>」` matching what you can see in Word
- Input field is focused

If the strip is missing or the index is wrong: see phase 5 / 6a troubleshooting.

- [ ] **Task 7.2.4: Submit a polish prompt**

Type `把这段改成公文风格` and press Enter.

Expected progression in the spotlight transcript (or main window debug panel):
1. **A user message** appears (your prompt, including the `[当前操作目标] 段落索引: 3` preamble)
2. **Streamed assistant text** ("好的，让我先看一下当前段落…" or similar — model varies)
3. **A `tool_call`** for `read("skills/polish-gongwen/SKILL.md")` — this is the progressive-disclosure step. The skill body returns and feeds into the next turn.
4. **One or more `tool_call`s** for `exec_csharp(code)` — first probably reading the paragraph (`Print(Doc.Paragraphs[3].Range.Text);`), then writing (`Track(() => { Doc.Paragraphs[3].Range.Text = "..."; ... });`). Each tool call shows compile success and the script's `result`/`stdout` in the debug panel.
5. **A summary text** like "已将第 3 段改写为公文体..."
6. **A `done` event** — turn ends.

Switch to Word:
- Paragraph 3 should now show a **tracked revision** (red strikethrough on old text + the new 公文 text in another color)
- A **Word comment** with `[AI: 公文] ...` should be attached to the changed range, with author "msword-use AI"

If any of the above are missing:
- **No tracked revision**: agent skipped `Track(...)`. Check the `exec_csharp` tool_call's input in the debug panel — does it use `Track(() => {...})`? If not, the skill priming didn't take effect; check that `read` was called and the SKILL.md content was actually returned.
- **Comment missing**: comments can fail silently in some Word versions if the range is mid-edit. Not a hard failure for W1; document in phase-7 result.
- **Wrong paragraph rewritten**: check the preamble's `paragraphIndex` arrived correctly. The bootstrap_text showed up in the user message?

Snapshot the Word screenshot showing the tracked revision + comment for the phase-7 result note (Task 7.4.1).

- [ ] **Task 7.2.5: Multi-turn follow-up**

In the main window (NOT spotlight — main window for follow-ups), select the same session, type `再缩短 30%` and submit.

Expected:
- The same `sessionId` is reused
- pi's in-memory message history feeds the prior context to the LLM
- Model says "好的，进一步缩短" or similar (no need to re-read the skill — it's already in this session's history)
- A new tracked revision appears on the same paragraph, shorter than the prior one (Word now shows two stacked revisions; that's normal Track Changes behavior)

If the model asks "操作哪一段？" it didn't carry context — check that:
- `App.tsx` is reusing `currentSessionId` for the follow-up `bun_send` call
- The sidecar's `SessionRegistry.getOrCreate(sid)` is hitting the existing Agent instance (verify by reading `[main]` stderr from sidecar — there should be no new "agent factory" log on the second prompt)

- [ ] **Task 7.2.6: Driver hang recovery**

This is a stress test of the supervisor → tool error loop. Hit Ctrl+Alt+J, type:

```
请在 Word 里运行一段 C# 代码：while(true){}，看看会发生什么
```

Expected:
- Agent calls `exec_csharp` with `while(true){}` (or a translation)
- Supervisor's 10s timeout fires
- A `driver_restart` event appears in the main window
- The tool_result text says `error: driver hung and was restarted...`
- The model receives the error and reports back ("看起来脚本陷入了死循环；驱动已重启")

This proves the runtime resilience layer works end-to-end. Document the time-from-prompt-to-recovery.

- [ ] **Task 7.2.7: Stop dev**

Ctrl-C. Confirm clean shutdown — no zombie WordDriver.exe in Task Manager. (`taskkill /im WordDriver.exe /f` if there is one and document it as a follow-up bug.)

---

## Cleanup: orphan files

- [ ] **Task 7.3.1: Verify v0.3 NDJSON test scripts are dead**

```bash
grep -rEn "test-sidecar|test-chat" --include="*.ts" --include="*.json" --include="*.md" .
```

Expected output: only matches in the phase plan files (i.e., this and prior phase docs reference them in narrative text). If anything live still imports / runs them, fix or remove.

- [ ] **Task 7.3.2: Delete v0.3 test scripts**

```bash
git rm scripts/test-sidecar.ts scripts/test-chat.ts 2>/dev/null
```

If either file doesn't exist (the v0.3 repo state may differ), `git rm` will report — that's fine, just remove the line.

- [ ] **Task 7.3.3: Delete the phase-0 smoke script**

It served its purpose; phase 0's smoke result is captured in `phase-0-result.md`.

```bash
git rm apps/agent/scripts/smoke-pi-bundle.ts
rmdir apps/agent/scripts 2>/dev/null || true
```

- [ ] **Task 7.3.4: Verify root `package.json` `driver:test` still resolves**

```bash
cat package.json | grep driver:test
```

Expected: `"driver:test": "bun run scripts/test-driver.ts"` (set in phase 2). If somehow it still references `test-sidecar.ts`, fix it now.

- [ ] **Task 7.3.5: Look for `idToSession` fallback in App.tsx and decide its fate**

The phase 6b plan said to leave the v0.3 `idToSession` map in `App.tsx` as a fallback while verifying. After 7.2.5's multi-turn proved sessionIds arrive correctly in envelopes, the fallback is unused.

```bash
grep -n "idToSession" apps/desktop/src/App.tsx
```

If references remain:
- Read the surrounding context. If the `idToSession` map is ONLY used to derive sessionIds from request ids, and 7.2 confirms envelopes deliver sessionId directly, **delete the map and its writes**.
- If it's also used for other purposes (e.g., chat:start announcement plumbing), leave it.

The deletion is optional; if uncertain, skip and file a follow-up cleanup task.

- [ ] **Task 7.3.6: Commit the cleanup**

```bash
git add -A
git status
git commit -m "chore: remove v0.3 test scripts and phase-0 smoke"
```

---

## Sign-off note

- [ ] **Task 7.4.1: Write phase-7 result**

Create `docs/superpowers/plans/2026-06-06-pi-agent-core-rewrite/phase-7-result.md`:

```markdown
# Phase 7 result — W1 acceptance

**Date:** <YYYY-MM-DD>
**Branch:** pi-rewrite (worktree at .claude/worktrees/pi-rewrite)
**Status:** ✅ ACCEPTED / ❌ NOT ACCEPTED

## Verification matrix

| Check | Result | Notes |
|---|---|---|
| `bunx tsc --noEmit` apps/agent | ✅ / ❌ | |
| `bunx tsc --noEmit` apps/desktop | ✅ / ❌ | |
| `cargo build` apps/desktop/src-tauri | ✅ / ❌ | |
| `bun run driver:build` | ✅ / ❌ | |
| `bun build --compile` apps/agent → exe | ✅ / ❌ | |
| `bun run scripts/test-driver.ts` | ✅ / ❌ | 6 fixtures |
| `bun test` apps/agent | ✅ / ❌ | <N> tests |
| `bun test src/state/piEventBridge.test.ts` | ✅ / ❌ | 10 tests |
| Manual e2e: spotlight → 公文 polish → tracked revision | ✅ / ❌ | screenshot below |
| Manual e2e: multi-turn follow-up uses same session | ✅ / ❌ | |
| Manual e2e: driver hang → restart → recovery | ✅ / ❌ | recovery time: <N>s |

## Screenshots

(paste the Word screenshot from 7.2.4 showing tracked revision + AI comment)

## Open issues / followups

- (anything you noticed but punted)
- (e.g., "comments fail silently in Word LTSC 2021 — needs investigation")
- (e.g., "spotlight transcript scrolls past long tool_results awkwardly — UX polish for follow-up worktree")

## Commit log

(paste output of `git log --oneline main..HEAD` from the worktree — should be ~30 commits)
```

Fill the sections honestly. If any verification box is ❌, list a remediation plan or escalate.

- [ ] **Task 7.4.2: Commit the result note**

```bash
git add docs/superpowers/plans/2026-06-06-pi-agent-core-rewrite/phase-7-result.md
git commit -m "docs(phase-7): W1 acceptance"
```

---

## Phase 7 acceptance (and W1 acceptance)

W1 is done iff:

- ✅ Every box in `phase-7-result.md` matrix is ✅
- ✅ A Word screenshot exists in the result showing the AI's tracked revision + `[AI: ...]` comment
- ✅ Cleanup commits removed v0.3 test scripts and phase-0 smoke
- ✅ The branch is in a state where merging to main would not regress any v0.3 capability the user actually used (foreground capture, hotkey, chat, spotlight)

**If W1 accepted:** phase-7 result is the merge gate. The branch can either:
1. Be merged to `main` directly (if the user is comfortable shipping the new event shape and frontend changes immediately), or
2. Be tagged `w1-pi-rewrite-rc1` and held for parallel W2 (settings panel) work, then merged together.

**If W1 not accepted:** the result note's "Open issues" section is the action list. Stop, address them, re-run phase 7 verification.

---

## What's next (out of W1)

- **W2 spec & plan:** Settings panel for model + API key (separate worktree, separate spec).
- **Sandbox design pass:** Per `memory/w1-capability-first.md`, now that capability is proven, an `exec_csharp` sandbox design doc gets written. Inputs include any "scary" scripts the LLM wrote during W1 e2e (capture them in the result note's Open issues).
- **Skills authoring iteration:** With evidence of how the LLM actually uses the bundled skills, refine wording. New skills (e.g. `polish-shangwu`, `polish-wenan`) get added incrementally without code changes.
- **Persistence:** Optional, only if user demand surfaces ("I lose my chat history when I restart"). pi's `harness/session/jsonl-repo.ts` is ready when needed.
