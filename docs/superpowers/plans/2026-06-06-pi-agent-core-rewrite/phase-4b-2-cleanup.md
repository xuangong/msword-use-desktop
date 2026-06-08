# Phase 4b-2 — Cleanup: delete orphan files + drop `@anthropic-ai/sdk`

**Goal:** Remove all the v0.3 files orphaned by 4b-1's rewrite. Drop the now-unused `@anthropic-ai/sdk` direct dependency. Confirm full project type-check + tests + compile-bundle still succeed end-to-end.

**Files to delete:**
- `apps/agent/src/agent/loop.ts`
- `apps/agent/src/agent/prompts.ts`
- `apps/agent/src/agent/errors.ts` (was used by loop.ts; nothing else imports it after 4b-1)
- `apps/agent/src/agent/tools/polishText.ts`
- `apps/agent/src/agent/tools/polishText.test.ts`
- `apps/agent/src/llm/anthropic.ts`
- `apps/agent/src/llm/` (whole dir, becomes empty)

**Files to modify:**
- `apps/agent/package.json` — remove `@anthropic-ai/sdk` from `dependencies`

**Why this is its own phase:** 4b-1 introduced new code; if anything broke, revert was 1 commit. 4b-2 is the inverse — only deletions, low-risk if 4b-1 passed. Splitting protects the rollback story.

**Sanity check before starting:** confirm 4b-1 actually finished. The phase 4b-1 acceptance section ends with "Compiled exe handles `{"kind":"shutdown"}` and exits cleanly." If you can't replay that, **stop** and fix 4b-1 before proceeding.

---

### Task 4b-2.1: Verify nothing live still imports the orphan files

Just to be safe — `grep` for imports before deleting.

- [ ] **Step 1: Search for imports**

Run from worktree root:
```bash
grep -rEn "from \"\\./agent/loop\"|from \"\\./agent/prompts\"|from \"\\./agent/errors\"|from \"\\.\\./agent/loop\"|from \"\\.\\./agent/prompts\"|from \"\\.\\./agent/errors\"|from \"\\.\\./llm/anthropic\"|from \"\\./llm/anthropic\"|from \"\\.\\./tools/polishText\"|from \"\\./tools/polishText\"" apps/agent/src
```

Expected output: **empty** (no matches). If anything matches, that's a live import you missed in 4b-1; STOP and go fix 4b-1 first.

- [ ] **Step 2: Same check, but for the file *contents* themselves importing each other**

```bash
grep -rEn "from \"\\.\\./errors\"|from \"\\./errors\"" apps/agent/src/agent
```

Expected output: lines from inside `loop.ts` and possibly `polishText.ts` referring to `errors.ts`. **Those are inside the orphans we're about to delete — fine.** If anything **outside the orphans** appears, investigate before deleting.

---

### Task 4b-2.2: Delete the files

- [ ] **Step 1: Remove with git**

```bash
git rm apps/agent/src/agent/loop.ts \
       apps/agent/src/agent/prompts.ts \
       apps/agent/src/agent/errors.ts \
       apps/agent/src/agent/tools/polishText.ts \
       apps/agent/src/agent/tools/polishText.test.ts \
       apps/agent/src/llm/anthropic.ts
# Remove the now-empty llm directory
rmdir apps/agent/src/llm 2>/dev/null || true
```

- [ ] **Step 2: Confirm tree**

```bash
find apps/agent/src -type f -name "*.ts" | sort
```

Expected output:
```
apps/agent/src/agent/agentFactory.ts
apps/agent/src/agent/buildSystemPrompt.ts
apps/agent/src/agent/buildSystemPrompt.test.ts
apps/agent/src/agent/sessionRegistry.ts
apps/agent/src/agent/sessionRegistry.test.ts
apps/agent/src/agent/skillsRoot.ts
apps/agent/src/agent/tools/execCsharp.test.ts
apps/agent/src/agent/tools/execCsharp.ts
apps/agent/src/agent/tools/read.test.ts
apps/agent/src/agent/tools/read.ts
apps/agent/src/index.ts
apps/agent/src/rpc/driverClient.ts
apps/agent/src/rpc/ndjson.test.ts
apps/agent/src/rpc/ndjson.ts
apps/agent/src/rpc/runScript.test.ts
apps/agent/src/rpc/supervisor.test.ts
apps/agent/src/rpc/supervisor.ts
```

