/**
 * `read` AgentTool — load a file from the skills or docs root.
 *
 * The LLM uses this to fetch full SKILL.md content when the system-prompt
 * skill index lists a skill matching the user's task. It is also available
 * for any future reference material under apps/agent/docs/.
 *
 * Whitelist is strict: paths must canonicalise to inside skills or docs.
 * Path-traversal attempts return an error response (not a thrown exception)
 * so the LLM can recover by picking a legal path.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveAllowedRoots } from "../skillsRoot";

const ReadParams = Type.Object({
  path: Type.String({
    description:
      "File path to read. Must resolve under apps/agent/skills/ or apps/agent/docs/. " +
      "You can use the absolute paths shown in <available_skills> location fields, " +
      "or relative paths like 'skills/polish-gongwen/SKILL.md'.",
  }),
});

interface ReadDetails {
  resolvedPath: string;
  bytes: number;
}

const MAX_BYTES = 256 * 1024; // 256 KiB. Plenty for SKILL.md; protects from accidentally large files.

function errorResult(message: string): AgentToolResult<ReadDetails | null> {
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    details: null,
  };
}

export const readTool: AgentTool<typeof ReadParams, ReadDetails | null> = {
  name: "read",
  label: "read",
  description:
    "Read a UTF-8 text file from the agent's bundled skills or docs directories. " +
    "Use this to load the full body of a SKILL.md when its name appears in <available_skills>. " +
    "Paths are restricted to apps/agent/skills/ and apps/agent/docs/.",
  parameters: ReadParams,

  async execute(_toolCallId, params): Promise<AgentToolResult<ReadDetails | null>> {
    const { path: requested } = params as Static<typeof ReadParams>;
    if (typeof requested !== "string" || requested.length === 0) {
      return errorResult("path must be a non-empty string");
    }

    let roots;
    try {
      roots = resolveAllowedRoots();
    } catch (err) {
      // Infra failure — throwing surfaces it as a tool failure to pi.
      throw err;
    }

    // Resolve relative paths against the parent of both roots (i.e. apps/agent)
    // so requests like "skills/polish-gongwen/SKILL.md" work naturally.
    const appAgentDir = resolve(roots.skills, "..");
    const resolved = resolve(appAgentDir, requested);

    const allowed =
      isUnder(resolved, roots.skills) || isUnder(resolved, roots.docs);
    if (!allowed) {
      return errorResult(
        `path not allowed: ${resolved} is outside skills/ and docs/`,
      );
    }

    let info;
    try {
      info = await stat(resolved);
    } catch (err: any) {
      return errorResult(
        `cannot stat: ${err?.code === "ENOENT" ? "not found" : String(err?.message ?? err)}`,
      );
    }
    if (!info.isFile()) {
      return errorResult(`not a regular file: ${resolved}`);
    }
    if (info.size > MAX_BYTES) {
      return errorResult(
        `file too large: ${info.size} bytes (max ${MAX_BYTES})`,
      );
    }

    let content: string;
    try {
      content = await readFile(resolved, "utf-8");
    } catch (err: any) {
      return errorResult(`read failed: ${String(err?.message ?? err)}`);
    }

    return {
      content: [{ type: "text", text: content }],
      details: { resolvedPath: resolved, bytes: info.size },
    };
  },
};

function isUnder(child: string, parent: string): boolean {
  // Normalise both via resolve() already done by caller. On Windows, paths
  // are case-insensitive; do a case-insensitive prefix check.
  const sep = parent.endsWith("/") || parent.endsWith("\\") ? "" : require("node:path").sep;
  const a = (child + sep).toLowerCase();
  const b = (parent + sep).toLowerCase();
  return a.startsWith(b);
}
