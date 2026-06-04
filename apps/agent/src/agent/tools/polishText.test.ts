/**
 * runPolish golden tests. No real Word, no real Anthropic.
 *
 * Verifies the exact sequence of driver calls + that we pass through the
 * driver-reported rangeEnd (P0-6) rather than computing from JS string length.
 *
 * Run: bun test src/agent/tools/polishText.test.ts
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { Supervisor } from "../../rpc/supervisor";

// Mock the Anthropic client *before* importing the SUT.
const mockComplete = mock(async () => ({
  text: "改写后的公文段落。",
  toolUses: [],
  stopReason: "end_turn" as string | null,
  usage: {},
}));
mock.module("../../llm/anthropic", () => ({
  completeMessage: mockComplete,
}));

import { runPolish } from "./polishText";

interface Call {
  method: string;
  params: any;
}

function makeMockSupervisor(replies: Record<string, any>): {
  sup: Supervisor;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sup = {
    async call(method: string, params?: any) {
      calls.push({ method, params: params ?? {} });
      if (!(method in replies)) {
        throw new Error(`mock: no reply scripted for ${method}`);
      }
      const r = replies[method];
      if (r instanceof Error) throw r;
      return r;
    },
    async callRaw(method: string, params?: any) {
      return (this as any).call(method, params);
    },
    get generation() {
      return 1;
    },
  } as unknown as Supervisor;
  return { sup, calls };
}

describe("runPolish — selection target", () => {
  beforeEach(() => {
    mockComplete.mockClear();
    mockComplete.mockResolvedValue({
      text: "改写后的公文段落。",
      toolUses: [],
      stopReason: "end_turn" as string | null,
      usage: {},
    });
  });

  test("calls observe.selection → polish.replaceRange → polish.addComment in order", async () => {
    const { sup, calls } = makeMockSupervisor({
      "observe.selection": {
        text: "原文段落。",
        start: 100,
        end: 105,
        isEmpty: false,
        paragraphIndex: 4,
        page: 1,
      },
      "polish.replaceRange": {
        replacedChars: 5,
        newChars: 8,
        rangeStart: 100,
        rangeEnd: 108, // driver-reported end (P0-6: trust this, not JS length)
      },
      "polish.addComment": {
        commentIndex: 1,
        scope: "改写后的公文段落。",
      },
    });

    const result = await runPolish({ style: "公文", target: "selection" }, sup);

    expect(result.ok).toBe(true);
    expect(result.style).toBe("公文");
    expect(result.preview_new).toBe("改写后的公文段落。");
    expect(result.comment_index).toBe(1);

    expect(calls.map((c) => c.method)).toEqual([
      "observe.selection",
      "polish.replaceRange",
      "polish.addComment",
    ]);

    // P0-6: addComment uses driver-reported rangeEnd, not rangeStart + len(text)
    const addCommentCall = calls[2]!;
    expect(addCommentCall.params.start).toBe(100);
    expect(addCommentCall.params.end).toBe(108);
    expect(addCommentCall.params.text).toContain("[AI: polish:公文]");
  });

  test("empty selection returns friendly Chinese error without calling LLM", async () => {
    const { sup, calls } = makeMockSupervisor({
      "observe.selection": {
        text: "",
        start: 100,
        end: 100,
        isEmpty: true,
        paragraphIndex: 4,
      },
    });

    const result = await runPolish({ style: "公文", target: "selection" }, sup);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("没有选中文字");
    expect(calls.map((c) => c.method)).toEqual(["observe.selection"]);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  test("comment failure is non-fatal — replace still wins", async () => {
    const { sup, calls } = makeMockSupervisor({
      "observe.selection": {
        text: "原文",
        start: 50,
        end: 52,
        isEmpty: false,
        paragraphIndex: 2,
      },
      "polish.replaceRange": {
        replacedChars: 2,
        newChars: 3,
        rangeStart: 50,
        rangeEnd: 53,
      },
      "polish.addComment": new Error("Word refused: tracked-insertion range"),
    });

    const result = await runPolish({ style: "商务", target: "selection" }, sup);
    expect(result.ok).toBe(true);
    expect(result.comment_index).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual([
      "observe.selection",
      "polish.replaceRange",
      "polish.addComment",
    ]);
  });
});

describe("runPolish — paragraph target", () => {
  beforeEach(() => {
    mockComplete.mockClear();
  });

  test("uses observe.paragraph then replaceRange with paragraphIndex (P0-5: no stray start/end)", async () => {
    const { sup, calls } = makeMockSupervisor({
      "observe.paragraph": {
        index: 7,
        text: "原段落文字。",
        trimmedText: "原段落文字。",
        start: 200,
        end: 207,
        outlineLevel: 10,
        isHeading: false,
      },
      "polish.replaceRange": {
        replacedChars: 6,
        newChars: 10,
        rangeStart: 200,
        rangeEnd: 210,
      },
      "polish.addComment": {
        commentIndex: 2,
        scope: "改写后的公文段落。",
      },
    });

    const result = await runPolish(
      { style: "公文", target: "paragraph", paragraph_index: 7 },
      sup,
    );

    expect(result.ok).toBe(true);
    expect(result.paragraph_index).toBe(7);

    // P0-5: paragraph target must NOT pass start/end alongside paragraphIndex,
    // because the C# resolver prefers paragraphIndex and would silently
    // discard precise positioning. Verify the polish.replaceRange call
    // shape matches that contract.
    const replaceCall = calls.find((c) => c.method === "polish.replaceRange")!;
    expect(replaceCall.params.paragraphIndex).toBe(7);
    expect(replaceCall.params.start).toBeUndefined();
    expect(replaceCall.params.end).toBeUndefined();
  });

  test("missing paragraph_index returns friendly error", async () => {
    const { sup, calls } = makeMockSupervisor({});
    const result = await runPolish({ style: "公文", target: "paragraph" }, sup);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("paragraph_index");
    expect(calls).toEqual([]);
  });
});

describe("runPolish — validation", () => {
  test("unknown style is rejected before any call", async () => {
    const { sup, calls } = makeMockSupervisor({});
    const result = await runPolish({ style: "xyz" as any, target: "selection" }, sup);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown style");
    expect(calls).toEqual([]);
  });

  test("style=custom requires custom_style", async () => {
    const { sup } = makeMockSupervisor({});
    const result = await runPolish(
      { style: "custom", target: "selection" },
      sup,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("custom_style");
  });
});
