# Phase 7 result — W1 acceptance

**Date:** 2026-06-06
**Branch:** `pi-rewrite` (worktree at `.claude/worktrees/pi-rewrite`)
**Status:** ⏳ AUTOMATED PORTION COMPLETE — manual e2e PENDING USER

The automated subagent ran every non-interactive verification listed in
`phase-7-verify-and-cleanup.md`. The six manual end-to-end checkpoints in
§7.2 must be driven by the human against a live Word session before W1 can
be declared ACCEPTED. They are marked **⏳ PENDING USER** below.

## Verification matrix

| Check | Result | Notes |
|---|---|---|
| `bunx tsc --noEmit` apps/agent | ✅ | Zero errors. |
| `bunx tsc --noEmit` apps/desktop | ✅ | Zero errors. |
| `cargo build` apps/desktop/src-tauri | ✅ | `Finished dev profile … in 11.77s`. |
| `bun run driver:build` | ✅ | `WordDriver -> …\Debug\net48\WordDriver.exe` (0 warnings, 0 errors, 1.52s). |
| `bun build --compile` apps/agent → exe | ✅ | 2455 modules bundled (~7.9s); compile 372ms; output `/tmp/sidecar-w1-final.exe` ≈ 120 MB. |
| `bun run scripts/test-driver.ts` | ✅ | All 6 fixtures pass (integer return, compile error, runtime error, stdout, empty_code, shutdown). |
| `bun test` apps/agent | ✅ | **42 pass / 0 fail / 98 expect()** across 7 files in 4.43s. |
| `bun test src/state/piEventBridge.test.ts` apps/desktop | ✅ | 10 pass / 0 fail / 25 expect() in 43ms. |
| Manual e2e §7.2.1 — Open Word with sample doc | ⏳ PENDING USER | Automated subagent cannot drive Word interactively. |
| Manual e2e §7.2.2 — Launch app (`bun run dev`); ready event | ⏳ PENDING USER | |
| Manual e2e §7.2.3 — Hotkey Ctrl+Alt+J → spotlight strip | ⏳ PENDING USER | Verify `📄 第 N 段：「…」` matches the visible Word paragraph. |
| Manual e2e §7.2.4 — `把这段改成公文风格` → tracked revision + `[AI: …]` comment | ⏳ PENDING USER | Capture screenshot for sign-off. |
| Manual e2e §7.2.5 — Multi-turn `再缩短 30%` reuses session | ⏳ PENDING USER | Verify same `sessionId`; no skill re-read. |
| Manual e2e §7.2.6 — `while(true){}` triggers driver_restart + recovery | ⏳ PENDING USER | Record recovery time-from-prompt. |
| Manual e2e §7.2.7 — Ctrl-C clean shutdown, no zombie WordDriver.exe | ⏳ PENDING USER | |

## Pre-flight evidence

```
$ bunx tsc --noEmit (apps/agent)
EXIT: 0

$ bunx tsc --noEmit (apps/desktop)
EXIT: 0

$ cargo build (apps/desktop/src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 11.77s
EXIT: 0

$ bun run driver:build
$ cd drivers/WordDriver && dotnet build -c Debug
  WordDriver -> …\worktrees\pi-rewrite\drivers\WordDriver\bin\Debug\net48\WordDriver.exe
Build succeeded.
    0 Warning(s)
    0 Error(s)
EXIT: 0

$ bun build --compile --target=bun-windows-x64 --outfile /tmp/sidecar-w1-final.exe src/index.ts
[7.895s]  bundle  2455 modules
 [372ms] compile  …\Temp\sidecar-w1-final.exe
EXIT: 0
-rwxr-xr-x  120,563,712 bytes  /tmp/sidecar-w1-final.exe
```

## Test gauntlet evidence

```
$ bun run scripts/test-driver.ts
[driver] ready
✓ t1: integer return — {"id":"t1","result":3,"stdout":"","error":null}
✓ t2: compile error reported — compile_error: (1,14): error CS1040: Preprocessor directives must appear as the first non-whitespace character on a line
✓ t3: runtime error reported — runtime_error: DivideByZeroException: Attempted to divide by zero.
✓ t4: stdout captured — "hello\r\n42\r\n"
✓ t5: empty_code error — empty_code
✓ t6: shutdown returns bye:true — {"id":"t6","result":{"bye":true},"stdout":"","error":null}

All driver smoke checks passed.
EXIT: 0

$ cd apps/agent && bun test
bun test v1.3.11 (af24e281)
 42 pass
 0 fail
 98 expect() calls
Ran 42 tests across 7 files. [4.43s]
EXIT: 0

$ cd apps/desktop && bun test src/state/piEventBridge.test.ts
bun test v1.3.11 (af24e281)
 10 pass
 0 fail
 25 expect() calls
Ran 10 tests across 1 file. [43.00ms]
EXIT: 0
```

