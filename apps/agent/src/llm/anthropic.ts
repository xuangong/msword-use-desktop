/**
 * Anthropic SDK wrapper.
 *
 * Provides a single `streamMessage` helper used by the agent loop. Returns
 * an async iterator of typed events so the sidecar can forward CoT / tool_use
 * / text deltas to the UI as they arrive.
 *
 * Reads ANTHROPIC_API_KEY from env. Defaults to claude-sonnet-4-6 with
 * prompt cache enabled on the system block so repeated calls with the same
 * system prompt (typical for a polish session over many paragraphs) get
 * 90% token discount on cache hits.
 */

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

let _client: Anthropic | null = null;

function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set — required for agent operations.");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface ToolSpec {
  name: string;
  description: string;
  // JSON Schema for params
  input_schema: Record<string, unknown>;
}

export interface MessageInput {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown }
        | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
      >;
}

export interface StreamOptions {
  system: string;
  messages: MessageInput[];
  tools?: ToolSpec[];
  model?: string;
  maxTokens?: number;
  cacheSystem?: boolean;
}

/** Discriminated stream events the sidecar can forward to the UI. */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "message_stop"; stopReason: string | null; usage?: unknown };

/**
 * Stream a single message turn. Yields events as they arrive. The full
 * assistant message (with tool_use blocks materialized) is in `stream.finalMessage()`.
 */
export async function* streamMessage(opts: StreamOptions): AsyncGenerator<StreamEvent> {
  const cli = client();
  const systemBlocks: any[] = [
    {
      type: "text",
      text: opts.system,
      ...(opts.cacheSystem !== false ? { cache_control: { type: "ephemeral" } } : {}),
    },
  ];

  const stream = cli.messages.stream({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: systemBlocks,
    messages: opts.messages as any,
    tools: opts.tools as any,
  });

  // We iterate the SDK's typed events and re-emit just the ones the UI cares about.
  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      const delta = event.delta as any;
      if (delta.type === "text_delta") {
        yield { type: "text_delta", text: delta.text };
      }
    }
  }

  const finalMessage = await stream.finalMessage();
  // Surface any tool_use blocks once the message is complete (they're not deltas).
  for (const block of finalMessage.content) {
    if (block.type === "tool_use") {
      yield {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
  }
  yield {
    type: "message_stop",
    stopReason: finalMessage.stop_reason ?? null,
    usage: finalMessage.usage,
  };
}

/** Convenience: collect a complete assistant message non-streaming. */
export async function completeMessage(opts: StreamOptions): Promise<{
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason: string | null;
  usage: unknown;
}> {
  let text = "";
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  let stopReason: string | null = null;
  let usage: unknown = undefined;
  for await (const ev of streamMessage(opts)) {
    if (ev.type === "text_delta") text += ev.text;
    else if (ev.type === "tool_use") toolUses.push({ id: ev.id, name: ev.name, input: ev.input });
    else if (ev.type === "message_stop") {
      stopReason = ev.stopReason;
      usage = ev.usage;
    }
  }
  return { text, toolUses, stopReason, usage };
}