If extra files appear or some are missing, reconcile with the list above before continuing.

- [ ] **Step 3: Commit deletion**

```bash
git commit -m "chore(sidecar): delete orphaned v0.3 loop/anthropic/prompts/polishText"
```

---

### Task 4b-2.3: Drop `@anthropic-ai/sdk` from `apps/agent/package.json`

Pi-ai talks to Anthropic for us. Our own `@anthropic-ai/sdk` import was only in `src/llm/anthropic.ts` (now deleted).

- [ ] **Step 1: Remove the dep**

Run from worktree root:
```bash
cd apps/agent && bun remove @anthropic-ai/sdk
cd ../..
```

`bun remove` updates both `package.json` and `bun.lock` and refreshes `node_modules`.

- [ ] **Step 2: Confirm `apps/agent/package.json`**

```bash
cat apps/agent/package.json
```

The `dependencies` block should now contain only:

```json
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.78.1",
    "@earendil-works/pi-ai": "0.78.1",
    "typebox": "<resolved version>"
  }
```

No `@anthropic-ai/sdk` line.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/package.json bun.lock
git commit -m "deps(sidecar): drop direct @anthropic-ai/sdk (pi-ai owns LLM)"
```

---

### Task 4b-2.4: Full sidecar type-check (now that nothing's broken)

- [ ] **Step 1: Run TypeScript on the whole sidecar**

```bash
cd apps/agent && bunx tsc --noEmit
cd ../..
```

Expected: **no errors**. Phase 4b-1 was allowed to leave orphan compile errors; 4b-2 cleans them up. If anything still errors, the typical culprits at this point are:

- A test file in `agent/tools/` still imports a deleted file → fix that import.
- A pi version mismatch (e.g. `@earendil-works/pi-ai` 0.78.1 expects `@earendil-works/pi-agent-core` 0.78.1; if you accidentally bumped one without the other, types diverge). Re-pin both with `bun add -E @earendil-works/pi-agent-core@0.78.1 @earendil-works/pi-ai@0.78.1`.
- `import.meta.dir` red squiggle from bun-types → if it persists, add `/// <reference types="bun-types" />` at the top of `index.ts`.

- [ ] **Step 2: If any error appears, fix in place before continuing**

Don't move on with TS errors. They will compound through phases 5-7.

---

### Task 4b-2.5: Full test run

- [ ] **Step 1: All sidecar tests**

```bash
cd apps/agent && bun test
cd ../..
```

Expected: every test from phases 1, 2, 3a-c, 4a passes. Total ~25-30 tests across:
- `src/rpc/ndjson.test.ts`
- `src/rpc/supervisor.test.ts`
- `src/rpc/runScript.test.ts` (skipped if no driver built)
- `src/agent/tools/read.test.ts`
- `src/agent/tools/execCsharp.test.ts`
- `src/agent/sessionRegistry.test.ts`
- `src/agent/buildSystemPrompt.test.ts`

If any test fails: don't paper over it. Fix the regression before moving on.

---

### Task 4b-2.6: Final compile-bundle smoke

We did this once in phase 4b-1. Now redo it to confirm deletions didn't break the bundle (e.g., a stale import that tsc didn't catch but the bundler picks up).

- [ ] **Step 1: Compile**

```bash
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/sidecar-w1-final.exe src/index.ts
cd ../..
```

Expected: clean build.

- [ ] **Step 2: Run a more thorough smoke**

Test that the compiled exe handles all four protocol kinds without crashing. **Note:** without `ANTHROPIC_API_KEY` set or a real driver, only `shutdown` reaches a clean exit; the others test parse + dispatch only.

```bash
{
  echo '{"kind":"raw","id":"r1","code":"return 1+1;"}'
  echo '{"kind":"abort","sessionId":"sid_does_not_exist"}'
  echo '{"kind":"shutdown"}'
} | /tmp/sidecar-w1-final.exe
```

