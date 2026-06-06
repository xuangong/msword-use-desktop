# Phase 4b-1 — Agent factory + new `index.ts` (no deletions yet)

**Goal:** Wire pi-agent-core's `Agent` into the sidecar. Build a system prompt that includes the pi-formatted skills index. Rewrite `apps/agent/src/index.ts` to dispatch chat / raw / abort messages from Tauri through the SessionRegistry. **Do not delete the old loop/anthropic/prompts files yet** — that happens in 4b-2 once 4b-1 is verified.

**Files:**
- Modify: `apps/agent/package.json` — add pi deps
- Create: `apps/agent/src/agent/buildSystemPrompt.ts`
- Create: `apps/agent/src/agent/agentFactory.ts`
- Modify: `apps/agent/src/index.ts` — full rewrite
- Test (new): `apps/agent/src/agent/buildSystemPrompt.test.ts`

**Why split from 4b-2:** Adding new code without removing old code keeps the project in a state where, if anything blows up, we can revert just one commit. Deletions are a separate, low-risk follow-up once 4b-1 proves it works.

**Wire protocol from Tauri (recap from spec):**
- `{kind:"chat", id, sessionId, message, pinnedTarget?}` — run a chat turn
- `{kind:"raw", id, code}` — bypass agent, run script directly via supervisor (used by Tauri for the spotlight `paragraphIndex/preview` snapshot in phase 5)
- `{kind:"abort", sessionId}` — call `agent.abort()` on a specific session
- `{kind:"shutdown"}` — clean shutdown

**Outputs to Tauri (forwarded to UI):**
- pi-native events wrapped: `{sessionId, id, kind:"agent_event", event:<pi AgentEvent>}`
- raw responses: `{id, kind:"raw_response", result, stdout, error}`
- driver restarts: `{kind:"driver_restart", from, to, reason}`
- ready: `{ready: true, gen, ...}` (sidecar startup)

---

### Task 4b-1.1: Add pi deps to `apps/agent/package.json`

The package was pinned at the **workspace root** in phase 0 (for the smoke test). Now `apps/agent` itself needs to depend on pi explicitly so it can import in production code, not just at root scope.

- [ ] **Step 1: Add the deps**

Run from worktree root:
```bash
cd apps/agent && bun add -E @earendil-works/pi-agent-core@0.78.1 @earendil-works/pi-ai@0.78.1 typebox
cd ../..
```

`typebox` is a peer of pi-agent-core for tool parameter schemas (we already use it in `read.ts` and `execCsharp.ts`; the explicit add ensures it resolves to a single version under `apps/agent/node_modules`).

`-E` again pins to exact versions.

- [ ] **Step 2: Confirm `apps/agent/package.json`**

It should now contain:

```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "@earendil-works/pi-agent-core": "0.78.1",
    "@earendil-works/pi-ai": "0.78.1",
    "typebox": "<resolved version>"
  }
```

`@anthropic-ai/sdk` stays for now — phase 4b-2 removes it after the old loop is gone.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/package.json bun.lock
git commit -m "deps(sidecar): add pi-agent-core, pi-ai, typebox"
```

---

### Task 4b-1.2: System prompt builder

Pi gives us `formatSkillsForSystemPrompt(skills)` which produces the `<available_skills>` XML block. Our system prompt = a small intro + that block.

**File (new):** `apps/agent/src/agent/buildSystemPrompt.ts`

- [ ] **Step 1: Create the file**

Create `apps/agent/src/agent/buildSystemPrompt.ts`:

```typescript
/**
 * Builds the system prompt for the Word-driving Agent.
 *
 * Two parts:
 *   1. BASE_SYSTEM_PROMPT — task identity + tool roster + global rules
 *   2. <available_skills> XML block — produced by pi's formatSkillsForSystemPrompt
 *
 * The base prompt deliberately keeps the skill bodies OUT of the prompt;
 * pi's progressive-disclosure protocol means the LLM reads full SKILL.md
 * via the `read` tool only when the description matches the user's task.
 */

import { formatSkillsForSystemPrompt, type Skill } from "@earendil-works/pi-agent-core";

