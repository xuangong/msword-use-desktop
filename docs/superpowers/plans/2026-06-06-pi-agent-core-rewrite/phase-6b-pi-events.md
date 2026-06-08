# Phase 6b — Frontend consumes pi-native events

**Goal:** The sidecar now writes pi `AgentEvent` shapes (e.g. `{type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"…"}}`) wrapped in our envelope (`{sessionId, id, kind:"agent_event", event:<piEvent>}`). The frontend currently parses v0.3-shaped `text_delta`/`tool_call`/`done` events. Bridge them with a single translator function so existing atoms / `applyEventToTurns` / `ChatTurn` rendering stay unchanged.

**Files:**
- Create: `apps/desktop/src/state/piEventBridge.ts` — translates pi `AgentEvent` → existing `DebugEvent`
- Create: `apps/desktop/src/state/piEventBridge.test.ts` — unit tests
- Modify: `apps/desktop/src/App.tsx` — parse the new envelope shape; route through `piEventBridge`

**Why bridge instead of full rewrite:** The existing `DebugEvent` discriminated union, atoms, `ChatTurn` rendering, and debug panel all consume v0.3 event shapes. Replacing all of them is a much bigger UI project (and out of scope for W1 per spec). A translator gives us the spec's "frontend consumes pi-native events directly" intent (no translation in the **sidecar**) while keeping the **frontend** stable. This is the smallest defensible diff.

**Translation table:**

| pi event (sidecar emits) | DebugEvent kind (frontend renders) | Notes |
|---|---|---|
| `agent_start` | (none) | Drop — UI doesn't need a marker |
| `turn_start` | (none) | Same |
| `message_start` (role=user) | `user_message` | Captures the prompt text we already sent |
| `message_update` (`assistantMessageEvent.type === "text_delta"`) | `text_delta` (text = `delta`) | Streaming text |
| `message_update` other inner types (`text_start`, `text_end`, `thinking_*`, ...) | (none) | We ignore for now; thinking surfacing is YAGNI for W1 |
| `tool_execution_start` | `tool_call` | Maps `toolName`→`name`, `toolCallId`→`toolUseId`, `args`→`input` |
| `tool_execution_end` | `tool_result` | Maps `result`→`result`, `!isError`→`ok` |
| `message_end` (role=assistant) | (none) | Optional — kept implicit; `agent_end` finalises |
| `turn_end` | (none) | Same — agent-level done is what UI cares about |
| `agent_end` | `done` (stopReason="end_turn", finalText="" — we already streamed it) | Marks the turn streaming=false |
| `error` (sidecar-injected, see index.ts catch block) | `error` | Direct mapping |

Anything else: render as a generic `system` debug event with severity `info` so it surfaces in the debug panel without exploding.

---

### Task 6b.1: Translator function

**File (new):** `apps/desktop/src/state/piEventBridge.ts`

- [ ] **Step 1: Create the file**

Create `apps/desktop/src/state/piEventBridge.ts`:

