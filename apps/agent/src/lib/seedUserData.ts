/**
 * Seed user data dir (skills/, docs/) from the bundled source-of-truth in
 * apps/agent/skills/ and apps/agent/docs/.
 *
 * Behavior:
 * - Recursively walks the bundle.
 * - Creates missing directories.
 * - Copies any file that doesn't yet exist in the target.
 * - **Never overwrites an existing file** — users may have edited their
 *   SKILL.md to tune prompts, and we don't want to surprise them. (A future
 *   "reset to bundle defaults" command can opt into overwrite explicitly.)
 *
 * The bundle path is resolved relative to this module so it works in both
 * `bun run dev` (apps/agent/src/lib → apps/agent/skills) and
 * `bun build --compile` (path inlined at build time, but the artifact is
 * still bundled — TODO when we package, switch to Tauri resource path).
 */

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { userSkillsDir, userDocsDir } from "./config";

function bundleDir(subdir: "skills" | "docs"): string {
  const packagedRoot = process.env.MSWORD_BUNDLE_ROOT?.trim();
  if (packagedRoot) return resolve(packagedRoot, subdir);

  // import.meta.dir = apps/agent/src/lib in dev
  return resolve(import.meta.dir, "..", "..", subdir);
}

function copyDirIfMissing(srcRoot: string, dstRoot: string): { copied: number; skipped: number } {
  let copied = 0;
  let skipped = 0;

  if (!existsSync(srcRoot)) {
    process.stderr.write(`[seed] bundle dir not found: ${srcRoot} — skipping\n`);
    return { copied, skipped };
  }

  function walk(srcDir: string, dstDir: string) {
    if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      const src = join(srcDir, name);
      const dst = join(dstDir, name);
      const st = statSync(src);
      if (st.isDirectory()) {
        walk(src, dst);
      } else if (st.isFile()) {
        if (existsSync(dst)) {
          skipped++;
        } else {
          copyFileSync(src, dst);
          copied++;
        }
      }
    }
  }

  walk(srcRoot, dstRoot);
  return { copied, skipped };
}

/**
 * Seed both skills/ and docs/ under the user data dir. Idempotent — safe to
 * call on every sidecar startup. Logs a one-line summary to stderr.
 */
export function seedUserData(): void {
  const skillsRes = copyDirIfMissing(bundleDir("skills"), userSkillsDir());
  const docsRes = copyDirIfMissing(bundleDir("docs"), userDocsDir());
  process.stderr.write(
    `[seed] skills: +${skillsRes.copied} new / ${skillsRes.skipped} kept | docs: +${docsRes.copied} new / ${docsRes.skipped} kept\n`,
  );
}
