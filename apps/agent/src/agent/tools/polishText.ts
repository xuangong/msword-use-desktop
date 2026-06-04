/**
 * polish_text tool — the agent calls this with a target (selection/paragraph)
 * and a style preset. The tool itself does the LLM rewrite + writes back
 * to Word via the C# driver (with Track Changes + [AI:...] comment).
 *
 * Returns a structured summary the agent uses to compose its final reply.
 */

import type { Supervisor } from "../../rpc/supervisor";
import { completeMessage } from "../../llm/anthropic";
import { POLISH_PRESETS, polishSystemPrompt, polishUserMessage, type PolishPreset } from "../prompts";
import { friendlyDriverError } from "../errors";
import type { ToolSpec } from "../../llm/anthropic";

export const polishTextSpec: ToolSpec = {
  name: "polish_text",
  description:
    "Rewrite a target piece of text in the user's Word document in a target style. " +
    "Use this when the user asks to polish/rewrite/change tone (润色/改写/改风格). " +
    "Defaults to the current Word selection when no target is given. " +
    "All edits go through Track Changes with an [AI: polish:<style>] comment.",
  input_schema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["selection", "paragraph"],
        description: "What to rewrite. 'selection' uses the current Word selection.",
        default: "selection",
      },
      paragraph_index: {
        type: ["integer", "null"],
        description: "Required when target='paragraph'. 1-based paragraph index.",
      },
      style: {
        type: "string",
        enum: ["公文", "合同", "论文", "文案", "商务", "custom"],
        description: "Style preset to rewrite in.",
      },
      custom_style: {
        type: ["string", "null"],
        description: "Free-form style description, required when style='custom'.",
      },
      extra_instruction: {
        type: ["string", "null"],
        description: "Optional ad-hoc requirement, e.g. '缩短 30%'.",
      },
    },
    required: ["style"],
  },
};

export interface PolishToolInput {
  target?: "selection" | "paragraph";
  paragraph_index?: number | null;
  style: PolishPreset;
  custom_style?: string | null;
  extra_instruction?: string | null;
}

export interface PolishToolResult {
  ok: boolean;
  style: string;
  originalChars: number;
  newChars: number;
  preview_original: string;
  preview_new: string;
  paragraph_index?: number | null;
  comment_index?: number;
  error?: string;
}

/**
 * The exact range descriptor we'll pass to polish.replaceRange and later to
 * polish.addComment. Exactly one of {bookmark, paragraphIndex, (start,end)}
 * should be filled. The C# resolver in Polish.cs prefers bookmark > paragraphIndex
 * > start/end, so we never set start/end alongside paragraphIndex.
 */
type TargetRange =
  | { kind: "range"; start: number; end: number }
  | { kind: "paragraph"; paragraphIndex: number };

/**
 * Execute polish: resolve target → call LLM → write back through driver.
 *
 * Uses the supervisor for COM calls so the agent can keep going even if a
 * single Word op hangs (supervisor will respawn the driver).
 */
export async function runPolish(
  input: PolishToolInput,
  supervisor: Supervisor,
): Promise<PolishToolResult> {
  const style = input.style;
  if (style !== "custom" && !(style in POLISH_PRESETS)) {
    return polishError(style, `unknown style: ${style}`);
  }
  if (style === "custom" && !input.custom_style) {
    return polishError(style, "style='custom' requires custom_style");
  }

  const target = input.target ?? "selection";

  // 1. Resolve the target range.
  let originalText: string;
  let targetRange: TargetRange;
  let paragraphIndex: number | null = null;

  if (target === "selection") {
    let sel;
    try {
      sel = await supervisor.call("observe.selection");
    } catch (err: any) {
      return polishError(style, friendlyDriverError(err));
    }
    if (sel.isEmpty) {
      return polishError(
        style,
        "当前没有选中文字。请在 Word 中先用鼠标选中要改写的段落，再发指令。",
      );
    }
    originalText = sel.text;
    paragraphIndex = sel.paragraphIndex ?? null;
    targetRange = { kind: "range", start: sel.start, end: sel.end };
  } else {
    if (input.paragraph_index == null) {
      return polishError(style, "段落模式需要 paragraph_index 参数。");
    }
    paragraphIndex = input.paragraph_index;
    let para;
    try {
      para = await supervisor.call("observe.paragraph", { index: paragraphIndex } as any);
    } catch (err: any) {
      return polishError(style, friendlyDriverError(err));
    }
    originalText = para.text;
    targetRange = { kind: "paragraph", paragraphIndex };
  }

  // 2. Build LLM prompt + call.
  const system = polishSystemPrompt({
    preset: style,
    customStyle: input.custom_style ?? undefined,
    extraInstruction: input.extra_instruction ?? undefined,
  });
  const userMsg = polishUserMessage({
    text: originalText.replace(/[\r\n\x07]+$/, ""),
    // context_before/after omitted in alpha (would need extra observe calls)
  });

  let llmResult;
  try {
    llmResult = await completeMessage({
      system,
      messages: [{ role: "user", content: userMsg }],
      cacheSystem: true,
    });
  } catch (err: any) {
    return polishError(style, friendlyDriverError(err));
  }
  const newText = llmResult.text.trim();
  if (!newText) return polishError(style, "LLM 返回了空内容，请重试。");

  // 3. Preserve trailing paragraph mark if the original had one.
  const trailing = originalText.endsWith("\r") ? "\r" : "";
  const finalText = newText + trailing;

  // 4. Write back via driver. The C# RevisionScope wraps this with TrackRevisions
  // so the edit shows up as a tracked revision. The driver returns the actual
  // post-mutation rangeStart/rangeEnd, which we use for the comment range
  // (string-length math doesn't work because Word positions count paragraph marks
  // and visible-revision overlays differently from JS .length).
  const replaceParams = {
    newText: finalText,
    action: `polish:${style}`,
    track: true,
    ...rangeToParams(targetRange),
  } as any;

  let replaceResult;
  try {
    replaceResult = await supervisor.call("polish.replaceRange", replaceParams);
  } catch (err: any) {
    return polishError(style, friendlyDriverError(err));
  }

  // 5. Tag the new range with an [AI: ...] comment so users can audit.
  // Use the driver-reported rangeEnd directly (P0-6: don't compute from JS length).
  let commentIndex: number | undefined;
  try {
    const c = await supervisor.call("polish.addComment", {
      text: `[AI: polish:${style}] ${input.extra_instruction ?? ""}`.trim(),
      start: replaceResult.rangeStart,
      end: replaceResult.rangeEnd,
    } as any);
    commentIndex = c.commentIndex;
  } catch (err) {
    // Comment failure shouldn't roll back the edit — Word may not support
    // a comment on a tracked-insertion range in some versions/states.
    console.error("[polish] addComment failed (non-fatal):", err);
  }

  return {
    ok: true,
    style,
    originalChars: originalText.length,
    newChars: newText.length,
    preview_original: originalText.slice(0, 60),
    preview_new: newText.slice(0, 60),
    paragraph_index: paragraphIndex,
    comment_index: commentIndex,
  };
}

/** Convert a TargetRange into the params the C# resolver expects. */
function rangeToParams(r: TargetRange): Record<string, unknown> {
  return r.kind === "range"
    ? { start: r.start, end: r.end }
    : { paragraphIndex: r.paragraphIndex };
}

function polishError(style: string, msg: string): PolishToolResult {
  return {
    ok: false,
    style,
    originalChars: 0,
    newChars: 0,
    preview_original: "",
    preview_new: "",
    error: msg,
  };
}
