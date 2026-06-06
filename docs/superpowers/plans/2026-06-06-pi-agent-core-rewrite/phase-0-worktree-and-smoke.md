# Phase 0 — Worktree + bun --compile smoke test

**Goal:** Establish an isolated worktree for W1 work. Validate that `bun build --compile` can bundle `@earendil-works/pi-agent-core` cleanly. **This phase gates packaging strategy** — pass means we keep the v0.3 single-exe sidecar model; fail means we switch to "bun runtime + script" packaging in a follow-up.

**Files:**
- Create worktree: `.claude/worktrees/pi-rewrite/` (via using-git-worktrees skill or `git worktree add`)
- Test/throwaway: `apps/agent/scripts/smoke-pi-bundle.ts` (created here, deleted at end of phase)

**Why this comes first:** The whole sidecar rewrite assumes pi can be bundled to `bun-agent-x86_64-pc-windows-msvc.exe` for Tauri sidecar distribution. If pi has dynamic require / native modules / runtime imports that defeat `bun --compile`, we have to know now (5 min smoke vs. last-minute scramble).

---

### Task 0.1: Create worktree

- [ ] **Step 1: Create the worktree off main**

Run:
```bash
git worktree add .claude/worktrees/pi-rewrite -b pi-rewrite main
cd .claude/worktrees/pi-rewrite
```

Expected: `Preparing worktree (new branch 'pi-rewrite')` followed by checkout. Branch `pi-rewrite` exists.

- [ ] **Step 2: Verify clean baseline still builds**

Run from worktree root:
```bash
bun install
bun run driver:build
```

Expected: bun reports no install errors; .NET driver builds (`Build succeeded. 0 Warning(s) 0 Error(s)`).

If either fails, you have an environment problem unrelated to this plan — stop and fix before continuing.

- [ ] **Step 3: Commit nothing yet**

This phase does not modify production files. Worktree is created; baseline is verified. No commit needed until Task 0.2.

---

### Task 0.2: Pin pi versions in workspace root

**File:** `package.json` (root) — note: `apps/agent/package.json` does NOT need pi yet; the smoke test installs at workspace root to avoid polluting `apps/agent` until phase 4.

- [ ] **Step 1: Add pi packages as devDependencies on root for the smoke test**

Edit root `package.json` to add a `dependencies` block (root has no `dependencies` currently). Use `bun add` to keep the lockfile honest.

Run from worktree root:
```bash
bun add -d -E @earendil-works/pi-agent-core@0.78.1 @earendil-works/pi-ai@0.78.1
```

The `-E` flag forces an **exact** version (no caret). This is a hard requirement per spec (OpenClaw was bitten by minor bumps).

Expected: `package.json` `devDependencies` now contains both lines with bare numeric versions, no `^` or `~`. `bun.lock` updated.

- [ ] **Step 2: Verify the pin**

Run:
```bash
grep -E '"@earendil-works' package.json
```

Expected output:
```
    "@earendil-works/pi-agent-core": "0.78.1",
    "@earendil-works/pi-ai": "0.78.1"
```

If you see `^0.78.1` or `~0.78.1`, re-run the add command with `-E`. **Do not proceed** with caret-pinned versions.

- [ ] **Step 3: Commit the pin**

```bash
git add package.json bun.lock
git commit -m "deps: pin pi-agent-core and pi-ai (W1 phase 0)"
```

---

### Task 0.3: Write the smoke-test script

**File (new):** `apps/agent/scripts/smoke-pi-bundle.ts`

The script must do enough work that `bun --compile` cannot tree-shake the pi imports away. Goal: prove the imports survive bundling AND the bundled exe runs without crashing.

- [ ] **Step 1: Create the smoke test script**

Create `apps/agent/scripts/smoke-pi-bundle.ts` with this content:

```typescript
/**
 * Phase 0 smoke test for `bun --compile` + pi-agent-core.
 *
 * Goal: prove that pi-agent-core can be bundled into a single Bun executable
 * for Tauri sidecar distribution. We do NOT call any LLM here — we just
 * instantiate `Agent`, register a tool, and verify the constructed object
 * has the expected shape.
 *
 * Pass: prints "smoke ok" and exits 0.
 * Fail: any exception OR exit code != 0.
 *
 * This file is throwaway — delete at end of phase 0.
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const dummyTool: AgentTool = {
  name: "noop",
  label: "noop",
  description: "Does nothing.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: null };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt: "smoke",
    model: getModel("anthropic", "claude-sonnet-4-5"),
    thinkingLevel: "off",
    tools: [dummyTool],
  },
  // Provide a stub getApiKey so Agent doesn't throw if anything probes it.
  // We never invoke prompt() in this smoke — just construction.
  getApiKey: async () => "sk-not-real",
});

if (typeof agent.subscribe !== "function") {
  console.error("FAIL: agent.subscribe is not a function");
  process.exit(1);
}
if (agent.state.tools.length !== 1) {
  console.error("FAIL: tools array did not survive construction");
  process.exit(1);
}

console.log("smoke ok");
process.exit(0);
```