Expected stdout (order may vary slightly for raw_response timing):
```
{"ready":true,"driverExe":"...","gen":1}
{"id":"r1","kind":"raw_response","result":null,"stdout":"","error":"<some driver error or restart>"}
```
Plus exit code 0.

The `raw` request will likely error because no real driver is running, **and that's the point** — we're verifying parse + dispatch + error envelope, not Word interaction. The `abort` for an unknown sid is a no-op.

If the process hangs after the `shutdown` line: there's a Promise leak in `runShutdown`. Investigate before continuing.

- [ ] **Step 3: Clean up the test exe**

```bash
rm /tmp/sidecar-w1-final.exe
```

No commit.

---

### Task 4b-2.7: Re-run the v0.3 driver-aware integration test

Phase 2 added `apps/agent/src/rpc/runScript.test.ts` which exercises a real `WordDriver.exe`. After 4b-2's deletions, run it again to confirm we haven't broken the supervisor pipe.

- [ ] **Step 1: Build driver if not already**

```bash
bun run driver:build
```

Expected: build succeeds.

- [ ] **Step 2: Run integration test**

```bash
cd apps/agent && bun test src/rpc/runScript.test.ts
cd ../..
```

Expected: 3 tests pass (or skipped if driver bin missing — but step 1 should ensure it isn't).

---

## Phase 4b-2 acceptance

- ✅ `apps/agent/src/agent/loop.ts`, `prompts.ts`, `errors.ts`, `tools/polishText.ts`, `tools/polishText.test.ts`, `apps/agent/src/llm/anthropic.ts` deleted.
- ✅ `apps/agent/src/llm/` directory removed.
- ✅ `apps/agent/package.json` no longer depends on `@anthropic-ai/sdk` directly.
- ✅ `bunx tsc --noEmit` over the whole sidecar reports zero errors.
- ✅ `bun test` runs the full sidecar suite, all green.
- ✅ `bun build --compile` produces a working sidecar exe that handles raw/abort/shutdown protocol messages.
- ✅ `bun test src/rpc/runScript.test.ts` against a freshly-built driver still passes.

If any criterion fails, **fix before starting phase 5**. Phase 5 (Tauri) will build on top of this; broken sidecar means broken Tauri integration.

---

## Sidecar is now done

End of phase 4. The sidecar, driver pipe, tools, skills, and session registry are all in their final W1 shape. Phases 5-7 are about:
- **Phase 5:** Tauri Rust side — invoke sidecar `kind:"raw"` on hotkey to capture the `{paragraphIndex, preview}` snapshot.
- **Phase 6:** Frontend — atoms parse pi-native event names; spotlight shows the paragraph preview strip.
- **Phase 7:** End-to-end verification with real Word, manual smoke checklist, final cleanup.

Take a moment to look at `git log --oneline` for the worktree before continuing — at this point you should see a coherent, reviewable commit history of:
```
deps: pin pi packages
test: bun --compile smoke
docs: phase 0 result
deps(driver): roslyn package
refactor: extract RevisionScope
feat(driver): roslyn host
feat(driver): single-action protocol
test(driver): smoke fixtures
chore(driver): remove old methods
refactor(sidecar): driverClient runScript
refactor(sidecar): supervisor runScript
test(sidecar): supervisor unit tests
test(sidecar): driver integration smoke
chore: drop @msword/rpc-schema
feat(skills): bundle 5 SKILL.md
feat(sidecar): allowed-roots resolver
feat(sidecar): read AgentTool
test(sidecar): read tool unit tests
feat(sidecar): exec_csharp AgentTool
test(sidecar): exec_csharp unit tests
feat(sidecar): SessionRegistry
test(sidecar): SessionRegistry unit tests
deps(sidecar): add pi-agent-core
feat(sidecar): system prompt builder
feat(sidecar): agent factory
feat(sidecar): rewrite index.ts
chore(sidecar): delete orphan v0.3 files
deps(sidecar): drop @anthropic-ai/sdk
```

Each commit is independently revertable. That's the win.
