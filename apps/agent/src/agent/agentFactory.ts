/**
 * Build a pi-agent-core `Agent` configured for our Word-driving tools.
 *
 * One factory instance is created at sidecar startup and bound to:
 *   - the singleton Supervisor (driver pipe)
 *   - the loaded skills (read at startup)
 *   - the loaded MswordUseConfig (api key, base url, model, gateway tweaks)
 *
 * SessionRegistry then calls `factory(sessionId)` to lazily mint Agents.
 * Each Agent has its own message history; sid is just a label we keep on
 * the registry side.
 *
 * All LLM-runtime configuration comes from the MswordUseConfig. Environment
 * variables are NOT consulted for api key / base url / model / thinking
 * tweaks — write a config.json instead. See lib/config.ts for path resolution.
 */

import { Agent, type Skill } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import type { Supervisor } from "../rpc/supervisor";
import type { MswordUseConfig } from "../lib/config";
import { makeExecCsharpTool } from "./tools/execCsharp";
import { readTool } from "./tools/read";
import { buildSystemPrompt } from "./buildSystemPrompt";

export interface AgentFactoryDeps {
  supervisor: Supervisor;
  /**
   * Snapshot of currently-loaded skills at the moment a new Agent is built.
   * A getter (not an array) so the factory always sees the latest set after
   * reload — newly minted Agents include skills added since startup. Existing
   * Agents keep the prompt they were created with until index.ts pushes an
   * update via Agent.state.systemPrompt = ...
   */
  getSkills: () => Skill[];
  config: MswordUseConfig;
  /** Override for tests — defaults to config.apiKey. */
  getApiKey?: (provider: string) => Promise<string | undefined>;
}

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-5";

export function makeAgentFactory(deps: AgentFactoryDeps): (sessionId: string) => Agent {
  const { config } = deps;
  const modelId = config.model ?? DEFAULT_MODEL;
  // pi-ai's getModel takes a string-literal union; we accept any string at
  // the boundary (config override, tests) and let pi-ai return undefined for
  // unknowns.
  const baseModel = getModel(DEFAULT_PROVIDER, modelId as any);
  if (!baseModel) {
    throw new Error(
      `agent factory: unknown model anthropic/${modelId}. ` +
        `Set "model" in config.json or update DEFAULT_MODEL in agentFactory.ts.`,
    );
  }

  // baseUrl override: pi-ai reads `model.baseUrl` (not env) when building
  // the SDK client, so we override the field on the model object when a
  // custom endpoint is configured (corporate proxy / OneAPI / etc).
  //
  // disableThinkingField: strips `reasoning` from the model so pi-ai never
  // sends the `thinking: {type, display}` schema. Required for upstream
  // Anthropic-compatible gateways that don't yet implement the
  // adaptive-thinking schema (they reject with 400 "thinking.disabled.display:
  // Extra inputs are not permitted"). Drop this once the gateway supports it.
  const baseUrlOverride = config.baseUrl?.trim();
  const stripThinking = config.disableThinkingField === true;
  let model: typeof baseModel = baseModel;
  if (baseUrlOverride || stripThinking) {
    model = { ...baseModel } as typeof baseModel;
    if (baseUrlOverride) (model as any).baseUrl = baseUrlOverride;
    if (stripThinking) (model as any).reasoning = undefined;
  }

  const execCsharp = makeExecCsharpTool(deps.supervisor);
  const tools = [execCsharp, readTool];

  return (_sessionId: string) =>
    new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(deps.getSkills()),
        model: model as any, // pi-ai's strong types fight bun-types narrowing here.
        thinkingLevel: "off",
        tools,
      },
      getApiKey: async (provider) => {
        if (deps.getApiKey) return deps.getApiKey(provider);
        if (provider === "anthropic" && config.apiKey) return config.apiKey;
        throw new Error(
          `No API key for provider "${provider}". ` +
            `Add "apiKey" to config.json (see config.example.json).`,
        );
      },
    });
}
