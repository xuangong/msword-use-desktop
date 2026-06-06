/**
 * Resolves the absolute paths of the two directories the `read` tool is
 * allowed to access.
 *
 * Resolution order (first hit wins):
 *   1. env var MSWORD_AGENT_SKILLS_ROOT — set by Tauri or by tests
 *   2. <import.meta.dir>/../../skills (works in `bun run dev` from apps/agent)
 *   3. cwd/apps/agent/skills (works when sidecar is run from repo root)
 *
 * Throws on construction if neither default location exists, so configuration
 * errors surface at startup rather than when the LLM first calls read.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface AllowedRoots {
  /** Absolute, real (symlink-resolved) path. Trailing separator preserved on Windows by realpathSync. */
  skills: string;
  /** Absolute, real path. */
  docs: string;
}

let cached: AllowedRoots | null = null;

function pickRoot(envVar: string, candidates: string[]): string | null {
  const envVal = process.env[envVar]?.trim();
  if (envVal) {
    if (existsSync(envVal)) return realpathSync(envVal);
    throw new Error(
      `${envVar} is set to ${envVal} but that path does not exist`,
    );
  }
  for (const c of candidates) {
    if (existsSync(c)) return realpathSync(c);
  }
  return null;
}

export function resolveAllowedRoots(): AllowedRoots {
  if (cached) return cached;

  // import.meta.dir = apps/agent/src/agent in dev
  // (bun --compile inlines this to the original path at build time)
  const here = import.meta.dir;
  const appAgentDir = resolve(here, "..", ".."); // apps/agent/

  const skills = pickRoot("MSWORD_AGENT_SKILLS_ROOT", [
    resolve(appAgentDir, "skills"),
    resolve(process.cwd(), "apps/agent/skills"),
  ]);
  if (!skills) {
    throw new Error(
      "skills root not found — set MSWORD_AGENT_SKILLS_ROOT or run sidecar with apps/agent/skills reachable",
    );
  }

  const docs = pickRoot("MSWORD_AGENT_DOCS_ROOT", [
    resolve(appAgentDir, "docs"),
    resolve(process.cwd(), "apps/agent/docs"),
  ]);
  if (!docs) {
    throw new Error(
      "docs root not found — set MSWORD_AGENT_DOCS_ROOT or run sidecar with apps/agent/docs reachable",
    );
  }

  cached = { skills, docs };
  return cached;
}

/** Test seam — reset between tests that override env vars. */
export function __resetAllowedRootsForTesting(): void {
  cached = null;
}