export const BASE_SYSTEM_PROMPT = `你是 msword-use 桌面应用的 AI 助手，专门帮助用户在 Microsoft Word 中编辑文档。

工作环境：
- 用户的文档在 Word 中打开，你通过 \`exec_csharp\` 工具运行 C# 脚本与之交互
- 脚本运行在 Roslyn 主机里，预置全局 \`Doc\`、\`App\`、\`Track(Action)\`、\`Print(object)\`
- 所有写操作必须用 \`Track(() => { ... })\` 包裹 —— 这是产品契约
- 每次改动应该附带 \`[AI: <reason>]\` 批注，说明改了什么、为什么

工具：
- \`exec_csharp(code)\` — 运行 C# 脚本，返回 result + stdout + error
- \`read(path)\` — 读取 \`apps/agent/skills/\` 或 \`apps/agent/docs/\` 下的文件

工作准则：
1. 默认操作"当前选区"或 preamble 指定的段落 —— 不要自作主张改其他段落
2. 多轮交互模式：先 read/observe → 决策 → 写入，每步独立 \`exec_csharp\` 调用
3. 中文为主要工作语言；回复简洁
4. 引号内的内容是用户原话，不要改写
5. 遇到 compile_error 或 runtime_error，读错误信息后改写脚本重试 —— 错误是给你看的

如何使用 skill：
- 下面 <available_skills> 列出了可用 skill 的名字和简介
- 当用户任务匹配某个 skill 时，先用 \`read\` 加载它的 SKILL.md 全文，再按 skill 指引行动`;

export function buildSystemPrompt(skills: Skill[]): string {
  const skillsBlock = formatSkillsForSystemPrompt(skills);
  if (!skillsBlock) {
    return BASE_SYSTEM_PROMPT;
  }
  return `${BASE_SYSTEM_PROMPT}\n\n${skillsBlock}`;
}
```

- [ ] **Step 2: Test it**

Create `apps/agent/src/agent/buildSystemPrompt.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run**

```bash
cd apps/agent && bun test src/agent/buildSystemPrompt.test.ts
cd ../..
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/agent/buildSystemPrompt.ts apps/agent/src/agent/buildSystemPrompt.test.ts
git commit -m "feat(sidecar): system prompt builder with skills index"
```

---

### Task 4b-1.3: Agent factory

This is the function `SessionRegistry` calls when a new sid arrives. It builds a fresh pi `Agent` with our tools, system prompt, model, and api-key resolver.

**File (new):** `apps/agent/src/agent/agentFactory.ts`

- [ ] **Step 1: Create the factory**

Create `apps/agent/src/agent/agentFactory.ts`:

```typescript
/**
 * Build a pi-agent-core `Agent` configured for our Word-driving tools.
 *
 * One factory instance is created at sidecar startup and bound to:
 *   - the singleton Supervisor (driver pipe)
 *   - the loaded skills (read at startup)
 *
 * SessionRegistry then calls `factory(sessionId)` to lazily mint Agents.
 * Each Agent has its own message history; sid is just a label we keep on
 * the registry side.
 */

import { Agent, type Skill } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import type { Supervisor } from "../rpc/supervisor";
import { makeExecCsharpTool } from "./tools/execCsharp";
import { readTool } from "./tools/read";
import { buildSystemPrompt } from "./buildSystemPrompt";

export interface AgentFactoryDeps {
  supervisor: Supervisor;
  skills: Skill[];
  /** Override for tests — defaults to env-based lookup. */
  getApiKey?: (provider: string) => Promise<string | undefined>;
  /** Override for tests — defaults to anthropic claude-sonnet-4-5. */
  modelId?: string;
}

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-5";

function envApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  return undefined;
}

export function makeAgentFactory(deps: AgentFactoryDeps): (sessionId: string) => Agent {
  const systemPrompt = buildSystemPrompt(deps.skills);
  const modelId = deps.modelId ?? DEFAULT_MODEL;
  const model = getModel(DEFAULT_PROVIDER, modelId);
  if (!model) {
    throw new Error(
      `agent factory: unknown model anthropic/${modelId}. ` +
        `Set MSWORD_MODEL_ID or update DEFAULT_MODEL in agentFactory.ts.`,
    );
  }

  const execCsharp = makeExecCsharpTool(deps.supervisor);
  const tools = [execCsharp, readTool];

  return (_sessionId: string) =>
    new Agent({
      initialState: {
        systemPrompt,
        model: model as any, // pi-ai's strong types fight bun-types narrowing here.
        thinkingLevel: "off",
        tools,
      },
      getApiKey: async (provider) => {
        if (deps.getApiKey) return deps.getApiKey(provider);
        const key = envApiKey(provider);
        if (!key) {
          throw new Error(
            `No API key for provider "${provider}". Set ANTHROPIC_API_KEY.`,
          );
        }
        return key;
      },
    });
}
```

