// Shared types for agent events emitted by the Bun sidecar.
// Mirrors apps/agent/src/agent/loop.ts's AgentEvent.
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; name: string; result: unknown }
  | { kind: "done"; text: string; stopReason: string | null }
  | { kind: "error"; error: string };

export interface SidecarMessage {
  id: string;
  kind?: "agent_event";
  event?: AgentEvent;
  // raw RPC reply shape
  result?: unknown;
  error?: string | null;
  gen?: number;
  ready?: boolean;
  driverExe?: string;
}