Note: the model id `claude-sonnet-4-5` is what `pi-ai` 0.78.1 ships. If `getModel()` returns undefined, the Agent constructor throws — that's a genuine failure we want to surface. Adjust the literal id only if a smoke run reports `Unknown model: anthropic/claude-sonnet-4-5`; in that case, `bun -e 'console.log(require("@earendil-works/pi-ai").getModels("anthropic").map(m=>m.id))'` to see what's available.

- [ ] **Step 2: Run the smoke as plain Bun (not compiled yet) to make sure imports resolve**

Run from worktree root:
```bash
bun run apps/agent/scripts/smoke-pi-bundle.ts
```

Expected: `smoke ok`, exit 0.

If this fails (typically: `Unknown model`, missing dependency, peer-dep error), the bug is in the test fixture, not bundling. Fix the script first, then re-run.

- [ ] **Step 3: Now compile-bundle it**

Run:
```bash
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/smoke-pi.exe scripts/smoke-pi-bundle.ts
cd ../..
```

Expected: a file at `/tmp/smoke-pi.exe` exists. No errors during build.

If build fails: read the error. Most common breakers: dynamic `require()` in deep deps, `__dirname` usage, native `.node` modules. **Record the exact error verbatim and STOP** — the rest of this plan assumes packaging A. The user must decide whether to switch to packaging B.

- [ ] **Step 4: Run the compiled exe**

Run:
```bash
/tmp/smoke-pi.exe
```

(On Windows native bash, this is `c:/tmp/smoke-pi.exe` or `/tmp/smoke-pi.exe` depending on bash configuration. Use whichever path resolves.)

Expected: `smoke ok`, exit 0.

If the exe runs but errors with something like `Error: Cannot find module '...'`, the bundle is incomplete. Same handling as step 3: record + stop + ask user about packaging B.

- [ ] **Step 5: Commit the smoke script**

We commit the script even though it's throwaway, so the smoke result is reproducible by anyone reviewing the branch. We delete it in phase 7.

```bash
git add apps/agent/scripts/smoke-pi-bundle.ts
git commit -m "test(phase-0): bun --compile pi-agent-core smoke (passes)"
```

---

### Task 0.4: Document the smoke result

- [ ] **Step 1: Create a phase-0 result note**

Create `docs/superpowers/plans/2026-06-06-pi-agent-core-rewrite/phase-0-result.md`:

```markdown
# Phase 0 result

**Date:** <YYYY-MM-DD>
**bun --compile smoke for pi-agent-core 0.78.1:** ✅ PASS / ❌ FAIL

## Evidence
- `apps/agent/scripts/smoke-pi-bundle.ts` runs as plain Bun: ✅
- `bun build --compile` produces an exe: ✅
- The exe runs and prints `smoke ok`: ✅

## Decision
Packaging strategy: **A** (single-file `bun --compile` sidecar exe; current v0.3 model continues).

## Commands re-run by reviewer
```bash
bun run apps/agent/scripts/smoke-pi-bundle.ts
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/smoke-pi.exe scripts/smoke-pi-bundle.ts && /tmp/smoke-pi.exe
```

If FAIL was recorded instead, fill the "Decision" with the chosen packaging B path and stop here for user confirmation before phase 1.
```

Fill in the actual date and tick whichever boxes apply based on what you observed in Task 0.3.

- [ ] **Step 2: Commit the result note**

```bash
git add docs/superpowers/plans/2026-06-06-pi-agent-core-rewrite/phase-0-result.md
git commit -m "docs(phase-0): record bun --compile smoke result"
```

---

## Phase 0 acceptance

- ✅ Worktree `.claude/worktrees/pi-rewrite` exists, on branch `pi-rewrite`, off `main`.
- ✅ Root `package.json` pins `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to **exact** `0.78.1` (no caret).
- ✅ `apps/agent/scripts/smoke-pi-bundle.ts` exists and runs successfully both via `bun run` and as a `bun --compile`'d exe.
- ✅ `phase-0-result.md` records the outcome.

If any of the above is missing, do not start phase 1.
