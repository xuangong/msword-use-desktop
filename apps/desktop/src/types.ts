// Shared types for agent events emitted by the Bun sidecar.
// Mirrors apps/agent/src/agent/loop.ts's AgentEvent.
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; name: string; result: unknown }
  | { kind: "done"; text: string; stopReason: string | null }
  | { kind: "error"; error: string };

export interface SidecarMessage {
  id?: string;
  kind?: "agent_event" | "driver_restart";
  event?: AgentEvent;
  // driver_restart fields
  from?: number;
  to?: number;
  reason?: string;
  // raw RPC reply shape
  result?: unknown;
  error?: string | null;
  gen?: number;
  ready?: boolean;
  driverExe?: string;
}

export interface WordSelection {
  text: string;
  start: number;
  end: number;
  isEmpty: boolean;
  paragraphIndex?: number | null;
  page?: number | null;
}

export interface OutlineNode {
  level: number;
  text: string;
  start: number;
}

export interface WordOutline {
  total: number;
  truncated: boolean;
  outline: OutlineNode[];
}

export interface WordAttach {
  attached: boolean;
  version: string;
  documents: number;
  activeDoc?: string | null;
}

export interface WordContext {
  attach: WordAttach | null;
  selection: WordSelection | null;
  outline: WordOutline | null;
  refreshedAt: number;
  error?: string;
}