The `model: model as any` cast is unfortunate but stems from pi-ai's typing — the union of all known model types is wide enough that bun's TS narrowing via `getModel("anthropic", "...")` returns a model whose type doesn't trivially satisfy `Model<any>`. Using `as any` here is contained and unblocks compilation. If you find a clean cast (`as Model<any>` after importing), prefer that.

- [ ] **Step 2: Syntax check**

```bash
cd apps/agent && bunx tsc --noEmit src/agent/agentFactory.ts 2>&1 | head -10
cd ../..
```

Expected: no errors on this file.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/agentFactory.ts
git commit -m "feat(sidecar): agent factory wiring tools + skills + Anthropic"
```

---

### Task 4b-1.4: New `index.ts`

This is the big one — full rewrite of `apps/agent/src/index.ts`. The existing file:
- Spawns Supervisor (keep)
- Reads NDJSON from stdin (keep — protocol shape changes)
- Routes `kind:"chat"` through `runAgentTurn` (replace with SessionRegistry + pi Agent.prompt)
- Routes `kind:"raw"` through `supervisor.callRaw` (replace with `supervisor.runScript`; protocol shape changes too — old was `{method, params}`, new is `{code}`)
- Has a serial chat queue (keep — global FIFO per spec Q1)

**File:** `apps/agent/src/index.ts` (full replacement)

- [ ] **Step 1: Replace `index.ts`**

Open `apps/agent/src/index.ts` and replace its full contents with:

```typescript
/**
 * Bun sidecar entry point — pi-agent-core era.
 *
 * Stdin protocol (line-delimited JSON from Tauri):
 *   {"kind":"chat","id":"<reqId>","sessionId":"<sid>","message":"<text>","pinnedTarget":{paragraphIndex,preview}?}
 *   {"kind":"raw","id":"<reqId>","code":"<C# script>"}
 *   {"kind":"abort","sessionId":"<sid>"}
 *   {"kind":"shutdown"}
 *
 * Stdout protocol (line-delimited JSON to Tauri):
 *   {"ready":true,"driverExe":"...","gen":1}                                       (startup)
 *   {"sessionId":"<sid>","id":"<reqId>","kind":"agent_event","event":<pi-AgentEvent>}  (per pi event)
 *   {"id":"<reqId>","kind":"raw_response","result":...,"stdout":"...","error":null}    (per raw)
 *   {"kind":"driver_restart","from":1,"to":2,"reason":"hang"}                          (supervisor)
 *
 * Concurrency:
 *   - chat requests are SERIALIZED through a single global FIFO chain (per spec Q1)
 *   - raw and abort run concurrently with the chat chain (they don't touch the
 *     same Word selection in adversarial ways: raw is for fast snapshots,
 *     abort is targeted at one session)
 */

import { resolve } from "node:path";
import { Supervisor } from "./rpc/supervisor";
import { loadSkills, NodeExecutionEnv } from "@earendil-works/pi-agent-core";
import { resolveAllowedRoots } from "./agent/skillsRoot";
import { makeAgentFactory } from "./agent/agentFactory";
import { SessionRegistry } from "./agent/sessionRegistry";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

// ---------- driver supervisor ----------

const driverExe =
  process.env.MSWORD_DRIVER_EXE ??
  resolve(import.meta.dir, "../../../drivers/WordDriver/bin/Debug/net48/WordDriver.exe");

const supervisor = new Supervisor({ exePath: driverExe, callTimeoutMs: 10_000 });
supervisor.onGenChange = (info) => {
  write({ kind: "driver_restart", from: info.from, to: info.to, reason: info.reason });
};

// ---------- skills ----------

const roots = resolveAllowedRoots();
const env = new NodeExecutionEnv({ cwd: resolve(roots.skills, "..") });
const { skills, diagnostics } = await loadSkills(env, [roots.skills]);
for (const d of diagnostics) {
  // Warnings about malformed SKILL.md — surface to stderr so a dev sees them
  // without polluting the protocol stream.
  process.stderr.write(`[skills] ${d.code} at ${d.path}: ${d.message}\n`);
}

