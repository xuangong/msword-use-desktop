# Phase 3b — `read` AgentTool

**Goal:** A pi-shaped `AgentTool` named `read` that loads files from a tight whitelist. The LLM uses it to fetch full `SKILL.md` content when pi's progressive-disclosure protocol surfaces a relevant skill in the system prompt.

**Files:**
- Create: `apps/agent/src/agent/skillsRoot.ts` — single source of truth for which dirs `read` is allowed to see
- Create: `apps/agent/src/agent/tools/read.ts` — the AgentTool
- Create: `apps/agent/src/agent/tools/read.test.ts` — unit tests

**Why phase 3b:** Phase 4b's `Agent` wiring needs a tool object to pass into `initialState.tools`. Read is the simpler of the two tools (file system only, no driver involvement), so it's a good first integration with pi's `AgentTool` shape before the more complex `exec_csharp` in 3c.

**Whitelist:** absolute, canonicalised paths under
- `<repo>/apps/agent/skills/`
- `<repo>/apps/agent/docs/`

Anything else returns an error result (NOT a thrown exception — pi treats thrown exceptions as tool failures, but a path-traversal attempt should look to the LLM like a normal error response it can recover from, e.g. by picking a legal path).

**Safety scope:** Per `memory/w1-capability-first.md`, security beyond simple path hygiene is W1+. Don't add file-content sniffing, MIME checks, max-size limits, etc. unless an actual test fixture demands it. Keep this tool tiny.

---

### Task 3b.1: Skills root resolver

The driver-relative path resolution in `apps/agent/src/index.ts` already walks up directories to find `drivers/WordDriver/...`. We follow the same convention for the skills/docs roots so they work both in `bun run dev` and in the `bun --compile`'d sidecar exe.

**File (new):** `apps/agent/src/agent/skillsRoot.ts`

- [ ] **Step 1: Create the resolver**

Create `apps/agent/src/agent/skillsRoot.ts`:

```typescript
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
```

- [ ] **Step 2: Smoke-import it to make sure the file parses**

Run from repo root:
```bash
cd apps/agent && bun -e 'import("./src/agent/skillsRoot.ts").then(m => console.log(m.resolveAllowedRoots()))'
cd ../..
```

Expected output: an object with both `skills` and `docs` pointing at the real absolute paths. If you see "skills root not found", check that phase 3a actually committed the dirs.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/skillsRoot.ts
git commit -m "feat(sidecar): allowed-roots resolver for read tool"
```

---

### Task 3b.2: `read` tool implementation

The pi-shaped `AgentTool` contract (recap):
- `name`, `label`, `description`, `parameters` (typebox schema)
- `execute(toolCallId, params, signal?, onUpdate?) → AgentToolResult<TDetails>`
- Throw on infra failure; encode protocol-level errors as `AgentToolResult` with text content. (For us: throw never; path errors come back as `content: [{type:"text", text:"error: ..."}]` plus a clear leading "error:" so the LLM sees them.)

**File (new):** `apps/agent/src/agent/tools/read.ts`

- [ ] **Step 1: Create the tool**

Create `apps/agent/src/agent/tools/read.ts`:

```typescript
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
```

Note: `require("node:path").sep` in the helper is intentional — keeps it self-contained without a top-level dynamic import. Bun supports `require` in ESM modules.

- [ ] **Step 2: Build-check (syntax only — full project still doesn't compile)**

```bash
cd apps/agent && bunx tsc --noEmit src/agent/tools/read.ts 2>&1 | head -20
cd ../..
```

You'll see errors about `loop.ts` and `index.ts` from earlier — **ignore those**. The only errors you should care about are ones inside `src/agent/tools/read.ts` or `src/agent/skillsRoot.ts`. If only the loop/index ones appear, this file is clean.

If `bunx tsc` reports errors on the new file itself, fix them before committing.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/tools/read.ts
git commit -m "feat(sidecar): read AgentTool with skills/docs whitelist"
```

---

### Task 3b.3: Unit tests for `read`

**File (new):** `apps/agent/src/agent/tools/read.test.ts`

