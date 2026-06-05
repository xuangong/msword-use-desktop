/**
 * One-turn agent loop.
 *
 * Input: a user message string.
 * Output: a stream of events the sidecar forwards to the UI:
 *
 *   {kind: "text_delta", text}      — model is emitting reply text
 *   {kind: "tool_call", id, name, input}
 *   {kind: "tool_result", id, name, result}
 *   {kind: "done", text, stopReason}
 *
 * Loop: until stop_reason !== "tool_use", we keep round-tripping LLM ↔ tool.
 */

import { streamMessage, type MessageInput, type ToolSpec } from "../llm/anthropic";
import type { Supervisor } from "../rpc/supervisor";
import { polishTextSpec, runPolish, type PolishToolInput } from "./tools/polishText";
import { friendlyDriverError } from "./errors";

const SYSTEM_PROMPT = `你是 msword-use 桌面应用的 AI 助手，专门帮助用户操作 Microsoft Word 文档。

工作准则：
1. 用户的文档在 Microsoft Word 中打开，你通过工具调用与之交互
2. 所有改动都会自动走 Word 的"修订模式"——用户可以审阅/接受/拒绝
3. 每次改动都会自动加 [AI: ...] 批注，方便审计
4. 默认操作"当前选区"——如果用户没明确说改哪段，假设是选区
5. 只有用户明确同意时，才执行整篇润色这种大动作
6. 中文为主要工作语言

风格分类（polish_text 工具使用）：
- 公文：党政机关公文，简洁客观
- 合同：法律文书，严谨无歧义
- 论文：学术写作，第三人称客观
- 文案：营销文案，生动有节奏
- 商务：商务文档，专业礼貌
- custom：用户描述的自定义风格

回复用中文，简洁。`;

export interface AgentEvent {
  kind:
    | "text_delta"
    | "tool_call"
    | "tool_result"
    | "done"
    | "error"
    | "llm_request"
    | "llm_response";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  stopReason?: string | null;
  error?: string;
  // llm_request / llm_response payloads (kept generic to avoid type churn).
  payload?: unknown;
}

/** Pinned operation target captured by the spotlight UI at hotkey time, so
 * the tool doesn't drift to a stale Word selection while the LLM thinks. */
export interface PinnedTarget {
  kind: "range";
  start: number;
  end: number;
  paragraphIndex?: number;
  textPreview?: string;
}

const TOOLS: ToolSpec[] = [polishTextSpec];

export async function* runAgentTurn(
  userMessage: string,
  supervisor: Supervisor,
  target?: PinnedTarget,
  requestId?: string,
): AsyncGenerator<AgentEvent> {
  // If the spotlight pinned a target, surface it to the LLM as plain text in
  // the user message AND pass it through as tool input later, so the tool
  // doesn't fall back to observe.selection (which can drift).
  let userText = userMessage;
  if (target?.kind === "range") {
    userText =
      `[操作目标已锁定] 段 ${target.paragraphIndex ?? "?"} · 范围 ${target.start}-${target.end}` +
      (target.textPreview ? ` · "${target.textPreview}"` : "") +
      `\n\n用户指令：${userMessage}`;
  }
  const messages: MessageInput[] = [{ role: "user", content: userText }];

  let assistantText = "";
  let lastStopReason: string | null = null;

  // Cap iterations as a safety net — a healthy turn ends in 1-3 LLM calls.
  for (let iter = 0; iter < 6; iter++) {
    let turnText = "";
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    // Trace events are buffered here so we can yield them in-band with
    // text_delta/tool_call without rewriting streamMessage to AsyncGenerator
    // of a wider type. The yields happen after each iter sees each ev.
    const traceBuffer: Array<{ kind: "llm_request" | "llm_response"; payload: unknown }> = [];

    // Wall-clock timer around the LLM call. Reported back to the driver's
    // perf buffer so the perf panel can show "this turn: 480ms LLM + 120ms COM".
    const llmStart = Date.now();

    try {
      for await (const ev of streamMessage({
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
        cacheSystem: true,
        onTrace: (t) => {
          traceBuffer.push({ kind: t.kind, payload: t });
        },
      })) {
        // Drain any pending trace events before each underlying SDK event.
        while (traceBuffer.length > 0) {
          const t = traceBuffer.shift()!;
          yield { kind: t.kind, payload: t.payload };
        }
        if (ev.type === "text_delta") {
          turnText += ev.text;
          yield { kind: "text_delta", text: ev.text };
        } else if (ev.type === "tool_use") {
          toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
          yield { kind: "tool_call", id: ev.id, name: ev.name, input: ev.input };
        } else if (ev.type === "message_stop") {
          lastStopReason = ev.stopReason;
        }
      }
      // Flush trailing trace events (llm_response fires after the SDK loop ends).
      while (traceBuffer.length > 0) {
        const t = traceBuffer.shift()!;
        yield { kind: t.kind, payload: t.payload };
      }
    } catch (err: any) {
      yield { kind: "error", error: friendlyDriverError(err) };
      return;
    }

    // Push LLM wall time to driver perf buffer (fire-and-forget; never blocks
    // the agent loop). Tagged with the same request_id as the chat turn so the
    // perf panel can split "this turn: 480ms LLM + 120ms COM (35 calls)".
    const llmDurUs = (Date.now() - llmStart) * 1000;
    void supervisor
      .callRaw("_perf.record", {
        name: "llm.streamMessage",
        durationUs: llmDurUs,
        sampleSize: turnText.length,
        requestId: requestId ?? null,
        method: "agent.turn",
      })
      .catch(() => {});

    assistantText += turnText;

    // Re-materialize the assistant message so the next user-turn includes both
    // its text and its tool_use blocks (required by Anthropic API).
    const assistantContent: any[] = [];
    if (turnText.length) assistantContent.push({ type: "text", text: turnText });
    for (const tu of toolUses) {
      assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    if (assistantContent.length) {
      messages.push({ role: "assistant", content: assistantContent });
    }

    if (lastStopReason !== "tool_use" || toolUses.length === 0) {
      yield { kind: "done", text: assistantText, stopReason: lastStopReason };
      return;
    }

    // Execute each tool and append a tool_result block.
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      let result: unknown;
      try {
        result = await dispatchTool(tu.name, tu.input, supervisor, target);
      } catch (err: any) {
        result = { ok: false, error: String(err?.message ?? err) };
      }
      yield { kind: "tool_result", id: tu.id, name: tu.name, result };
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: (result as any)?.ok === false,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  yield { kind: "done", text: assistantText, stopReason: "max_iters" };
}

async function dispatchTool(
  name: string,
  input: unknown,
  supervisor: Supervisor,
  target?: PinnedTarget,
) {
  switch (name) {
    case "polish_text": {
      // If the spotlight pinned a target, we use it instead of letting the
      // tool fall back to (potentially stale) Application.Selection.
      // Strategy: pass the precise start/end through a side channel as a
      // "pinnedRange" the tool honors. This preserves the user's exact
      // character range — switching to paragraph mode would expand to the
      // whole paragraph, which is wrong if the user only selected part.
      const merged: PolishToolInput & { pinnedRange?: { start: number; end: number; text?: string } } =
        target?.kind === "range"
          ? {
              ...(input as PolishToolInput),
              pinnedRange: { start: target.start, end: target.end, text: target.textPreview },
            }
          : (input as PolishToolInput);
      return runPolish(merged, supervisor);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