// ---------- agent registry ----------

const agentFactory = makeAgentFactory({ supervisor, skills });

const registry = new SessionRegistry<Agent>({
  agentFactory: (sid) => {
    const agent = agentFactory(sid);
    // Subscribe each Agent's events at creation time. The listener captures
    // the sid in closure; pi never changes a Session's sid post-construction.
    agent.subscribe((event: AgentEvent) => {
      // We don't have the per-prompt request id here. The sidecar correlates
      // by sid; the UI keys events by sid in atoms. The id field is filled
      // when the prompt was issued (see runChat below).
      const payload = currentPromptId.get(sid);
      const reqId = payload ?? null;
      write({ sessionId: sid, id: reqId, kind: "agent_event", event });
    });
    return agent;
  },
  onDispose: (sid) => {
    currentPromptId.delete(sid);
  },
});

/** sid → request id of the in-flight prompt, if any. Used to tag events. */
const currentPromptId = new Map<string, string>();

// ---------- writer ----------

function write(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

write({ ready: true, driverExe, gen: supervisor.generation });

// ---------- chat FIFO ----------

let chatChain: Promise<void> = Promise.resolve();

function enqueueChat(fn: () => Promise<void>): Promise<void> {
  const next = chatChain.then(fn, fn);
  chatChain = next.catch(() => {});
  return next;
}

// ---------- main loop ----------

let buf = "";
const decoder = new TextDecoder("utf-8");
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handleLine(line);
  }
}

function handleLine(line: string) {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch (err) {
    write({ id: null, kind: "error", error: `parse_error: ${err}` });
    return;
  }

  switch (req.kind) {
    case "chat":
      void enqueueChat(() => runChat(req));
      return;
    case "raw":
      void runRaw(req);
      return;
    case "abort":
      runAbort(req);
      return;
    case "shutdown":
      void runShutdown();
      return;
    default:
      write({ id: req.id ?? null, kind: "error", error: `unknown kind: ${req.kind}` });
  }
}

interface PinnedTarget {
  paragraphIndex?: number;
  preview?: string;
}

interface ChatReq {
  id: string;
  sessionId: string;
  message: string;
  pinnedTarget?: PinnedTarget;
}

async function runChat(req: ChatReq) {
  const { id, sessionId, message, pinnedTarget } = req;
  const agent = registry.getOrCreate(sessionId);
  currentPromptId.set(sessionId, id);

  const userText = pinnedTarget?.paragraphIndex
    ? composePromptWithTarget(message, pinnedTarget)
    : message;

  try {
    await agent.prompt(userText);
  } catch (err: any) {
    write({
      sessionId,
      id,
      kind: "agent_event",
      event: { type: "error", error: String(err?.message ?? err) } as any,
    });
  } finally {
    currentPromptId.delete(sessionId);
  }
}

function composePromptWithTarget(message: string, target: PinnedTarget): string {
  const lines = ["[当前操作目标]"];
  if (target.paragraphIndex) lines.push(`段落索引: ${target.paragraphIndex}`);
  if (target.preview) lines.push(`段落预览: ${target.preview}`);
  lines.push("");
  lines.push(message);
  return lines.join("\n");
}

interface RawReq {
  id: string;
  code: string;
}

async function runRaw(req: RawReq) {
  const { id, code } = req;
  try {
    const resp = await supervisor.runScript(code);
    write({
      id,
      kind: "raw_response",
      result: resp.result,
      stdout: resp.stdout,
      error: resp.error,
    });
  } catch (err: any) {
    write({
      id,
      kind: "raw_response",
      result: null,
      stdout: "",
      error: String(err?.message ?? err),
    });
  }
}

interface AbortReq {
  sessionId: string;
}

function runAbort(req: AbortReq) {
  if (!registry.has(req.sessionId)) return;
  const agent = registry.getOrCreate(req.sessionId);
  agent.abort();
}

