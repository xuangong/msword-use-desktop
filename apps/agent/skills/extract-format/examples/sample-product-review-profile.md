# Format Profile: sample

源文档: sample.docx
抽取时间: 2026-06-08 17:03:24
段落总数: 20
页面: Letter (612x792pt) / 边距 上下左右均 72pt (1 inch)
默认正文: +Body 12pt / lineSpacing Multiple 13.9
被使用的样式: Heading 1, Heading 2, Normal, List Bullet, List Number

## 文档总览

这是一份英文商业报告 / 产品季度评审样本文档。其可复用格式主要由 5 个格式族构成：

- R1: 文档主标题格式 (Heading 1, +Headings 20pt)
- R2: 普通文本段格式 (Normal, +Body 12pt)
- R3: 章节标题格式 (Heading 2, +Headings 16pt)
- R4: Bullet 列表项格式 (List Bullet, hanging 18pt)
- R5: Numbered 列表项格式 (List Number, hanging 18pt)

内容文字只用于识别层级和角色，不作为格式质量判断依据。拼写错误、TODO、Lorem ipsum 等样本文案问题不进入格式规约，统一放到末尾 `## 样本质检（非格式规约）`。

## 文档结构层级

```text
L0 document: Quarterly Product Review sample
  L1 front-matter (段 1-3)
    role: report title -> R1 (段 1)
    role: metadata line -> R2 (段 2)
    role: draft note -> R2 (段 3)
  L1 section: Summary (段 4)
    role: summary body paragraph -> R2 (段 4)
  L1 section: Highlights (段 5-9)
    role: section heading -> R3 (段 5)
    L2 bullet-list (段 6-9)
      role: highlights metric item -> R4 (段 6-9)
  L1 section: Risks (段 10-11)
    role: section heading -> R3 (段 10)
    role: risk body paragraph -> R2 (段 11)
  L1 section: Action Items (段 12-15)
    role: section heading -> R3 (段 12, format deviation: alignment)
    L2 numbered-list (段 13-15)
      role: action item task -> R5 (段 13-15)
  L1 section: Appendix (段 16-20)
    role: section heading -> R3 (段 16, format deviation: alignment)
    role: appendix placeholder/note -> R2 (段 17-19)
    role: trailing empty paragraph -> no reusable rule (段 20)
```

## Layer/Role 格式规约

### R1. 文档主标题格式

- 格式族: Heading 1 report title
- 适用角色/场景: 文档顶部主标题、报告标题。
- 证据段: 段 1
- 内容线索: 位于文档开头，概括整份文档主题。
- 格式约束:
  - styleName: Heading 1
  - outlineLevel: 1
  - font: +Headings / 20pt
  - alignment: Left
  - spacing: before 18pt, after 4pt
  - lineSpacing: Multiple 13.9
- 耦合度: 弱耦合到文档模板。
- 套用规则: 新文档主标题使用本格式；标题文本本身可替换。

### R2. 普通文本段格式

- 格式族: Normal body/meta paragraph
- 适用角色/场景: metadata line、draft note、summary paragraph、risk paragraph、appendix placeholder/note、普通说明段。
- 所属 layer: L1 front-matter / L1 section body / L1 appendix
- 证据段: 段 2, 3, 4, 11, 17, 18, 19
- 内容线索: 无编号、非标题、非列表项，承担说明性文本或元信息文本。
- 格式约束:
  - styleName: Normal
  - font: +Body / 12pt
  - alignment: Left
  - spacing: before 0pt, after 8pt
  - lineSpacing: Multiple 13.9
  - indent: left 0pt, right 0pt, first 0pt
  - list: none
- 耦合度: 弱耦合到文档正文主题。
- 套用规则: 新增普通文本段统一引用 R2；后续调整正文字号、段后距或行距只改 R2。
- 不拆分说明: Summary、Risks、Appendix 的内容语义不同，但关键格式约束相同，因此不拆成独立规则。

### R3. 章节标题格式

- 格式族: Heading 2 section heading
- 适用角色/场景: 每个 section 的开头标题。
- 所属 layer: L1 section
- 证据段: 段 5, 10；段 12, 16 为同族但存在 alignment 偏离。
- 内容线索: section 开头，短标题，带手写编号。
- 格式约束:
  - styleName: Heading 2
  - outlineLevel: 2
  - font: +Headings / 16pt
  - alignment: Left
  - spacing: before 8pt, after 4pt
  - lineSpacing: Multiple 13.9
- 耦合度: 弱耦合到 section layer。
- 套用规则: 新 section 标题使用 R3。段 12/16 的 Justify 对齐不进入标准规约。

### R4. Bullet 列表项格式

- 格式族: List Bullet item
- 适用角色/场景: Highlights 下的并列成果/指标项；其他同类并列 bullet 也可引用。
- 所属 layer: L1 Highlights > L2 bullet-list
- 证据段: 段 6, 7, 8, 9
- 内容线索: 连续 bullet，表达并列指标或事实。
- 格式约束:
  - styleName: List Bullet
  - font: +Body / 12pt
  - alignment: Left
  - indent: left 18pt, first -18pt
  - spacing: before 0pt, after 8pt
  - lineSpacing: Multiple 13.9
- 耦合度: 弱耦合到列表项格式。
- 套用规则: 新增并列 bullet 项引用 R4。

