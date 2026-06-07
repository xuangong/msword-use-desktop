/**
 * Resolves the absolute paths of the two directories the `read` tool is
 * allowed to access. Both live under the user-data dir (~/.config/msword-use/
 * or %APPDATA%/msword-use/ etc — see lib/config.ts) and are seeded from the
 * bundle at startup.
 *
 * Resolution order (first hit wins):
 *   1. MSWORD_AGENT_SKILLS_ROOT / MSWORD_AGENT_DOCS_ROOT (tests / dev override)
 *   2. <dataDir>/skills, <dataDir>/docs (the production location)
 *
 * Throws if the user-data dir doesn't exist after seeding — configuration
 * errors surface at startup rather than when the LLM first calls read.
 *
 * Note on symlinks (W1 deferral): realpathSync canonicalises the root paths
 * once at startup, but child paths from the read tool are resolved lexically
 * (not through realpath). A symlink under skills/ pointing outside is
 * therefore not blocked by the isUnder() check. Acceptable while the skills
 * tree is seeded from the dev-controlled bundle. Revisit when "skill packs"
 * (user-uploaded skills) become a thing.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { userSkillsDir, userDocsDir } from "../lib/config";

export interface AllowedRoots {
  /** Absolute, real (symlink-resolved) path to the user skills dir. */
  skills: string;
  /** Absolute, real path to the user docs dir. */
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

  const skills = pickRoot("MSWORD_AGENT_SKILLS_ROOT", [userSkillsDir()]);
  if (!skills) {
    throw new Error(
      `skills root not found at ${userSkillsDir()} — sidecar should have seeded it from the bundle. Did skill seeding fail?`,
    );
  }

  const docs = pickRoot("MSWORD_AGENT_DOCS_ROOT", [userDocsDir()]);
  if (!docs) {
    throw new Error(
      `docs root not found at ${userDocsDir()} — sidecar should have seeded it from the bundle. Did skill seeding fail?`,
    );
  }

  cached = { skills, docs };
  return cached;
}

/** Test seam — reset between tests that override env vars. */
export function __resetAllowedRootsForTesting(): void {
  cached = null;
}
