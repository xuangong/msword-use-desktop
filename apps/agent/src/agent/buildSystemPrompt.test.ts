import { test, expect } from "bun:test";
import type { Skill } from "@earendil-works/pi-agent-core";
import { BASE_SYSTEM_PROMPT, buildSystemPrompt } from "./buildSystemPrompt";

const fakeSkill = (name: string, description: string): Skill => ({
  name,
  description,
  content: `body of ${name}`,
  filePath: `/abs/skills/${name}/SKILL.md`,
});

test("buildSystemPrompt: returns base when no skills", () => {
  expect(buildSystemPrompt([])).toBe(BASE_SYSTEM_PROMPT);
});

test("buildSystemPrompt: appends formatted skill block when skills present", () => {
  const out = buildSystemPrompt([
    fakeSkill("polish-gongwen", "Polish to 公文"),
    fakeSkill("polish-hetong", "Polish to 合同"),
  ]);
  expect(out.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  expect(out).toContain("<available_skills>");
  expect(out).toContain("polish-gongwen");
  expect(out).toContain("Polish to 公文");
  expect(out).toContain("polish-hetong");
});

test("buildSystemPrompt: skill bodies are NOT in the prompt (progressive disclosure)", () => {
  const out = buildSystemPrompt([fakeSkill("x", "y")]);
  expect(out).not.toContain("body of x");
});
