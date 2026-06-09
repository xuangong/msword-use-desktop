/**
 * `exec_csharp` AgentTool — the agent's only path to mutate Word.
 *
 * Takes a C# script, forwards it to the driver via Supervisor.runScript,
 * and returns the structured response as text the LLM can read.
 *
 * Globals available to the script (documented in word-com-cheatsheet SKILL.md):
 *   - Doc  (Word.Document)
 *   - App  (Word.Application)
 *   - Track(Action body)  — wrap mutations in tracked-revisions mode
 *   - Print(object o)     — append to script stdout (returned in `stdout` field)
 *
 * Returned text shape:
 *   on success: "result: <json>\nstdout:\n<stdout>"
 *   on error:   "error: <message>\nstdout:\n<stdout>"
 *
 * The LLM sees both stdout AND the result/error in one block, so it can react
 * to a compile_error by reading the diagnostics and retrying with a fix.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { HangError } from "../../rpc/supervisor";
import type { Supervisor } from "../../rpc/supervisor";

const ExecParams = Type.Object({
  code: Type.String({
    description:
      "C# script body. Will run inside the live Word session. " +
      "Globals: Doc (Word.Document), App (Word.Application), Track(Action) " +
      "to wrap mutations in tracked revisions, Print(object) to append to " +
      "stdout. All mutations MUST run inside Track(() => { ... }). " +
      "Read the track-changes-protocol skill if unsure.",
  }),
});

interface ExecDetails {
  result: unknown;
  stdout: string;
  error: string | null;
  /** True if the supervisor reported a hang (driver was killed and restarted). */
  hung: boolean;
}

/**
 * Build the LLM-facing text block from a driver response. Both `stdout` and
 * `result`/`error` are surfaced so the model has all the diagnostic context
 * in one place.
 */
function formatText(args: { result: unknown; stdout: string; error: string | null }): string {
  const { result, stdout, error } = args;
  const head = error
    ? `error: ${error}`
    : `result: ${result === undefined ? "undefined" : JSON.stringify(result)}`;
  // Always show stdout (empty string if none) so the model knows it didn't miss anything.
  return `${head}\nstdout:\n${stdout ?? ""}`;
}

export function makeExecCsharpTool(
  supervisor: Supervisor,
  /** Returns the HWND of the Word window the current chat session should
   *  operate on. 0 means "no pin — fall back to App.ActiveDocument" (used
   *  by tests / pre-spotlight callers). Called fresh on every tool execute
   *  so an agent reused across hotkey invocations always sees the latest
   *  trigger window. */
  getTriggerHwnd: () => number = () => 0,
): AgentTool<typeof ExecParams, ExecDetails> {
  return {
    name: "exec_csharp",
    label: "exec_csharp",
    description:
      "Execute a Roslyn C# script against the live Microsoft Word document. " +
      "Use this for ALL Word reads and mutations. Read 'word-com-cheatsheet' " +
      "and 'track-changes-protocol' skills before non-trivial use. " +
      "All mutations MUST be wrapped in Track(() => { ... }).",
    parameters: ExecParams,

    async execute(_toolCallId, params, _signal): Promise<AgentToolResult<ExecDetails>> {
      const { code } = params as Static<typeof ExecParams>;
      if (typeof code !== "string" || code.trim().length === 0) {
        return {
          content: [{ type: "text", text: "error: code must be a non-empty string\nstdout:\n" }],
          details: { result: null, stdout: "", error: "empty_code", hung: false },
        };
      }

      // Note: pi's `_signal` here is an AbortSignal we currently can't propagate
      // into the supervisor.runScript path — runScript doesn't take a signal in
      // phase 2. The supervisor's own 10s callTimeoutMs is the upper bound on a
      // hung Roslyn call, which is enough for W1. Cooperative abort propagation
      // is tracked for a later phase.

      let resp;
      try {
        resp = await supervisor.runScript(code, getTriggerHwnd());
      } catch (err) {
        // HangError → driver was killed + respawned. Return error text so the
        // LLM sees it and can retry with a smaller/different script.
        if (err instanceof HangError) {
          return {
            content: [
              {
                type: "text",
                text:
                  "error: driver hung and was restarted — the previous script took longer than 10s. " +
                  "Try a smaller script, or split work across multiple exec_csharp calls.\nstdout:\n",
              },
            ],
            details: { result: null, stdout: "", error: "hang", hung: true },
          };
        }
        // Other errors (e.g. "driver restarted N times in the last minute") are
        // genuine infra failures. Throw so pi marks this as a tool failure.
        throw err;
      }

      return {
        content: [
          { type: "text", text: formatText(resp) },
        ],
        details: {
          result: resp.result,
          stdout: resp.stdout,
          error: resp.error,
          hung: false,
        },
      };
    },
  };
}
