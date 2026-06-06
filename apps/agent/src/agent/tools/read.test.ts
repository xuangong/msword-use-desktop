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
