/**
 * Build a pi-agent-core `Agent` configured for our Word-driving tools.
 *
 * One factory instance is created at sidecar startup and bound to:
 *   - the singleton Supervisor (driver pipe)
 *   - the loaded skills (read at startup)
 *
 * SessionRegistry then calls `factory(sessionId)` to lazily mint Agents.
 * Each Agent has its own message history; sid is just a label we keep on
 * the registry side.
 */

import { Agent, type Skill } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import type { Supervisor } from "../rpc/supervisor";
import { makeExecCsharpTool } from "./tools/execCsharp";
import { readTool } from "./tools/read";
import { buildSystemPrompt } from "./buildSystemPrompt";

export interface AgentFactoryDeps {
  supervisor: Supervisor;
  skills: Skill[];
  /** Override for tests — defaults to env-based lookup. */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** Override for tests — defaults to anthropic claude-sonnet-4-5. */
  modelId?: string;
}

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-5";

function envApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  return undefined;
}

export function makeAgentFactory(deps: AgentFactoryDeps): (sessionId: string) => Agent {
  const systemPrompt = buildSystemPrompt(deps.skills);
  const modelId = deps.modelId ?? DEFAULT_MODEL;
  // pi-ai's getModel takes a string-literal union; we accept any string at the
  // boundary (env override, tests) and let pi-ai return undefined for unknowns.
  const baseModel = getModel(DEFAULT_PROVIDER, modelId as any);
  if (!baseModel) {
    throw new Error(
      `agent factory: unknown model anthropic/${modelId}. ` +
        `Set MSWORD_MODEL_ID or update DEFAULT_MODEL in agentFactory.ts.`,
    );
  }

  // ANTHROPIC_BASE_URL override: pi-ai reads `model.baseUrl` (not env) when
  // building the SDK client, so we override the field on the model object
  // when a custom endpoint is configured (e.g. corporate proxy / OneAPI).
  const baseUrlOverride = process.env.ANTHROPIC_BASE_URL?.trim();
  const model = baseUrlOverride
    ? { ...baseModel, baseUrl: baseUrlOverride }
    : baseModel;

  const execCsharp = makeExecCsharpTool(deps.supervisor);
  const tools = [execCsharp, readTool];

  return (_sessionId: string) =>
    new Agent({
      initialState: {
        systemPrompt,
        model: model as any, // pi-ai's strong types fight bun-types narrowing here.
        thinkingLevel: "off",
        tools,
      },
      getApiKey: async (provider) => {
        if (deps.getApiKey) return deps.getApiKey(provider);
        const key = envApiKey(provider);
        if (!key) {
          throw new Error(
            `No API key for provider "${provider}". Set ANTHROPIC_API_KEY.`,
          );
        }
        return key;
      },
    });
}