async function runShutdown() {
  registry.disposeAll();
  await supervisor.shutdown();
  process.exit(0);
}
```

Notes embedded in the file you should re-read once before continuing:

- `currentPromptId` map: pi's `agent.subscribe` callback doesn't know about the Tauri `requestId`. We stash it sid-keyed at the start of each `runChat` so the subscriber can stamp events. This works because the global FIFO ensures only one chat per sid runs at a time.
- `composePromptWithTarget`: this is the **pinned target preamble** from spec Q4. Bare paragraph index, no char offsets.
- `runShutdown` calls `registry.disposeAll()` first so any pending Agent abort signals fire before the supervisor goes down.

- [ ] **Step 2: Run TypeScript on the new file alone**

```bash
cd apps/agent && bunx tsc --noEmit src/index.ts 2>&1 | head -25
cd ../..
```

Expected: errors will mention old files like `agent/loop.ts` referencing things that no longer exist. **For 4b-1, that's fine.** What matters is no errors *originate from* `src/index.ts` itself.

If you see errors in `src/index.ts` itself, fix them. The most likely culprits:
- `loadSkills` / `NodeExecutionEnv` not found → confirm phase 4b-1.1 added pi as a dep and `bun install` ran
- `Agent` / `AgentEvent` not found → same root cause
- `import.meta.dir` complaint → bun-types version drift; force resolution by adding `// @ts-ignore` above the import.meta.dir line and add a TODO to revisit

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/index.ts
git commit -m "feat(sidecar): rewrite index.ts around pi Agent + SessionRegistry"
```

---

### Task 4b-1.5: Compile-bundle the new sidecar (recheck phase 0 still holds)

Phase 0 proved bun --compile bundles pi-agent-core in isolation. Now that we use it for real, re-run the same compile against `src/index.ts`. Pi-coding-agent imports / dynamic shenanigans we don't expect are most likely to surface here.

- [ ] **Step 1: Compile**

```bash
cd apps/agent && bun build --compile --target=bun-windows-x64 \
  --outfile /tmp/sidecar-w1.exe src/index.ts
cd ../..
```

Expected: clean build, exe present at `/tmp/sidecar-w1.exe`.

If build fails: most likely you import something through `apps/agent/src/index.ts` that wasn't in the phase-0 smoke (e.g. `loadSkills` pulls in `yaml`/`ignore` which need pi-agent-core's `node` entry to be exported correctly). Read the error; if it's a "cannot resolve" for a deep dep, run `bun add -E <that dep>` to make it explicit and re-try.

- [ ] **Step 2: Smoke-run the compiled exe (ready event check only)**

```bash
echo '{"kind":"shutdown"}' | /tmp/sidecar-w1.exe
```

Expected: stdout includes a `{"ready":true,...}` line and the process exits within 1-2 seconds. (The `shutdown` message is consumed and triggers `process.exit(0)` after attempting to talk to the driver — which may not exist on this machine; that's fine, we only care that the sidecar started, printed ready, and could parse the protocol.)

If the exe hangs forever, kill it (Ctrl-C) and investigate. Most common: skill loading at startup fails silently and never reaches the main loop. Check stderr for `[skills]` messages.

- [ ] **Step 3: Clean up the test exe**

```bash
rm /tmp/sidecar-w1.exe
```

No commit here — this is verification only.

---

## Phase 4b-1 acceptance

- ✅ `apps/agent/package.json` depends on `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `typebox` (all exact-pinned).
- ✅ `apps/agent/src/agent/buildSystemPrompt.ts` exports `BASE_SYSTEM_PROMPT` + `buildSystemPrompt(skills)`.
- ✅ `apps/agent/src/agent/agentFactory.ts` exports `makeAgentFactory(deps)`.
- ✅ `apps/agent/src/index.ts` rewritten — uses SessionRegistry + pi Agent + new protocol envelope.
- ✅ `apps/agent/src/agent/buildSystemPrompt.test.ts` passes 3 tests.
- ✅ Phase 1-3 tests still all pass (`bun test src/rpc/ src/agent/`).
- ✅ `bun build --compile` succeeds for the new `src/index.ts`.
- ✅ Compiled exe handles `{"kind":"shutdown"}` and exits cleanly.

**Still broken (intentional, fixed in 4b-2):**
- `src/agent/loop.ts`, `src/llm/anthropic.ts`, `src/agent/prompts.ts`, `src/agent/tools/polishText.ts`, `src/agent/tools/polishText.test.ts`, `src/agent/errors.ts` reference old types and may not type-check. They're orphaned (nothing imports them anymore).

If any acceptance criterion fails, fix in place before starting 4b-2.