Three things to cover:
1. Reading a real `SKILL.md` from `skills/` returns its content
2. Path traversal returns an error result (not a thrown exception)
3. Non-existent path returns an error result
4. (bonus) File outside whitelist via absolute path returns an error result

- [ ] **Step 1: Create the test file**

Create `apps/agent/src/agent/tools/read.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { readTool } from "./read";
import { __resetAllowedRootsForTesting } from "../skillsRoot";

beforeEach(() => {
  __resetAllowedRootsForTesting();
});

test("read: loads a real SKILL.md from skills/", async () => {
  const r = await readTool.execute(
    "tc1",
    { path: "skills/polish-gongwen/SKILL.md" },
  );
  const block = r.content[0];
  expect(block?.type).toBe("text");
  if (block?.type === "text") {
    expect(block.text).toContain("name: polish-gongwen");
    expect(block.text).toContain("公文");
  }
  expect((r.details as any)?.bytes).toBeGreaterThan(0);
});

test("read: path traversal returns error result, not throw", async () => {
  const r = await readTool.execute(
    "tc2",
    { path: "../../../../etc/passwd" },
  );
  expect(r.content[0]?.type).toBe("text");
  if (r.content[0]?.type === "text") {
    expect(r.content[0].text.startsWith("error:")).toBe(true);
    expect(r.content[0].text).toContain("not allowed");
  }
  expect(r.details).toBeNull();
});

test("read: absolute path outside whitelist returns error result", async () => {
  // Pick a guaranteed-existing file outside the whitelist.
  const outside = process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts";
  const r = await readTool.execute("tc3", { path: outside });
  expect(r.content[0]?.type).toBe("text");
  if (r.content[0]?.type === "text") {
    expect(r.content[0].text.startsWith("error:")).toBe(true);
    expect(r.content[0].text).toContain("not allowed");
  }
});

test("read: missing file returns 'not found' error", async () => {
  const r = await readTool.execute(
    "tc4",
    { path: "skills/no-such-skill/SKILL.md" },
  );
  expect(r.content[0]?.type).toBe("text");
  if (r.content[0]?.type === "text") {
    expect(r.content[0].text.startsWith("error:")).toBe(true);
    expect(r.content[0].text).toContain("not found");
  }
});

test("read: empty path returns error", async () => {
  const r = await readTool.execute("tc5", { path: "" });
  expect(r.content[0]?.type).toBe("text");
  if (r.content[0]?.type === "text") {
    expect(r.content[0].text).toContain("non-empty");
  }
});
```

- [ ] **Step 2: Run the read tests**

```bash
cd apps/agent && bun test src/agent/tools/read.test.ts
cd ../..
```

Expected: 5 tests pass.

Common breakers:
- `cannot stat: not found` on the polish-gongwen test → skills bundle from phase 3a wasn't committed or paths are wrong; check `find apps/agent/skills -name SKILL.md`.
- "skills root not found" → `MSWORD_AGENT_SKILLS_ROOT` is set in your shell pointing somewhere stale; `unset MSWORD_AGENT_SKILLS_ROOT` and retry.
- On Windows, the `/etc/hosts` test will skip because the file doesn't exist there. The variant uses `C:\Windows\System32\drivers\etc\hosts` which is always present.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/tools/read.test.ts
git commit -m "test(sidecar): read tool unit tests"
```

---

## Phase 3b acceptance

- ✅ `apps/agent/src/agent/skillsRoot.ts` resolves skills + docs absolute paths; honours `MSWORD_AGENT_SKILLS_ROOT` / `MSWORD_AGENT_DOCS_ROOT` overrides.
- ✅ `apps/agent/src/agent/tools/read.ts` exports a pi `AgentTool` named `read`.
- ✅ Reads inside whitelist return file content as text block.
- ✅ Path traversal returns an error result (not a thrown exception).
- ✅ Missing files return clear "not found" error.
- ✅ All read tests pass.
- ✅ Phase 1/2 tests still pass (re-run `bun test src/rpc/` to confirm nothing regressed).

If any criterion fails, fix in place — do not start 3c.