## Cleanup actions

- Deleted `scripts/test-sidecar.ts` and `scripts/test-chat.ts` (v0.3 NDJSON-RPC harnesses superseded by `scripts/test-driver.ts` and the unit suites).
- Deleted `apps/agent/scripts/smoke-pi-bundle.ts` (phase-0 throwaway; result captured in `phase-0-result.md`); the now-empty `apps/agent/scripts/` directory was removed by git.
- Updated `README.md` "Headless smoke tests" section to reference the current entry points (`bun run scripts/test-driver.ts`, `bun test apps/agent`, `bun test apps/desktop src/state/piEventBridge.test.ts`).
- `package.json` `driver:test` confirmed at `"bun run scripts/test-driver.ts"` (no fix needed).
- `idToSession` fallback in `apps/desktop/src/App.tsx` retained: the map is still load-bearing for the raw driver-RPC slash-command path (lines 296–340 set the map at line 307 so the no-`sessionId` `{id, result/error}` driver replies can be routed back to the originating session). For the W1 agent_event flow it IS dead, but removing the writes selectively risks breaking the slash path. Filed as a follow-up — see "Open issues" below.

Cleanup commit: `3ea8525  chore: remove v0.3 test scripts and phase-0 smoke`.

## Open issues / follow-ups

Carried forward from earlier phase reviews — none are W1 blockers, all
documented for the post-W1 backlog.

### Phase 2 minor items (deferred from phase-2 review)
- **MockDriver hang fidelity** — the in-process MockDriver used by supervisor unit tests does not perfectly mirror the real WordDriver's stdin/stdout pump backpressure under hang conditions. Current tests are sufficient for the supervisor logic, but a higher-fidelity mock would let us cover edge cases like "process responds to one call, then hangs on the next" without wallclock waits.
- **`runScript skipIf` warning** — the integration test uses `test.skipIf(!process.env.MSWORD_DRIVER_AVAILABLE)`-style gating; in some Bun versions the skip surfaces as a warning rather than an info line. Cosmetic.
- (`supervisor as any` was removed during the phase-4b-2 work — no further action needed.)

### Phase 4b-1 minor items (deferred from phase-4b review)
- **`parse_error` shape in protocol header doc** — `apps/agent/src/index.ts` lines 4–14 describe stdin/stdout JSON shapes but don't document the `{id:null, kind:"error", error:"parse_error: …"}` reply that `handleLine` emits when stdin yields invalid JSON. Add to the header comment when convenient.
- **`paragraphIndex` 1-based comment** — `composePromptWithTarget` and the spotlight bridge agree on 1-based paragraph indices (matching Word COM), but no inline comment near the prompt builder reminds future maintainers of this. One-line note would prevent 0-based regressions.
- **`model as any` cast retry** — `agentFactory.ts` casts the Anthropic model id through `as any`; pi-ai's typing accepts a narrower set than what Anthropic's SDK accepts. Recheck after the next pi-ai bump.
- **`PosixNodeExecutionEnv` promotion** — currently a private wrapper inside `apps/agent/src/index.ts`. If a second consumer arrives (e.g. a parallel driver using the same skills loader), promote it to a shared module under `apps/agent/src/agent/`.
- **`buildSystemPrompt` `disableModelInvocation` test** — there's no unit test that flips the flag and asserts the prompt suppresses model-invocation language. Add one if the prompt evolves.
- **Sidecar shutdown abort/drain** — `runShutdown` calls `registry.disposeAll()` then `supervisor.shutdown()` then `process.exit(0)`; in-flight `runChat` promises are not explicitly awaited or aborted. The unsubscribe path prevents stray events but a graceful drain pass would be cleaner before `process.exit`.

### Phase 6b decision
- **`idToSession` map removal in `App.tsx`** — kept for the raw driver-RPC slash-command path (no `sessionId` envelope). Once the slash-command flow is migrated to envelope-based sessionIds (or removed entirely if developer-debug-only), the map and its writes can be deleted. Tracked separately.

