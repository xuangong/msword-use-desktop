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
