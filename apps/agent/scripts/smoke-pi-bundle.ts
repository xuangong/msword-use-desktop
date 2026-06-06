/**
 * Phase 0 smoke test for `bun --compile` + pi-agent-core.
 *
 * Goal: prove that pi-agent-core can be bundled into a single Bun executable
 * for Tauri sidecar distribution. We do NOT call any LLM here — we just
 * instantiate `Agent`, register a tool, and verify the constructed object
 * has the expected shape.
 *
 * Pass: prints "smoke ok" and exits 0.
 * Fail: any exception OR exit code != 0.
 *
 * This file is throwaway — delete at end of phase 0.
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const dummyTool: AgentTool = {
  name: "noop",
  label: "noop",
  description: "Does nothing.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "ok" }], details: null };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt: "smoke",
    model: getModel("anthropic", "claude-sonnet-4-5"),
    thinkingLevel: "off",
    tools: [dummyTool],
  },
  // Provide a stub getApiKey so Agent doesn't throw if anything probes it.
  // We never invoke prompt() in this smoke — just construction.
  getApiKey: async () => "sk-not-real",
});

if (typeof agent.subscribe !== "function") {
  console.error("FAIL: agent.subscribe is not a function");
  process.exit(1);
}
if (agent.state.tools.length !== 1) {
  console.error("FAIL: tools array did not survive construction");
  process.exit(1);
}

console.log("smoke ok");
process.exit(0);