### Smoke-test stdin-pipe quirk
- **Windows stdin-pipe quirk on the bun --compile sidecar exe** — informational only. When the compiled sidecar is launched from a non-Tauri shell, stdin can buffer differently than under Bun's dev runtime. Does not affect the Tauri runtime, which uses `tauri-plugin-shell`'s pty semantics. Documented here in case a future smoke harness needs to drive the exe directly.

## Commit log

```
3ea8525 chore: remove v0.3 test scripts and phase-0 smoke
78374ff feat(ui): App.tsx routes pi-shaped events through bridge
085bf03 test(ui): pi event bridge unit tests
12cb7bc feat(ui): pi event → DebugEvent bridge
58d8657 style(spotlight): harmonise preview strip colors with light card theme
06a0253 feat(spotlight): paragraph preview strip
c917d5f feat(spotlight): SpotlightInvoke type adds paragraph_index + preview
6f68032 feat(tauri): include paragraph snapshot in spotlight:invoke event
8b7aa08 feat(tauri): fetch_snapshot_blocking helper (best-effort)
8d6414f feat(tauri): SNAPSHOT_SCRIPT for spotlight paragraph preview
798d739 fix(sidecar): annotate Supervisor factory param to satisfy noImplicitAny
b99570f deps(sidecar): drop direct @anthropic-ai/sdk (pi-ai owns LLM)
67346dd chore(sidecar): delete orphaned v0.3 loop/anthropic/prompts/polishText
29f918e fix(sidecar): explicit unsubscribe from agent on session dispose
1017098 fix(sidecar): posix-normalize NodeExecutionEnv paths on Windows
87e81b6 feat(sidecar): rewrite index.ts around pi Agent + SessionRegistry
2bb9418 feat(sidecar): agent factory wiring tools + skills + Anthropic
ddd023a feat(sidecar): system prompt builder with skills index
e519ca8 deps(sidecar): add pi-agent-core, pi-ai, typebox
dfa8558 test(sidecar): SessionRegistry unit tests (LRU + idle eviction)
28da7eb feat(sidecar): SessionRegistry with LRU + idle eviction
97e2f01 test(sidecar): exec_csharp unit tests with mock supervisor
819310b feat(sidecar): exec_csharp AgentTool wrapping supervisor.runScript
5d62b43 chore(sidecar): phase-3b minor cleanup (dead try, unused import, symlink note)
ca895e1 test(sidecar): read tool unit tests
855ab42 feat(sidecar): read AgentTool with skills/docs whitelist
aebc220 feat(sidecar): allowed-roots resolver for read tool
ace99d6 feat(skills): bundle 5 SKILL.md (W1 phase 3a)
48b4c16 chore: drop @msword/rpc-schema package and gen script
055b2d9 test(sidecar): integration smoke against real driver
49be7c0 test(sidecar): supervisor unit tests for runScript API
21f804c refactor(sidecar): supervisor.runScript replaces call/callRaw
8574ff7 refactor(sidecar): driverClient → runScript single-action API
c21d71b chore(driver): remove old method dispatch files
1573a00 test(driver): smoke fixtures + lazy Word attach
42019a0 feat(driver): single-action protocol — {id,code} ↔ {id,result,stdout,error}
c476e1a feat(driver): Roslyn host with Globals (Doc/App/Track/Print)
640bc17 refactor(driver): extract RevisionScope to top-level class
976f91f deps(driver): add Roslyn scripting package
301396c docs(phase-0): record bun --compile smoke result
b24bd46 test(phase-0): bun --compile pi-agent-core smoke (passes)
d9a34d1 deps: add typebox (transitive of pi-agent-core, needed for AgentTool params)
04c0c17 deps: pin pi-agent-core and pi-ai (W1 phase 0)
```

(43 commits total on `pi-rewrite` ahead of `main`.)

## What the user must do before W1 is ACCEPTED

1. Drive the six manual e2e checkpoints in §7.2 of the plan against a real
   Word session (the automated subagent cannot do this).
2. Capture the §7.2.4 Word screenshot showing tracked revision + `[AI: 公文]`
   comment, and inline it into the **Screenshots** section below.
3. Flip each ⏳ PENDING USER row in the matrix to ✅ (or ❌ + remediation
   notes) once observed.
4. Update the top-line **Status** to `✅ ACCEPTED` (or `❌ NOT ACCEPTED`)
   and decide whether the branch ships directly to `main` or holds at
   `w1-pi-rewrite-rc1` per §"Phase 7 acceptance" of the plan.

## Screenshots

(paste the §7.2.4 Word screenshot here once captured)
