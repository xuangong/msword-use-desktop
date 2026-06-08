import { expect, test } from "bun:test";
import { applyEventToTurns } from "./atoms";
import type { ChatTurn, DebugEvent } from "./types";

function base(kind: DebugEvent["kind"], patch: Partial<DebugEvent>): DebugEvent {
  return {
    id: `${kind}-${Math.random()}`,
    ts: Date.now(),
    sessionId: "s1",
    messageId: "m1",
    kind,
    ...patch,
  } as DebugEvent;
}

test("applyEventToTurns preserves assistant text/tool interleaving", () => {
  let turns: ChatTurn[] = [];
  turns = applyEventToTurns(
    turns,
    base("user_message", { kind: "user_message", text: "translate" }),
  );
  turns = applyEventToTurns(
    turns,
    base("text_delta", { kind: "text_delta", id: "txt-1", text: "先扫描。" }),
  );
  turns = applyEventToTurns(
    turns,
    base("text_delta", { kind: "text_delta", id: "txt-2", text: "开始。" }),
  );
  turns = applyEventToTurns(
    turns,
    base("tool_call", {
      kind: "tool_call",
      id: "tool-1",
      toolUseId: "tc-1",
      name: "exec_csharp",
      input: { code: "Print(1);" },
    }),
  );
  turns = applyEventToTurns(
    turns,
    base("text_delta", { kind: "text_delta", id: "txt-3", text: "继续翻译。" }),
  );

  expect(turns).toHaveLength(1);
  expect(turns[0]!.assistantText).toBe("先扫描。开始。继续翻译。");
  expect(turns[0]!.blocks).toEqual([
    { kind: "text", id: "txt-1", text: "先扫描。开始。" },
    { kind: "tool", id: "tool-1", toolUseId: "tc-1" },
    { kind: "text", id: "txt-3", text: "继续翻译。" },
  ]);
});