### R5. Numbered 列表项格式

- 格式族: List Number item
- 适用角色/场景: Action Items 下的顺序任务项。
- 所属 layer: L1 Action Items > L2 numbered-list
- 证据段: 段 13, 14, 15
- 内容线索: 连续编号，表达任务顺序。
- 格式约束:
  - styleName: List Number
  - font: +Body / 12pt
  - alignment: Left
  - indent: left 18pt, first -18pt
  - spacing: before 0pt, after 8pt
  - lineSpacing: Multiple 13.9
  - listLevel: 1
- 耦合度: 编号强耦合到 Action Items 任务序列；字体字号弱耦合到正文主题。
- 套用规则: 新任务项必须进入 numbered-list，不要用普通正文或 bullet 代替。

## 格式异常清单

以下只记录格式偏离，不包含拼写、TODO 或 placeholder 内容问题。

- 段 12: `Heading 2` section heading 但 alignment 为 `Justify`，标准规约 R3 应为 `Left`。
- 段 16: `Heading 2` section heading 但 alignment 为 `Justify`，标准规约 R3 应为 `Left`。
- 段 20: 文档末尾空段落，不建立可复用格式规则。

## 逐段证据

### 段 1

- 内容摘录: `uarterly Product Review - Draft`
- layer / role: L1 front-matter / report title
- 归属格式规约: R1
- 客观格式: Heading 1, +Headings 20pt, Left, before 18pt, after 4pt, outlineLevel 1

### 段 2

- 内容摘录: `Author: Test Fixture    Date: 2026-Q2`
- layer / role: L1 front-matter / metadata line
- 归属格式规约: R2
- 客观格式: Normal, +Body 12pt, Left, after 8pt

### 段 3

- 内容摘录: `This document is a draft and contains a few issues...`
- layer / role: L1 front-matter / draft note
- 归属格式规约: R2
- 客观格式: 同 R2

### 段 4

- 内容摘录: `Overall, the prodcut shipped on time...`
- layer / role: L1 section Summary / summary paragraph
- 归属格式规约: R2
- 客观格式: 同 R2

### 段 5

- 内容摘录: `2. Highlights`
- layer / role: L1 section Highlights / section heading
- 归属格式规约: R3
- 客观格式: Heading 2, +Headings 16pt, Left, before 8pt, after 4pt, outlineLevel 2

### 段 6-9

- 内容摘录: Highlights bullet list
- layer / role: L1 section Highlights > L2 bullet-list / highlights metric item
- 归属格式规约: R4
- 客观格式: List Bullet, +Body 12pt, Left, left 18pt, first -18pt, after 8pt

### 段 10

- 内容摘录: `3. Risks`
- layer / role: L1 section Risks / section heading
- 归属格式规约: R3
- 客观格式: 同 R3

### 段 11

- 内容摘录: `There are a couple of items we are tracking as risks...`
- layer / role: L1 section Risks / risk body paragraph
- 归属格式规约: R2
- 客观格式: 同 R2

### 段 12

- 内容摘录: `4. Action Items`
- layer / role: L1 section Action Items / section heading
- 归属格式规约: R3, with format deviation
- 客观格式: Heading 2, +Headings 16pt, Justify, before 8pt, after 4pt
- 格式偏离: alignment 应按 R3 使用 Left。

### 段 13-15

- 内容摘录: Action Items numbered list
- layer / role: L1 section Action Items > L2 numbered-list / action item task
- 归属格式规约: R5
- 客观格式: List Number, +Body 12pt, Left, left 18pt, first -18pt, after 8pt

### 段 16

- 内容摘录: `5. Appendix`
- layer / role: L1 section Appendix / section heading
- 归属格式规约: R3, with format deviation
- 客观格式: Heading 2, +Headings 16pt, Justify, before 8pt, after 4pt
- 格式偏离: alignment 应按 R3 使用 Left。

### 段 17-19

- 内容摘录: Appendix notes / placeholders
- layer / role: L1 section Appendix / appendix placeholder or note
- 归属格式规约: R2
- 客观格式: Normal, +Body 12pt, Left, after 8pt
- 说明: TODO / Lorem ipsum 是样本文案状态，不是格式规则。

### 段 20

- 内容摘录: empty paragraph
- layer / role: trailing empty paragraph
- 归属格式规约: none
- 客观格式: Normal, +Body 12pt
- 说明: 末尾空段不建立可复用规则。

## 样本质检（非格式规约）

本节仅记录样本文档的内容质量或占位状态，供人工清理样本时参考。以下内容不进入 `Layer/Role 格式规约`，也不影响 R1-R5 的格式约束。

- 段 1: 标题文本疑似缺首字母，`uarterly` 应为 `Quarterly`。
- 段 4: 存在拼写或用词问题，例如 `prodcut`。
- 段 11: 存在拼写问题，例如 `depencency`。
- 段 17-18: TODO 占位内容，需要在正式样本中替换。
- 段 19: Lorem ipsum 占位文本，需要在正式样本中替换。

## 完成摘要

- layer 数: L0 + 6 个 L1 + 2 个 L2
- 格式族规约: 5 条 (R1-R5)
- 格式异常: 3 项 (段 12, 16, 20)
- 内容质检项: 5 项，已与格式规约分离
