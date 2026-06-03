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

const CONTEXT_CHARS = 200;

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
  let writeBack: () => Promise<{ replacedChars: number; newChars: number; rangeStart: number; rangeEnd: number }>;
  let commentRange: { paragraphIndex?: number; start?: number; end?: number };
  let paragraphIndex: number | null = null;

  if (target === "selection") {
    const sel = await supervisor.call("observe.selection");
    if (sel.isEmpty) return polishError(style, "selection is empty — select text first");
    originalText = sel.text;
    paragraphIndex = sel.paragraphIndex ?? null;
    const start = sel.start;
    const end = sel.end;
    writeBack = () =>
      supervisor.call("polish.replaceRange", {
        newText: "<placeholder>",
        start,
        end,
        action: `polish:${style}`,
        track: true,
      } as any);
    commentRange = { start, end };
  } else {
    if (input.paragraph_index == null) {
      return polishError(style, "paragraph target requires paragraph_index");
    }
    paragraphIndex = input.paragraph_index;
    // We don't have an observe.paragraph yet — fetch outline as a workaround
    // OR just read it via direct paragraph slot in replaceRange (we have only
    // paragraphIndex). For alpha we'll call observe.outline only to read the
    // paragraph's text, which is wasteful but correct. TODO: add observe.paragraph.
    const outline = await supervisor.call("observe.outline", { maxLevel: 9 } as any);
    // outline only carries headings — for body paragraphs we can't read text
    // without a new observe method. For alpha, send original=null and let LLM
    // operate without context (degraded), or refuse:
    return polishError(
      style,
      "target='paragraph' needs observe.paragraph (not implemented in alpha) — please use 'selection'",
    );
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

  const llmResult = await completeMessage({
    system,
    messages: [{ role: "user", content: userMsg }],
    cacheSystem: true,
  });
  const newText = llmResult.text.trim();
  if (!newText) return polishError(style, "LLM returned empty rewrite");

  // 3. Preserve trailing paragraph mark if the original had one.
  const trailing = originalText.endsWith("\r") ? "\r" : "";
  const finalText = newText + trailing;

  // 4. Write back via driver (Track Changes wrapper is inside the C# method).
  const replaceResult = await supervisor.call("polish.replaceRange", {
    newText: finalText,
    start: commentRange.start,
    end: commentRange.end,
    paragraphIndex: commentRange.paragraphIndex,
    action: `polish:${style}`,
    track: true,
  } as any);

  // 5. Tag the new range with an [AI: ...] comment so users can audit.
  // The replace mutates the range — new end is rangeStart + len(newText).
  let commentIndex: number | undefined;
  try {
    const c = await supervisor.call("polish.addComment", {
      text: `[AI: polish:${style}] ${input.extra_instruction ?? ""}`.trim(),
      start: replaceResult.rangeStart,
      end: replaceResult.rangeStart + finalText.length,
    } as any);
    commentIndex = c.commentIndex;
  } catch (err) {
    // Comment failure shouldn't roll back the edit — Word may not support
    // a comment on the resulting range (e.g. it became a tracked-insertion).
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