```typescript
/**
 * Translate a pi-agent-core AgentEvent into the v0.3 DebugEvent shape that
 * the existing atoms / ChatTurn renderer consumes.
 *
 * The sidecar emits pi-native events verbatim (per spec Q5). This module is
 * the only place in the app that knows pi's event names. If pi changes the
 * event shape (minor version), the fix lives here.
 *
 * Returns null when the event is something the UI doesn't render (e.g.
 * `turn_start`, `message_end`). null is meant to be filtered out by the caller.
 */

import type { DebugEvent } from "./types";

/** Wrapper envelope written by the sidecar (apps/agent/src/index.ts). */
export interface SidecarEnvelope {
  sessionId: string;
  id: string | null;
  kind: "agent_event";
  event: PiEvent;
}

/** Subset of pi's AgentEvent we care about. Other shapes are accepted as `any`. */
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown }
  | { type: "message_start"; message?: { role?: string; content?: unknown } }
  | { type: "message_update"; message?: unknown; assistantMessageEvent?: AssistantMessageEvent }
  | { type: "message_end"; message?: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "error"; error: string }
  | { type: string; [key: string]: unknown };

export type AssistantMessageEvent =
  | { type: "text_delta"; delta?: string; content?: string }
  | { type: "text_start" | "text_end"; content?: string }
  | { type: string; [k: string]: unknown };

let nextSyntheticId = 1;
function synthId(prefix: string): string {
  return `${prefix}_${Date.now()}_${nextSyntheticId++}`;
}

export interface BridgeContext {
  /** Per-call request id from the envelope. Used as messageId so multiple
   * events from the same turn fold into one ChatTurn. */
  reqId: string | null;
}

/**
 * Convert one pi event (with envelope context) into 0..1 DebugEvent.
 * Returns null when nothing should be rendered for that event.
 */
export function piEventToDebugEvent(
  envelope: SidecarEnvelope,
  ctx: BridgeContext,
): DebugEvent | null {
  const { sessionId } = envelope;
  const event = envelope.event;
  const baseId = ctx.reqId ?? envelope.id ?? synthId("ev");
  const ts = Date.now();
  const messageId = ctx.reqId ?? undefined;

  switch (event.type) {
    case "message_start": {
      // Only synthesise user_message events for the user message — assistant's
      // message_start is tracked implicitly by text_delta / agent_end.
      const role = (event as any).message?.role;
      if (role !== "user") return null;
      const content = (event as any).message?.content;
      const text = extractUserText(content);
      return {
        kind: "user_message",
        id: synthId("user"),
        ts,
        sessionId,
        messageId,
        text,
      };
    }

    case "message_update": {
      const inner = (event as any).assistantMessageEvent;
      if (!inner || inner.type !== "text_delta") return null;
      const delta =
        typeof inner.delta === "string" ? inner.delta : typeof inner.content === "string" ? inner.content : "";
      if (!delta) return null;
      return {
        kind: "text_delta",
        id: synthId("delta"),
        ts,
        sessionId,
        messageId,
        text: delta,
      };
    }

    case "tool_execution_start": {
      const e = event as any;
      return {
        kind: "tool_call",
        id: synthId("tc"),
        ts,
        sessionId,
        messageId,
        toolUseId: e.toolCallId,
        name: e.toolName,
        input: e.args,
      };
    }

    case "tool_execution_end": {
      const e = event as any;
      return {
        kind: "tool_result",
        id: synthId("tr"),
        ts,
        sessionId,
        messageId,
        toolUseId: e.toolCallId,
        name: e.toolName,
        result: e.result,
        ok: !e.isError,
      };
    }

    case "agent_end": {
      return {
        kind: "done",
        id: synthId("done"),
        ts,
        sessionId,
        messageId,
        stopReason: "end_turn",
        finalText: "",
      };
    }

    case "error": {
      const e = event as any;
      return {
        kind: "error",
        id: synthId("err"),
        ts,
        sessionId,
        messageId,
        error: typeof e.error === "string" ? e.error : JSON.stringify(e.error ?? null),
      };
    }

    default:
      // Surface unrecognised events as a `system` info entry so they appear
      // in the debug panel but don't disrupt chat turns.
      return {
        kind: "system",
        id: synthId("sys"),
        ts,
        sessionId,
        messageId,
        text: `pi-event:${event.type}`,
        severity: "info",
      };
  }

  // Note: `case "agent_start" / "turn_start" / "turn_end" / "message_end"` are
  // all caught by the default branch and surface as system info entries. If
  // they become noisy, they can be filtered to null here without changing
  // any other code.
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c && typeof c === "object" && c.type === "text") return c.text ?? "";
        return "";
      })
      .join("");
  }
  return "";
}
```

The function deliberately uses `as any` casts at the boundary — pi's `AgentEvent` types are well-defined upstream but mirroring the full discriminated union here would couple us tightly to pi's type signatures. The minimal `PiEvent` type defined in this file documents what we use; the `as any` is the seam.

- [ ] **Step 2: Syntax check**

```bash
cd apps/desktop && bunx tsc --noEmit src/state/piEventBridge.ts 2>&1 | head -10
cd ../..
```

Expected: clean (errors elsewhere in the project are out of scope for this task).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/state/piEventBridge.ts
git commit -m "feat(ui): pi event → DebugEvent bridge"
```

---

### Task 6b.2: Bridge unit tests

**File (new):** `apps/desktop/src/state/piEventBridge.test.ts`

- [ ] **Step 1: Create the file**

Create `apps/desktop/src/state/piEventBridge.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { piEventToDebugEvent, type SidecarEnvelope } from "./piEventBridge";

const envelope = (event: any, sessionId = "sid_X", id: string | null = "req_1"): SidecarEnvelope => ({
  sessionId,
  id,
  kind: "agent_event",
  event,
});

test("message_start (user) → user_message with extracted text", () => {
  const ev = piEventToDebugEvent(
    envelope({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "把这段改成公文" }],
      },
    }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("user_message");
  if (ev?.kind === "user_message") {
    expect(ev.text).toBe("把这段改成公文");
    expect(ev.sessionId).toBe("sid_X");
    expect(ev.messageId).toBe("req_1");
  }
});

