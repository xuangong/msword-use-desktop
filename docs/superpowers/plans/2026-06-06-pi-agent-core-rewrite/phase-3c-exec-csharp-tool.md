# Phase 3c — `exec_csharp` AgentTool

**Goal:** A pi `AgentTool` named `exec_csharp` that takes a C# script string and forwards it to the driver via the phase-2 `Supervisor.runScript`. Driver responses (result / stdout / compile error / runtime error / hang) all become text the LLM can read and react to.

**Files:**
- Create: `apps/agent/src/agent/tools/execCsharp.ts` — factory function returning the AgentTool
- Create: `apps/agent/src/agent/tools/execCsharp.test.ts` — unit tests with mock supervisor

**Why phase 3c:** Phase 4b's Agent setup needs this tool. Phase 3b was the warm-up; this one is the main event — it's the **only** way the LLM can manipulate Word.

**Key design — factory function not module-level singleton:** The tool needs a `Supervisor` reference. Constructing it at module load time would tie tool-creation to global state. Instead expose `makeExecCsharpTool(supervisor)` so the sidecar's `index.ts` can wire it explicitly. Same shape OpenClaw early `pi-embedded.ts` used.

**Error policy:** Same as `read` — driver-side errors (compile, runtime, hang) become AgentToolResult with leading `error:` text so the LLM can self-recover. Only true infra failures (supervisor crashes catastrophically) throw.

---

### Task 3c.1: Tool implementation

**File (new):** `apps/agent/src/agent/tools/execCsharp.ts`

- [ ] **Step 1: Create the tool**

Create `apps/agent/src/agent/tools/execCsharp.ts`:

```typescript
/**
 * `exec_csharp` AgentTool — the agent's only path to mutate Word.
 *
 * Takes a C# script, forwards it to the driver via Supervisor.runScript,
 * and returns the structured response as text the LLM can read.
 *
 * Globals available to the script (documented in word-com-cheatsheet SKILL.md):
 *   - Doc  (Word.Document)
 *   - App  (Word.Application)
 *   - Track(Action body)  — wrap mutations in tracked-revisions mode
 *   - Print(object o)     — append to script stdout (returned in `stdout` field)
 *
 * Returned text shape:
 *   on success: "result: <json>\nstdout:\n<stdout>"
 *   on error:   "error: <message>\nstdout:\n<stdout>"
 *
 * The LLM sees both stdout AND the result/error in one block, so it can react
 * to a compile_error by reading the diagnostics and retrying with a fix.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { HangError } from "../../rpc/supervisor";
import type { Supervisor } from "../../rpc/supervisor";

const ExecParams = Type.Object({
  code: Type.String({
    description:
      "C# script body. Will run inside the live Word session. " +
      "Globals: Doc (Word.Document), App (Word.Application), Track(Action) " +
      "to wrap mutations in tracked revisions, Print(object) to append to " +
      "stdout. All mutations MUST run inside Track(() => { ... }). " +
      "Read the track-changes-protocol skill if unsure.",
  }),
});

interface ExecDetails {
  result: unknown;
  stdout: string;
  error: string | null;
  /** True if the supervisor reported a hang (driver was killed and restarted). */
  hung: boolean;
}

/**
 * Build the LLM-facing text block from a driver response. Both `stdout` and
 * `result`/`error` are surfaced so the model has all the diagnostic context
 * in one place.
 */
function formatText(args: { result: unknown; stdout: string; error: string | null }): string {
  const { result, stdout, error } = args;
  const head = error
    ? `error: ${error}`
    : `result: ${result === undefined ? "undefined" : JSON.stringify(result)}`;
  // Always show stdout (empty string if none) so the model knows it didn't miss anything.
  return `${head}\nstdout:\n${stdout ?? ""}`;
}

export function makeExecCsharpTool(supervisor: Supervisor): AgentTool<typeof ExecParams, ExecDetails> {
  return {
    name: "exec_csharp",
    label: "exec_csharp",
    description:
      "Execute a Roslyn C# script against the live Microsoft Word document. " +
      "Use this for ALL Word reads and mutations. Read 'word-com-cheatsheet' " +
      "and 'track-changes-protocol' skills before non-trivial use. " +
      "All mutations MUST be wrapped in Track(() => { ... }).",
    parameters: ExecParams,

    async execute(_toolCallId, params, _signal): Promise<AgentToolResult<ExecDetails>> {
      const { code } = params as Static<typeof ExecParams>;
      if (typeof code !== "string" || code.trim().length === 0) {
        return {
          content: [{ type: "text", text: "error: code must be a non-empty string\nstdout:\n" }],
          details: { result: null, stdout: "", error: "empty_code", hung: false },
        };
      }

      // Note: pi's `_signal` here is an AbortSignal we currently can't propagate
      // into the supervisor.runScript path — runScript doesn't take a signal in
      // phase 2. The supervisor's own 10s callTimeoutMs is the upper bound on a
      // hung Roslyn call, which is enough for W1. Cooperative abort propagation
      // is tracked for a later phase.

      let resp;
      try {
        resp = await supervisor.runScript(code);
      } catch (err) {
        // HangError → driver was killed + respawned. Return error text so the
        // LLM sees it and can retry with a smaller/different script.
        if (err instanceof HangError) {
          return {
            content: [
              {
                type: "text",
                text:
                  "error: driver hung and was restarted — the previous script took longer than 10s. " +
                  "Try a smaller script, or split work across multiple exec_csharp calls.\nstdout:\n",
              },
            ],
            details: { result: null, stdout: "", error: "hang", hung: true },
          };
        }
        // Other errors (e.g. "driver restarted N times in the last minute") are
        // genuine infra failures. Throw so pi marks this as a tool failure.
        throw err;
      }

      return {
        content: [
          { type: "text", text: formatText(resp) },
        ],
        details: {
          result: resp.result,
          stdout: resp.stdout,
          error: resp.error,
          hung: false,
        },
      };
    },
  };
}
```

