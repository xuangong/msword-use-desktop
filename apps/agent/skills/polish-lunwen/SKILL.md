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