test("message_start (assistant) → null", () => {
  const ev = piEventToDebugEvent(
    envelope({ type: "message_start", message: { role: "assistant", content: [] } }),
    { reqId: "req_1" },
  );
  expect(ev).toBeNull();
});

test("message_update text_delta → text_delta", () => {
  const ev = piEventToDebugEvent(
    envelope({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "已将" },
    }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("text_delta");
  if (ev?.kind === "text_delta") expect(ev.text).toBe("已将");
});

test("message_update with non-text_delta inner → null", () => {
  const ev = piEventToDebugEvent(
    envelope({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "..." },
    }),
    { reqId: "req_1" },
  );
  expect(ev).toBeNull();
});

test("tool_execution_start → tool_call", () => {
  const ev = piEventToDebugEvent(
    envelope({
      type: "tool_execution_start",
      toolCallId: "tc_42",
      toolName: "exec_csharp",
      args: { code: "return 1+1;" },
    }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("tool_call");
  if (ev?.kind === "tool_call") {
    expect(ev.toolUseId).toBe("tc_42");
    expect(ev.name).toBe("exec_csharp");
    expect((ev.input as any).code).toBe("return 1+1;");
  }
});

test("tool_execution_end (success) → tool_result with ok:true", () => {
  const ev = piEventToDebugEvent(
    envelope({
      type: "tool_execution_end",
      toolCallId: "tc_42",
      toolName: "exec_csharp",
      result: { value: 2 },
      isError: false,
    }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("tool_result");
  if (ev?.kind === "tool_result") {
    expect(ev.toolUseId).toBe("tc_42");
    expect(ev.ok).toBe(true);
    expect((ev.result as any).value).toBe(2);
  }
});

test("tool_execution_end (error) → tool_result with ok:false", () => {
  const ev = piEventToDebugEvent(
    envelope({
      type: "tool_execution_end",
      toolCallId: "tc_42",
      toolName: "exec_csharp",
      result: "boom",
      isError: true,
    }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("tool_result");
  if (ev?.kind === "tool_result") expect(ev.ok).toBe(false);
});

test("agent_end → done", () => {
  const ev = piEventToDebugEvent(
    envelope({ type: "agent_end", messages: [] }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("done");
  if (ev?.kind === "done") expect(ev.stopReason).toBe("end_turn");
});

test("error event → error", () => {
  const ev = piEventToDebugEvent(
    envelope({ type: "error", error: "boom" }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("error");
  if (ev?.kind === "error") expect(ev.error).toBe("boom");
});

test("unknown event → system info entry", () => {
  const ev = piEventToDebugEvent(
    envelope({ type: "future_pi_event_we_dont_know", x: 1 }),
    { reqId: "req_1" },
  );
  expect(ev?.kind).toBe("system");
  if (ev?.kind === "system") {
    expect(ev.text).toContain("future_pi_event_we_dont_know");
    expect(ev.severity).toBe("info");
  }
});
```

- [ ] **Step 2: Run**

```bash
cd apps/desktop && bun test src/state/piEventBridge.test.ts
cd ../..
```

Expected: 10 tests pass.

If `bun test` complains about no test runner config in `apps/desktop`, ensure `apps/desktop/package.json` has `"@types/bun"` in devDependencies and there's a Bun test config. The existing project's other tests run from `apps/agent`; if `apps/desktop` is not set up for `bun test`, replicate `apps/agent/package.json`'s test setup minimally:
```json
"devDependencies": {
  ...
  "@types/bun": "latest"
}
```
Then `bun install` and re-run.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/state/piEventBridge.test.ts
git commit -m "test(ui): pi event bridge unit tests"
```

---

### Task 6b.3: Wire the bridge into `App.tsx`

The existing `App.tsx` listens for `bun:reply` events whose payload is an NDJSON string from the sidecar. v0.3 sidecar wrote `{id, kind:"agent_event", event:{kind: "text_delta", text}}` — note the inner `kind` field in v0.3.

New sidecar writes `{sessionId, id, kind:"agent_event", event:{type: "message_update", ...}}` — note the inner `type` field and added `sessionId`.

We need to:
1. Parse the new envelope (sessionId now arrives directly, not derived from `idToSession`).
2. Run pi events through `piEventToDebugEvent`.
3. Skip null returns.

- [ ] **Step 1: Update the `bun:reply` handler in `App.tsx`**

Find the listener (search for `listen<string>("bun:reply"`). Replace its body. Read the existing handler **first** to understand the context, then apply this minimal diff inside the listener callback (replacing the existing parse-and-dispatch block):

```typescript
    const offReply = listen<string>("bun:reply", (e) => {
      const raw = e.payload;
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      // Sidecar startup: {ready:true, ...}
      if (parsed.ready === true) {
        // Existing ready handling stays — just drop into the original code path
        // (look for the v0.3 ready handler and keep it).
        return;
      }

      // Driver restart marker
      if (parsed.kind === "driver_restart") {
        // existing handling — preserve
        return;
      }

      // pi-shaped agent event envelope
      if (parsed.kind === "agent_event") {
        const sessionId: string | undefined = parsed.sessionId;
        if (!sessionId) return;
        const reqId: string | null = parsed.id ?? null;
        const debugEv = piEventToDebugEvent(parsed, { reqId });
        if (debugEv) {
          appendEvent(debugEv);
        }
        return;
      }

      // Raw response (snapshots from Tauri use this — frontend-side rendering
      // handles them implicitly via spotlight UI; main window can ignore).
      if (parsed.kind === "raw_response") {
        return;
      }

      // Anything else: surface as a generic system event for debugging.
      // (Existing v0.3 fallback path — preserve.)
    });
```

You'll need to import `piEventToDebugEvent` at the top:
```typescript
import { piEventToDebugEvent } from "./state/piEventBridge";
```

The existing `idToSession` map and `currentSessionId` ref logic in `App.tsx` is mostly redundant now (sessionId arrives in the envelope directly). **Don't delete it in this task** — leave it as a fallback. Phase 7 cleanup will assess whether to remove it after the e2e flow is verified.

- [ ] **Step 2: Type-check**

```bash
cd apps/desktop && bunx tsc --noEmit
cd ../..
```

Expected: errors elsewhere in `App.tsx` may persist (the file is large and references v0.3 chat patterns — those get cleaned up in phase 7 as needed). What matters: no NEW errors caused by this change.

- [ ] **Step 3: Build the renderer**

```bash
cd apps/desktop && bun run build
cd ../..
```

Expected: succeeds. If it fails on something unrelated to your edit, that's a pre-existing issue (note it for phase 7) but does not block 6b.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(ui): App.tsx routes pi-shaped events through bridge"
```

---

### Task 6b.4: Manual sanity (full chat dev loop)

We can't run a full e2e here — that's phase 7's job. But we can verify:
1. Bridge translation doesn't crash the renderer
2. Existing v0.3 events (driver_restart) still appear in the debug panel

- [ ] **Step 1: Run dev with sidecar**

```bash
bun run dev
```

- [ ] **Step 2: Observe the main window's debug panel**

When sidecar starts, you should see (in the debug panel or stdout `bun:log` events):
- `ready` event
- No errors about JSON parse / undefined functions

If the debug panel shows `pi-event:agent_start`, `pi-event:turn_start`, `pi-event:message_end`, etc. as "system info" entries — **that's expected**. They're filtered to `severity:"info"`. If they're noisy, confirm whether to suppress them or whether they're useful for development. (Recommendation: keep visible during W1, filter in a follow-up.)

- [ ] **Step 3: Press Ctrl+Alt+J from Word with `ANTHROPIC_API_KEY` set**

(Optional — full e2e is phase 7. If you want a quick end-to-end taste, type a simple prompt like "返回 Doc.Paragraphs.Count" and watch:
- spotlight strip shows correct paragraph
- sidecar logs show pi-shaped events
- main window debug panel surfaces them via the bridge
- a `tool_call`/`tool_result` pair appears for the `exec_csharp` call)

If the agent calls `exec_csharp` and returns a number, **the main happy path is alive** — celebrate, then proceed to phase 7 for the full validation.

- [ ] **Step 4: Stop dev**

No commit — verification only.

---

## Phase 6b acceptance

- ✅ `apps/desktop/src/state/piEventBridge.ts` translates pi `AgentEvent` to existing `DebugEvent` shape; returns null for unrenderable events.
- ✅ Bridge unit tests (10 cases) all pass.
- ✅ `App.tsx` `bun:reply` listener routes `kind:"agent_event"` envelopes through `piEventToDebugEvent`.
- ✅ Manual sanity: dev loop runs without parse errors / crashes.
- ✅ `apps/desktop/src/state/types.ts` and `apps/desktop/src/state/atoms.ts` UNCHANGED — translator absorbs all the shape difference.

If any criterion fails, fix in place — phase 7 (e2e + cleanup) needs the bridge wired correctly.
