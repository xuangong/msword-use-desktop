import { test, expect } from "bun:test";
import { piEventToDebugEvent, type SidecarEnvelope } from "./piEventBridge";

const envelope = (event: any, sessionId = "sid_X", id: string | null = "req_1"): SidecarEnvelope => ({
  sessionId,
  id,
  kind: "agent_event",
  event,
});

test("message_start (user) → null (UI echoes locally; pi re-emits on every turn)", () => {
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
  expect(ev).toBeNull();
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
