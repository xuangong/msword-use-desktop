import { test, expect, beforeEach, afterAll } from "bun:test";
import { resolve } from "node:path";
import { readTool } from "./read";
import { __resetAllowedRootsForTesting } from "../skillsRoot";

// Tests target the bundle directly (apps/agent/skills) instead of the
// user data dir, so we don't depend on the seeding side-effect and don't
// pollute the developer's real %APPDATA%/msword-use during test runs.
const BUNDLE_SKILLS = resolve(import.meta.dir, "..", "..", "..", "skills");
const BUNDLE_DOCS = resolve(import.meta.dir, "..", "..", "..", "docs");
const ORIG_SKILLS = process.env.MSWORD_AGENT_SKILLS_ROOT;
const ORIG_DOCS = process.env.MSWORD_AGENT_DOCS_ROOT;

beforeEach(() => {
  process.env.MSWORD_AGENT_SKILLS_ROOT = BUNDLE_SKILLS;
  process.env.MSWORD_AGENT_DOCS_ROOT = BUNDLE_DOCS;
  __resetAllowedRootsForTesting();
});

afterAll(() => {
  if (ORIG_SKILLS === undefined) delete process.env.MSWORD_AGENT_SKILLS_ROOT;
  else process.env.MSWORD_AGENT_SKILLS_ROOT = ORIG_SKILLS;
  if (ORIG_DOCS === undefined) delete process.env.MSWORD_AGENT_DOCS_ROOT;
  else process.env.MSWORD_AGENT_DOCS_ROOT = ORIG_DOCS;
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

test("read: maps legacy apps/agent/skills path to skills root", async () => {
  const r = await readTool.execute(
    "tc1b",
    { path: "apps/agent/skills/polish-gongwen/SKILL.md" },
  );
  const block = r.content[0];
  expect(block?.type).toBe("text");
  if (block?.type === "text") {
    expect(block.text).toContain("name: polish-gongwen");
  }
  expect((r.details as any)?.resolvedPath.replace(/\\/g, "/")).toContain(
    "/skills/polish-gongwen/SKILL.md",
  );
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