- [ ] **Step 2: Syntax check the new file in isolation**

```bash
cd apps/agent && bunx tsc --noEmit src/agent/tools/execCsharp.ts 2>&1 | head -20
cd ../..
```

You'll see errors from `loop.ts` and `index.ts` from earlier — ignore them. Look only for errors in `execCsharp.ts` itself. If clean, proceed.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/tools/execCsharp.ts
git commit -m "feat(sidecar): exec_csharp AgentTool wrapping supervisor.runScript"
```

---

### Task 3c.2: Unit tests with mock supervisor

The supervisor tests in phase 2 already covered hang/respawn at the runScript layer. Here we only need to verify the tool maps DriverResponse → AgentToolResult correctly and handles HangError gracefully.

**File (new):** `apps/agent/src/agent/tools/execCsharp.test.ts`

- [ ] **Step 1: Create the tests**

Create `apps/agent/src/agent/tools/execCsharp.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { makeExecCsharpTool } from "./execCsharp";
import { HangError, type Supervisor } from "../../rpc/supervisor";
import type { DriverResponse } from "../../rpc/driverClient";

/**
 * Minimal Supervisor stub. Only implements what the tool uses (runScript).
 * Casting through `unknown` because the real Supervisor has many other methods.
 */
function stubSupervisor(impl: (code: string) => Promise<DriverResponse>): Supervisor {
  return { runScript: impl } as unknown as Supervisor;
}

test("exec_csharp: success — surfaces result and stdout", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async (code) => ({
      id: "1",
      result: 42,
      stdout: "hello\n",
      error: null,
    })),
  );
  const r = await tool.execute("tc1", { code: "return 1+41;" });
  expect(r.details.result).toBe(42);
  expect(r.details.error).toBeNull();
  expect(r.details.hung).toBe(false);
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("result: 42");
  expect(text).toContain("stdout:\nhello");
});

test("exec_csharp: compile_error surfaces as text the LLM can read", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => ({
      id: "1",
      result: null,
      stdout: "",
      error: "compile_error: ; expected",
    })),
  );
  const r = await tool.execute("tc2", { code: "this is bad" });
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("error: compile_error: ; expected");
  expect(r.details.error).toBe("compile_error: ; expected");
});

