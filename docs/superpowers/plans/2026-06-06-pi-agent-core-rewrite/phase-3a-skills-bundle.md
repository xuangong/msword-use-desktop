# Phase 3a — Skills bundle

**Goal:** Drop 5 hand-written `SKILL.md` files into `apps/agent/skills/` following the [agentskills.io](https://agentskills.io/specification) frontmatter spec. Create the empty `apps/agent/docs/` directory placeholder. These are pure content — no code, no tests.

**Files (all new):**
- `apps/agent/skills/word-com-cheatsheet/SKILL.md`
- `apps/agent/skills/track-changes-protocol/SKILL.md`
- `apps/agent/skills/polish-gongwen/SKILL.md`
- `apps/agent/skills/polish-hetong/SKILL.md`
- `apps/agent/skills/polish-lunwen/SKILL.md`
- `apps/agent/docs/.gitkeep`

**Why phase 3a:** Phase 3b's `read` tool whitelist points at these dirs; the dirs must exist before the whitelist resolves. Also: pi's `loadSkills` (used in phase 4b) reads frontmatter at startup; if files are malformed we want to know now, not later.

**Frontmatter contract:** Each `SKILL.md` MUST start with YAML frontmatter containing `name` and `description`. The `name` MUST be lowercase-hyphen-only and SHOULD match the parent dir name. The `description` is what the model sees in the system-prompt skill index, so write it as if briefing a stranger ("when to use this skill, in one sentence").

---

### Task 3a.1: `word-com-cheatsheet`

- [ ] **Step 1: Create the file**

Create `apps/agent/skills/word-com-cheatsheet/SKILL.md`:

```markdown
---
name: word-com-cheatsheet
description: Quick reference for the Microsoft.Office.Interop.Word COM API used inside word.exec_csharp scripts. Read this skill any time you need to write a non-trivial Word manipulation script.
---

# Word COM cheatsheet (for `exec_csharp`)

Your script runs inside a Roslyn C# host with these globals already injected:

- `Doc` — the active `Word.Document`
- `App` — the `Word.Application`
- `Track(Action body)` — wraps a write block in tracked-revisions mode (see `track-changes-protocol`)
- `Print(object o)` — appends a line to the script's stdout (returned to you in `stdout`)

The `Microsoft.Office.Interop.Word` namespace is already imported. So are `System`, `System.Linq`, `System.Collections.Generic`, `System.Text`, `System.Text.RegularExpressions`.

## Reading state

| Want | Code |
|---|---|
| Selection text | `App.Selection.Text` |
| Selection range | `App.Selection.Range` (`.Start`, `.End`) |
| Active doc name | `Doc.Name` |
| Total paragraphs | `Doc.Paragraphs.Count` |
| N-th paragraph (1-based) | `Doc.Paragraphs[n]` → `.Range`, `.OutlineLevel` |
| Paragraph text | `Doc.Paragraphs[n].Range.Text` (note trailing `\r`) |
| Range by char offsets | `Doc.Range(start, end)` |
| Find heading paragraphs | iterate `Doc.Paragraphs`, filter `p.OutlineLevel < 10` |

Use `Print(...)` to surface read values back to yourself across turns:
```csharp
Print(Doc.Paragraphs[6].Range.Text);
```

## Writing state (ALWAYS inside `Track`)

```csharp
Track(() => {
    var rng = Doc.Paragraphs[3].Range;
    rng.Text = "改写后的内容\r";   // KEEP the trailing \r so it stays one paragraph
});
```

| Want | Code |
|---|---|
| Replace paragraph text | `rng.Text = "...\r"` |
| Insert at selection | `App.Selection.TypeText("...")` |
| Add comment | `Doc.Comments.Add(rng, "...")` |
| Find/replace once | see "Find/Replace" below |
| Change paragraph style | `p.Style = Doc.Styles["Heading 1"]` |

## Comments with author attribution

```csharp
Track(() => {
    var prevAuthor = App.UserName;
    try {
        App.UserName = "msword-use AI";
        Doc.Comments.Add(Doc.Paragraphs[5].Range, "[AI: 公文] 改写说明");
    } finally {
        App.UserName = prevAuthor;
    }
});
```

## Find/Replace

```csharp
Track(() => {
    var find = Doc.Range().Find;
    find.Text = "旧词";
    find.Replacement.Text = "新词";
    find.Execute(Replace: Microsoft.Office.Interop.Word.WdReplace.wdReplaceAll);
});
```

## Resolving a target

User intent → range:

- "this paragraph" / "当前选区" → `App.Selection.Range` (or read `observe_selection` style snapshot first)
- "paragraph N" → `Doc.Paragraphs[N].Range`
- range by offsets → `Doc.Range(start, end)`
- by bookmark → `if (Doc.Bookmarks.Exists(name)) Doc.Bookmarks[name].Range`

## Gotchas

- Paragraph text always ends in `\r` (Word's paragraph mark). When replacing, **keep the `\r`** or you'll merge paragraphs.
- COM collections are 1-based (`Paragraphs[1]` is the first).
- `OutlineLevel >= 10` (`wdOutlineLevelBodyText`) means body text, not a heading.
- Do not toggle `Doc.TrackRevisions` yourself. Use `Track(...)`.
- Long-running scripts get killed by the supervisor after 10s. Keep each script focused.

## Returning data

The script's last expression becomes the `result` field:

```csharp
return Doc.Paragraphs.Count;
```

For multi-line debugging, use `Print(...)` and read `stdout`.
```

---

### Task 3a.2: `track-changes-protocol`

- [ ] **Step 1: Create the file**

Create `apps/agent/skills/track-changes-protocol/SKILL.md`:

```markdown
---
name: track-changes-protocol
description: Mandatory rule — every Word mutation must run inside Track(() => { ... }) so the user can review/accept/reject as a tracked revision. Read this skill before writing any script that modifies the document.
---

# Track Changes protocol

The user reviews every AI edit as a Word tracked revision. They accept or reject each one. **This is the product invariant.**

## The rule

Every script submitted to `exec_csharp` that mutates the document MUST wrap its mutations in `Track(...)`:

```csharp
Track(() => {
    // any write goes here: rng.Text = ..., Doc.Comments.Add(...), Find.Execute(...), style changes, etc.
});
```

`Track` enables `Doc.TrackRevisions` for the duration of the lambda and restores the previous setting on exit. So:

- **Reads outside `Track` are fine.** `Print(Doc.Paragraphs[3].Range.Text)` does not need wrapping.
- **Writes outside `Track` silently bypass the review flow. NEVER do this.**
- **Do not manually toggle `Doc.TrackRevisions` yourself.** Use `Track`.

## What counts as a write

Anything that changes document state, including:

- `range.Text = "..."`
- `App.Selection.TypeText(...)`, `TypeParagraph()`
- `Doc.Comments.Add(...)` (yes, comments are tracked too)
- `find.Execute(Replace: ...)` with any wdReplace mode
- Paragraph format changes (`p.Style = ...`, `p.OutlineLevel = ...`)
- `range.Font.Size = ...`, color, bold, etc.
- Inserting tables, images, shapes

## Pattern: read → think → write

```csharp
// Read OUTSIDE Track (no wrapping needed)
var current = Doc.Paragraphs[5].Range.Text;
Print("current: " + current);
```

After reading, **submit a separate `exec_csharp` call** for the write, wrapped in `Track`. Don't try to read-decide-write in one giant script — multiple small scripts let you reason about state between steps and recover from individual failures.

## Comment annotation convention

AI edits should also drop an `[AI:<reason>]` comment on the changed range so the human reviewer sees *why*:

```csharp
Track(() => {
    var rng = Doc.Paragraphs[5].Range;
    rng.Text = newText;
    Doc.Comments.Add(rng, "[AI: 公文] 改写理由：...");
});
```

Author attribution is optional but nice — see `word-com-cheatsheet` for the safe `App.UserName` swap pattern.

## What about read-then-write in one script?

If you absolutely must read-then-write in the same script (e.g., to avoid race conditions with the user), the read can be inside `Track` too — `TrackRevisions=true` does not affect reads:

```csharp
Track(() => {
    var rng = Doc.Paragraphs[5].Range;
    if (rng.Text.Contains("旧词")) {
        rng.Text = rng.Text.Replace("旧词", "新词");
    }
});
```

This is the only acceptable shape. **Never** open `Track`, do a read, close `Track`, then open a fresh script that writes — Track scoping doesn't compose across `exec_csharp` calls (each script is independent).
```

---

### Task 3a.3: `polish-gongwen`

- [ ] **Step 1: Create the file**

Create `apps/agent/skills/polish-gongwen/SKILL.md`:

```markdown
---
name: polish-gongwen
description: Polish a Word paragraph (or selection) into Chinese 公文 (官方公文) style. Use when the user says "公文风格" / "改成公文" / "polish gongwen".
---

# Polish to 公文 (官方公文风格)

公文 is Chinese institutional/government document style. Hallmarks:

- 平实庄重，无口语 ("我们" → "本单位/本部门"，去掉 "其实/感觉/可能")
- 多用四字结构与稳定搭配 ("高度重视、扎实推进、确保落实")
- 句子主谓清晰，避免长定语堆叠
- 数字、时间、法规表述精确，引用要带条款号
- 段首使用规范用语 ("现将...通知如下:"、"为深入贯彻..."、"经研究决定")
- 称谓正式 ("各位领导" → "各级领导干部")

## Workflow

1. **Identify target.** The user invoked from the spotlight; the preamble in this turn already tells you which paragraph (`paragraphIndex`). If unsure, use `exec_csharp` to call `Print(App.Selection.Text)` to confirm.

2. **Read the full paragraph text** if not already shown to you:
   ```csharp
   Print(Doc.Paragraphs[6].Range.Text);
   ```

3. **Decide the rewrite** in your reasoning. Keep factual content; only change register/phrasing. Preserve numbers, names, dates, citations exactly. Headings (`OutlineLevel < 10`) follow a different pattern — see below.

4. **Apply with Track + AI comment**, one `exec_csharp` call:
   ```csharp
   Track(() => {
       var rng = Doc.Paragraphs[6].Range;
       rng.Text = "本单位高度重视...（改写后正文）...\r";
       var prev = App.UserName;
       try {
           App.UserName = "msword-use AI";
           Doc.Comments.Add(rng, "[AI: 公文] 调整为公文体，强化正式表述");
       } finally { App.UserName = prev; }
   });
   return "ok";
   ```

5. **Confirm to the user** in 1-2 Chinese sentences. Do NOT paste the full new text — they'll see it as a tracked revision in Word.

## Headings (`OutlineLevel < 10`)

- Use 4-8 字 nominal phrasing: "关于...的通知", "关于...的实施意见", "工作总结报告"
- No trailing punctuation
- Don't change heading level unless asked

## Quoted text

引号内容 verbatim — never paraphrase quotations even if they sound colloquial.

## Skip conditions

If the original is already 公文 style (starts with "现将", "经研究决定", etc.), reply that it's already in style and skip the rewrite. Don't make cosmetic changes for their own sake.

## Anti-patterns

- ❌ Disabling Track Changes "to make the diff cleaner" — never (see `track-changes-protocol`)
- ❌ Replacing the entire document in one script — one paragraph at a time
- ❌ Inventing facts to make prose flow better — 公文 prizes accuracy over fluency
- ❌ Auto-correcting Chinese punctuation (用「」改成"" etc.) unless the user asked
```

---

### Task 3a.4: `polish-hetong`

- [ ] **Step 1: Create the file**

Create `apps/agent/skills/polish-hetong/SKILL.md`:

```markdown
---
name: polish-hetong
description: Polish a Word paragraph (or selection) into Chinese 合同 (legal contract) style. Use when the user says "合同风格" / "改成合同" / "polish hetong".
---

# Polish to 合同 (合同/法律文书)

合同 = formal Chinese contract language. Hallmarks:

- 严谨、无歧义、不带情绪
- 主语清晰 ("甲方/乙方/双方")，避免代词模糊
- 条款式结构 ("一、…  二、…" 或 "1.1, 1.2")
- 使用"应当 / 不得 / 须 / 经…同意"等规范情态
- 时间精确到日 ("自2026年6月6日起 30 日内")
- 金额、利率、违约金等数字必须精确，避免约数
- 标点严格 ("，；。:" 全角，无英文逗号)

## Workflow

Same shape as `polish-gongwen`:

1. Identify target (use preamble's `paragraphIndex`)
2. Read paragraph: `Print(Doc.Paragraphs[N].Range.Text);`
3. Decide rewrite in reasoning
4. Apply with `Track(...)` + `[AI: 合同]` comment
5. Confirm to user in 1-2 sentences

## Specific rewrites

| 口语 / 软话 | 合同表达 |
|---|---|
| "我们觉得最好…" | "双方一致同意…" |
| "应该尽快" | "应于本协议签订之日起 N 日内" |
| "如果对方违约" | "任何一方违反本协议任何条款的" |
| "差不多 1 万元" | "人民币壹万元整 (￥10,000.00)" |
| "另外说一下" | "特此声明:" |

## Hard rules

- **Don't change金额、日期、人名、公司名 unless explicitly told to.** Read the existing values carefully.
- 引号内容 verbatim
- If a paragraph defines terms (e.g., "本协议所称'设备'是指…"), preserve definition structure
- If you're not sure whether something is a quote / citation / definition, **don't rewrite it** — ask the user.

## Anti-patterns

- ❌ Adding 法律 jargon that wasn't asked for ("不可抗力", "诉讼时效" etc.) — only polish what's there
- ❌ Removing 数字精度 (e.g., "10,000.00" → "1万")
- ❌ Restructuring multi-clause paragraphs into bullets without asking
```

---

### Task 3a.5: `polish-lunwen`

- [ ] **Step 1: Create the file**

Create `apps/agent/skills/polish-lunwen/SKILL.md`:

```markdown
---
name: polish-lunwen
description: Polish a Word paragraph (or selection) into Chinese 论文 (academic paper) style. Use when the user says "论文风格" / "改成学术" / "polish lunwen".
---

# Polish to 论文 (学术论文风格)

论文 = academic/scholarly Chinese. Hallmarks:

- 客观、第三人称、被动语态优先 ("本研究采用…", "实验结果表明…")
- 严谨逻辑：因果链、对照、限定条件清楚 ("在…条件下"，"对于…而言")
- 名词化倾向 ("提高效率" → "效率的提升")
- 引用规范：作者+年份 ("张三 (2024) 指出…") 或 编号 ([1]) — 看上下文判断
- 避免主观词："非常 / 巨大 / 显著地" → "明显 / 显著" (需有数据支持)
- 段落结构: 主张 → 证据 → 阐释 → 小结

## Workflow

1. Identify target (preamble `paragraphIndex`)
2. Read paragraph
3. Decide rewrite, preserving:
   - 所有引用 (作者、年份、编号、文献条目)
   - 所有数据 (百分比、p 值、样本量)
   - 公式 (Word 公式对象不要尝试用 .Text 重写)
4. Apply with `Track(...)` + `[AI: 论文]` comment
5. Confirm to user

## Specific rewrites

| 原句 | 学术化 |
|---|---|
| "我们做了一个实验" | "本研究开展了对照实验" |
| "结果很好" | "结果表明本方法在 X 指标上显著优于基线" |
| "可能是因为…" | "其原因可能在于…" / "推测其机制为…" |
| "差不多 50%" | "约 50% (n=X)" — 若原文有具体数字保留 |

## Hard rules

- 数据不能改（数字、p 值、样本量、置信区间）
- 引用不能改（作者名、年份、编号、文献条目）
- 公式不能改 — 若段落含 Word 公式对象 (`p.Range.OMaths.Count > 0`)，**只改文字部分，公式区域不动**

## Heading polishing

学术标题简短: "X 方法在 Y 场景下的应用研究" / "基于 Z 的 X 优化"

## Anti-patterns

- ❌ 抹平作者原观点（学术写作尊重原意）
- ❌ 加 hedging 加到失去信息 ("可能也许大概或许…")
- ❌ 把数字改成约数
```

---

### Task 3a.6: Create the `docs/` placeholder

The `read` tool whitelist (phase 3b) includes `apps/agent/docs/`. The directory must exist for fs.access checks to succeed.

- [ ] **Step 1: Create empty placeholder**

```bash
mkdir -p apps/agent/docs
printf '%s\n' "# Reserved for W1+ reference material" "" "This directory is whitelisted for the agent's read tool but holds no content in W1." > apps/agent/docs/.gitkeep
```

The `.gitkeep` content is informational (it's a markdown-ish file under the `.gitkeep` name so git tracks the directory).

---

### Task 3a.7: Sanity-check all skill files

- [ ] **Step 1: Verify frontmatter parses (cheap heuristic)**

A skill without proper frontmatter will be silently ignored by pi. Run:

```bash
for f in apps/agent/skills/*/SKILL.md; do
  echo "=== $f ==="
  head -5 "$f"
  echo ""
done
```

Expected output: every file shows `---` on line 1, `name: <something>` on line 2, `description: <something>` on line 3 or 4, closing `---` shortly after.

If any file is missing the frontmatter, fix and re-check.

- [ ] **Step 2: Verify dir layout**

```bash
find apps/agent/skills apps/agent/docs -type f
```

Expected:
```
apps/agent/skills/word-com-cheatsheet/SKILL.md
apps/agent/skills/track-changes-protocol/SKILL.md
apps/agent/skills/polish-gongwen/SKILL.md
apps/agent/skills/polish-hetong/SKILL.md
apps/agent/skills/polish-lunwen/SKILL.md
apps/agent/docs/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add apps/agent/skills apps/agent/docs
git commit -m "feat(skills): bundle 5 SKILL.md (W1 phase 3a)"
```

---

## Phase 3a acceptance

- ✅ `apps/agent/skills/` contains 5 SKILL.md files, each with valid `name`/`description` frontmatter.
- ✅ `apps/agent/docs/` exists with a `.gitkeep` placeholder.
- ✅ Skill `name` values match parent dir names (lowercase-hyphen).
- ✅ All committed.

No code yet — phase 3b consumes these files.