test("exec_csharp: HangError becomes error result, not thrown", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => {
      throw new HangError();
    }),
  );
  const r = await tool.execute("tc3", { code: "while(true){}" });
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("error: driver hung");
  expect(r.details.hung).toBe(true);
  expect(r.details.error).toBe("hang");
});

test("exec_csharp: empty code returns error without calling supervisor", async () => {
  let called = false;
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => {
      called = true;
      return { id: "1", result: null, stdout: "", error: null };
    }),
  );
  const r = await tool.execute("tc4", { code: "   " });
  expect(called).toBe(false);
  expect(r.details.error).toBe("empty_code");
});

test("exec_csharp: non-HangError errors are re-thrown for pi to mark as tool failure", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => {
      throw new Error("driver restarted 3 times in the last minute — giving up");
    }),
  );
  await expect(tool.execute("tc5", { code: "anything" })).rejects.toThrow(
    /restarted 3 times/,
  );
});

test("exec_csharp: undefined result is rendered as 'undefined' (not omitted)", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => ({
      id: "1",
      result: undefined,
      stdout: "",
      error: null,
    })),
  );
  const r = await tool.execute("tc6", { code: 'Print("hi");' });
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("result: undefined");
});
```

- [ ] **Step 2: Run the tests**

```bash
cd apps/agent && bun test src/agent/tools/execCsharp.test.ts
cd ../..
```

Expected: 6 tests pass.

If TypeScript complains about the `stubSupervisor` cast in a way that breaks the test runner, simplify by changing to:
```typescript
const tool = makeExecCsharpTool({ runScript: impl } as any as Supervisor);
```
…and remove the helper. The cast is necessary because Supervisor has many other methods we don't need to stub.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/tools/execCsharp.test.ts
git commit -m "test(sidecar): exec_csharp unit tests with mock supervisor"
```

---

### Task 3c.3: Cross-tool regression check

Now that we have 4 sets of tests (rpc/ndjson + rpc/supervisor + rpc/runScript + agent/tools/read + agent/tools/execCsharp), run them together to make sure none clobber shared state (e.g., env var leaks between read and execCsharp tests).

- [ ] **Step 1: Run all known-good test paths**

```bash
cd apps/agent && bun test src/rpc/ src/agent/tools/
cd ../..
```

Expected: all green. Total test count = ndjson + supervisor + runScript (skippable) + read + execCsharp tests = roughly 20+.

- [ ] **Step 2: If any test fails because of env-var leak**

`MSWORD_AGENT_SKILLS_ROOT` is the most likely culprit. The `read.test.ts` calls `__resetAllowedRootsForTesting()` in `beforeEach`, but if a future test sets the env var without clearing it, downstream tests will use the wrong root. Add a `beforeEach` to `execCsharp.test.ts` that clears the env vars:

```typescript
import { beforeEach } from "bun:test";

beforeEach(() => {
  delete process.env.MSWORD_AGENT_SKILLS_ROOT;
  delete process.env.MSWORD_AGENT_DOCS_ROOT;
});
```

(Only add this if you actually see a leak. Otherwise skip — YAGNI.)

- [ ] **Step 3: No commit needed if tests already passed**

If you had to add the `beforeEach`, commit it:
```bash
git add apps/agent/src/agent/tools/execCsharp.test.ts
git commit -m "test(sidecar): clear env vars between exec_csharp tests"
```

---

## Phase 3c acceptance

- ✅ `apps/agent/src/agent/tools/execCsharp.ts` exports `makeExecCsharpTool(supervisor)` returning a pi `AgentTool`.
- ✅ Driver success → text block with `result:` + `stdout:` segments; `details.result` populated.
- ✅ Driver error (compile/runtime) → text block with `error:` prefix; LLM can read and react.
- ✅ Supervisor `HangError` → graceful error result; `details.hung === true`.
- ✅ Other supervisor errors (e.g., restart budget) → thrown for pi to mark tool failure.
- ✅ Empty/whitespace code → rejected without hitting supervisor.
- ✅ All 6 unit tests pass.
- ✅ Combined run of phase 1/2/3 tests still green.

If any criterion fails, fix in place — do not start phase 4.
