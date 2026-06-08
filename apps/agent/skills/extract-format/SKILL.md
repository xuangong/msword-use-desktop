---
name: extract-format
description: 从当前 Word 文档抽取一份可复用「格式档」（profile.md），用作后续套用、对比、分类的基础。产物必须包含文档层级结构树 + layer/role 驱动的格式规约 + 逐段证据快照，写入 `<dataDir>/format-profiles/<name>/profile.md`。适用于：用户拿到一份样板（公文 / 合同 / 论文 / 内部模板 / 商业报告）希望以后能按这个文档的风格排版别的文档。
---

# 文档格式蒸馏（extract-format）

## 目标

把当前 Word 文档「这类内容在这个结构层里应该怎么排」的信息保存成可复用格式档。内容只用于辅助判断结构、角色和格式语义，**不要评价内容质量，也不要输出文案改写建议**。产物分三层：

1. **文档结构层级树**：先识别文档、封面/头部、章节、列表块、附录、页脚/抄送等层级。格式大概率挂在 layer 上，而不是按段落顺序平铺。
2. **Layer/role 格式规约**：在每个层级内总结“格式族 -> 适用内容角色 -> 格式约束 -> 套用规则”。同一个 `Normal` 样式在不同 layer 里可能是元信息、正文、TODO、附录说明；如果关键格式约束一致，应合并为同一个可维护格式规则，并把不同语义列为适用场景/证据，不要复制出多条重复规约。
3. **逐段证据快照**：保留客观格式数据，作为规约的叶子证据和异常排查依据。

不要只做逐段流水账，也不要只按线性顺序归纳角色。逐段数据只是叶子证据；用户真正需要的是“在文档的某个 layer 里看到某种内容时，应套用哪一类格式、哪些参数必须保持、哪些参数可跟随该 layer 的全局规约”。**内容质量问题不是本 skill 的目标**；错别字、缺字、表达不佳、业务逻辑问题只在影响格式判断时作为异常线索提一句，否则不要分析。

## 格式规则合并原则（重要）

`Layer/Role 格式规约` 不是“每种内容语义一条规则”，而是“每种可复用格式族一条规则”。语义角色用于解释为什么某段属于这个格式族，不应导致重复格式约束。

输出前必须做一次自检：

- 如果规则清单里出现 `R4: 概述正文`、`R7: Risks 正文段落`、`R9: TODO 占位段`、`R10: Lorem ipsum 占位文本` 这种“名称不同但格式约束几乎相同”的规则，**必须重写并合并**。
- `TODO`、`Lorem ipsum`、拼写错误、措辞问题、业务内容问题不是格式规约，也不是格式异常。它们最多是“内容占位/内容质量线索”，只有在导致了独特排版（例如灰色、斜体、边框、批注、高亮）时才进入格式规约或格式异常。
- `异常清单` 只允许写格式异常：字号、字体、颜色、对齐、缩进、间距、编号、边框、样式、run 局部格式污染等。**不要把拼写错误、缺词、语义不通、placeholder 文本列为格式异常**。
- 格式规约条数应接近“不同格式族数量”，不是“不同 section/内容角色数量”。对于普通 product review 文档，常见规则通常是：主标题、元信息、草稿说明/普通正文、章节标题、bullet 列表项、numbered 列表项、附录/占位正文（若格式与普通正文相同则并入普通正文）。

必须合并的情况：

- 多个角色的关键格式约束几乎一致，例如 `Normal / Justify / +Body 12pt / after 8pt / 无编号`，即使它们分别是 overview paragraph、risk paragraph、appendix note，也应合并为一条“正文段落 / Normal body paragraph”规约。
- 多个角色的关键格式约束只差内容文本或 section 名称。例如 overview、Risks、TODO、Lorem ipsum 若都是 `Normal 12pt + 相同对齐/缩进/间距`，应共用一个 ruleId，在 `适用角色/场景` 中列出这些角色。
- 差异只在文本内容、业务含义、段落所处 section 名称，而字号、字体、缩进、间距、编号、对齐等关键格式一致。
- 后续如果用户要改字号/行距，显然应该只改一处的规则。

应该拆分的情况：

- 关键格式约束不同：字号、字体、缩进、编号、对齐、边框、列表层级、段前段后、行距、outlineLevel 等存在稳定差异。
- 同一基础格式上有明确强耦合的额外约束，例如版记上下边框、警示块红色加粗、法律条款编号、Action Items 必须 numbered list。
- 同样叫 `Normal`，但在不同 layer 中格式参数稳定不同，或套用规则明显不同。

写法要求：

- 规则标题优先命名为格式族，例如 `R4. Normal 正文段落格式`、`R7. Section heading format`、`R9. Numbered action item format`。
- 在规则内写 `适用角色/场景`，列出 overview / risks / notes / appendix text 等语义用途。
- `证据段`可以跨多个 layer，但必须说明“这些段格式同族，语义不同但排版约束相同”。
- 如果某个语义角色需要单独记录，但格式不应拆规则，在结构树或逐段证据里标 role，在规约层引用同一个 ruleId。

## 产物

```
<dataDir>/format-profiles/<name>/
  profile.md          ← 主产物。文档结构层级树 + layer/role 格式规约 + 文档总览 + 逐段证据块
  meta.json           ← { source, extractedAt, paragraphCount, ... }
```

`<name>` 由用户指令给出（"张总公文"、"合同模板 v3"），如果没说就询问，**不要自己起名**。

## profile.md 结构

```
# Format Profile: <name>

源文档: <doc filename>
抽取时间: <ISO ts>
段落总数: N
页面: A4 / 边距 上 3.7cm 左 2.8cm ...
默认正文: 仿宋_GB2312 16pt
被使用的样式: 标题 1, 标题 2, 正文, ...
编号定义:
  - listTemplate#1: "一、", "（一）", "1.", ...
  - listTemplate#2: ...

## 文档总览
（LLM 写一段：整体格式风格、主导结构、格式族数量、重复结构、格式异常摘要。不要写拼写/TODO/placeholder 等内容质量问题。）

## 文档结构层级

```text
L0 document: Quarterly Product Review
  L1 front-matter: title + author/date + draft note (段 1-3)
  L1 section: Highlights (段 5-9)
    L2 heading: 段 5
    L2 bullet-list: 段 6-9
  L1 section: Risks (段 10-11)
  L1 section: Action Items (段 12-15)
    L2 heading: 段 12
    L2 numbered-list: 段 13-15
  L1 appendix: 段 16-20
```

每个 layer 必须写：范围、内容功能、子层、对应段号、主要格式规约、异常。

## Layer/Role 格式规约

### L1/front-matter · R1. 文档主标题 / report title / 文件标题
- 适用内容: 文档顶部、概括全文主题的标题；通常出现 1 次。
- 所属 layer: front-matter
- 证据段: 段 1
- 内容线索: 标题性名词短语；没有句号；位于文档开头。
- 格式约束:
  - styleName: Heading 1
  - outlineLevel: 1
  - font: +Headings / 20pt
  - spacing: before 18pt, after 4pt
- 耦合度: 弱耦合（文档模板约束）
- 套用规则: 新文档主标题使用本格式；标题文字本身可替换。
- 反例/不要泛化: 若该段出现异常颜色/字体/缩进等格式偏离，放入 `## 格式异常清单`；若只是缺字、拼写、测试残留，放入 `## 样本质检（非格式规约）`，不要写进格式规约。

### L1/section · R2. 章节标题格式
- 适用内容: 每个 section 的开头标题，承载章节分组语义。
- 所属 layer: section
- 证据段: 段 5、10、12、16
- 内容线索: 位于 section 开头；短标题；可能带手写编号。
- 格式约束: Heading 2 / outlineLevel 2 / +Headings 16pt / before 8pt after 4pt。
- 耦合度: 弱耦合（section layer 的标题规约）
- 套用规则: 新 section 标题套用该规约；编号策略跟随文档（手写编号或自动编号）。
- 反例/不要泛化: 段 12/16 的 justify 或异常颜色若与其他 section heading 不一致，记为该 layer 的异常偏离。

### L2/list-block · R3. Bullet 列表项格式
- 适用内容: Highlights section 下的并列成果/指标。
- 适用角色/场景: Highlights bullet item；其他 section 中若格式约束一致且同为并列 bullet，可引用同一规则并在适用场景中补充。
- 所属 layer: Highlights section > bullet-list
- 证据段: 段 6-9
- 内容线索: 连续 bullet；每项是一条成果指标；属于 Highlights。
- 格式约束: List Bullet / leftIndent 18pt / hanging 18pt / +Body 12pt / after 8pt。
- 耦合度: 弱耦合（该 list block 的列表项规约）
- 套用规则: Highlights 下新增并列成果时使用本规约。
- 反例/不要泛化: 其他 section 的 bullet 若关键格式和套用动作一致，可引用同一规则并补充适用场景；只有缩进/编号层级/强调/边框等格式约束稳定不同才拆新规则。

### L2/list-block · R4. Numbered 列表项格式
- 适用内容: Action Items section 下的顺序任务项。
- 适用角色/场景: Action item task；其他顺序任务/步骤若格式和编号约束一致，可引用同一规则；如果法律条款、章节编号等编号语义不同，再拆分。
- 所属 layer: Action Items section > numbered-list
- 证据段: 段 13-15
- 内容线索: 连续编号；每项包含 action / owner / due。
- 格式约束: List Number / leftIndent 18pt / hanging 18pt / +Body 12pt / after 8pt。
- 耦合度: 强耦合到 Action Items layer（因为编号表达任务顺序）；字体/字号弱耦合到正文主题。
- 套用规则: 新任务项必须进入 numbered-list，不要用普通正文或 bullet。
- 反例/不要泛化: 其他 numbered list 若是法律条款/步骤说明，要按其 layer 另建规则。

---

## 段 1
内容: 国务院关于推进…的通知

格式:
  styleName: 标题
  pf:
    alignment: center
    firstLineIndent: 0
    lineSpacing: 1.5x
    spaceBefore: 12pt
    spaceAfter: 6pt
    outlineLevel: 1
    listLevel: null
  runs:
    - "国务院关于推进…的通知"  方正小标宋 22pt 粗细=normal 颜色=#FF0000

批注: [发文机关红头·强耦合]
  特征: 红色 / 居中 / 方正小标宋 22pt
  说明: 公文头部固定模式，红色是法规要求；不是该文档的私有选择。
  套用建议: 任何公文同位置都应保留此参数。

---

## 段 2
内容: 各省、自治区…：

格式:
  styleName: 正文
  pf:
    alignment: justify
    firstLineIndent: 2chars
    lineSpacing: fixed-28pt
    spaceBefore: 0pt
    spaceAfter: 0pt
  runs:
    - "各省、自治区…"  仿宋_GB2312 16pt

批注: [主送机关·中耦合]
  特征: 段首平齐 / 无缩进的"机关名称："格式
  说明: 公文规约要求主送机关顶格、不缩进、冒号结尾。
  套用建议: 强耦合（不缩进是规约），但字体字号跟随 profile 全局。

---

...
```

### 批注的耦合度三档

每段批注**必须**给一个耦合度标签：

- **强耦合** —— 格式由内容/语义决定，套到别的文档**这种内容仍然这样排**。例：红头必须红、警示必须粗、款号必须括号编号。
- **弱耦合** —— 格式是文档全局规约，所有相同角色的段都一样。例：所有正文都仿宋 16pt 行距 28pt。
- **偶发 / 存疑** —— 异常的格式 override，可能是手误或样式遗留。**不要**泛化。

不确定就标 **存疑**，宁可让后续梳理时人手裁决，也不要瞎猜。

## 层级结构与格式规约层（必须写）

`profile.md` 不能只包含逐段落 block。必须按以下顺序写：

1. `## 文档结构层级`
2. `## Layer/Role 格式规约`
3. `## 格式异常清单`
4. `## 逐段证据`
5. `## 样本质检（非格式规约）`（只有存在内容质量/placeholder 信息时才写）

### 文档结构层级

先建立结构树，再写规约。结构树至少区分：

- **L0 document**：整份文档的全局主题、页面、默认字体、主样式体系。
- **L1 major layers**：front matter / header / section / appendix / signature / footer / reference list 等。
- **L2 blocks**：某个 section 下的 paragraph group、bullet list、numbered list、table、quote/callout、TODO block 等。
- **L3 paragraph roles**：标题、元信息、正文、列表项、落款、附注等。
- **L4 inline runs**：局部强调、链接、代码、修订残留、颜色标记等。

每个 layer 必须写：

- **范围**：段号范围，例如 `段 6-9`。
- **父子关系**：挂在哪个父 layer 下。
- **内容功能**：这层内容在文档里承担什么功能。
- **格式主约束**：这一层共享的样式/缩进/编号/间距。
- **子层/叶子段**：包含哪些 block 或段。
- **格式异常**：哪些段偏离本 layer 的格式规约，且不应进入正常规则。不要在结构层级里写拼写/TODO/Lorem ipsum 等内容质量问题。

### Layer/Role 格式规约

每条规约是一个“可复用格式族 -> 适用内容角色/场景 -> 格式约束”的卡片，必须包含：

- **规则名**：优先表示格式族和主要用途，例如“Normal 正文段落格式”“section heading format”“numbered task list format”。不要因为内容语义不同复制同一套格式约束。
- **所属 layer**：必须写清楚，例如 `L1 section: Highlights > L2 bullet-list`。
- **适用内容**：什么样的新内容应该套这个格式。
- **适用角色/场景**：哪些语义角色共用这条格式。若跨 layer 共用，说明它们格式同族。
- **证据段**：哪些段支持这个规约。至少 1 段；重复结构必须列多个段号。
- **内容线索**：基于文本/位置/父子层级/上下文的判断依据，而不只是 `styleName`。
- **格式约束**：只写归一化后的关键参数，不要把每段原始字段全复制进去。
- **耦合度**：强耦合 / 弱耦合 / 存疑。
- **套用规则**：后续应用到新文档时怎么用。
- **反例/不要泛化**：哪些看似格式差异其实是异常、测试残留、手工污染或局部强调。

### 规约层写作要求

- 先建 layer/tree，再读内容，再看格式。不要按段落顺序直接写角色。
- `Heading 2` 不是角色；“section heading in Product Review”才是角色；`List Number` 不是角色；“Action Items numbered task list”才是角色。
- 同一 layer 内同一角色的多段要合并成一条规约，但逐段证据仍保留在后面。
- **同一关键格式约束出现在多个语义角色中，默认先合并为一个格式族规则**，再用 `适用角色/场景` 说明差异。不要把 R4、R7、R9、R10 这种几乎相同的 Normal 正文段拆成多条重复规则。
- 同一格式出现在不同 layer，不要机械合并，也不要机械拆分；先判断关键格式约束和后续维护动作是否一致。若改字号/间距时应该一起改，就合并；若某 layer 有稳定额外约束，就拆分。
- 同一语义跨多个 layer，默认也不要强行合并；先说明父 layer 是否改变了格式含义。
- 只把“能解释格式角色”的格式提到规约层；纯偶发格式字段留在 `## 格式异常清单`。
- 如果一个样式服务多种 layer/role，**不要自动拆成多条规约**。先比较关键格式约束和后续维护动作：若字号/间距/缩进/对齐等应一起维护，就合并成一个格式族；若某个 role 有稳定额外格式约束，再拆分。
- 如果一个内容角色出现异常格式，要写“目标规约”和“异常偏离”两部分，不要把异常格式当成规约。
- 对商业报告/产品评审类文档，要特别识别：主标题、元信息、章节标题、普通正文、bullet 列表项、numbered 列表项。Appendix/TODO/placeholder 只有在格式不同或有独特格式标记时才形成新格式规则；否则作为 R2/R正文类的适用场景。

### 规约层质量红线

以下输出不合格，必须重写：

- 只有“段 1 是 Heading 1、段 2 是 Normal”这种样式复述。
- 只有线性角色清单，没有 `## 文档结构层级`。
- 所有 `Normal` 不看关键格式差异就机械合成一个“正文”规则，导致真实格式差异丢失。
- 同一套 `Normal` 正文格式被拆成多条重复规则，导致字号/间距修改要改很多处。
- 所有列表都合成一个“列表项”规则，没有区分 bullet 指标列表和 numbered action items。
- 批注只说“标准格式，内容可替换”，没有说明适用内容。
- 没有把重复格式族合并成可维护规约。
- 把错别字、残缺标题、TODO、Lorem ipsum 等内容问题写入格式规约或格式异常清单。
- `## 文档总览` 没有总结“主要 layer / 主要格式族 / 格式异常不纳入规约”的清单。

## 工作流（三遍：扫描 → 层级归纳 → 写档）

### Pass 1 — 客观扫描（exec_csharp）

**只 dump 数据，不解读**。一次跑完，输出到本地临时变量或直接通过 `Print` 流式吐出。

需要采集的字段（每段一行）：
- `idx` 段号 (1-based)
- `styleName`（`paragraph.Style.NameLocal`，本地化名）
- 段落原文 `text`（截断到 200 chars，超长加 …）
- **pf 段落级**:
  - `alignment` (Left/Center/Right/Justify)
  - `leftIndent` (cm)
  - `rightIndent` (cm)
  - `firstLineIndent` (cm，正值=缩进，负值=悬挂)
  - `spaceBefore` (pt)
  - `spaceAfter` (pt)
  - `lineSpacingRule` + `lineSpacing` (Single/1.5x/Double/AtLeast/Exactly/Multiple + value)
  - `outlineLevel` (1-9 / BodyText)
  - `listLevelNumber` (null 或 1..9) + `listTemplateId`
  - `keepWithNext` / `pageBreakBefore`（仅记 true 的）
- **runs 字符级**: 一段里每个 run 一行（Characters 遍历，相邻同格式合并）
  - `text`（截断 100 chars）
  - `font.NameAscii` / `font.NameFarEast`（中英可能不同！都要）
  - `font.Size`（pt）
  - `font.Bold` / `font.Italic`
  - `font.Underline`（是 enum，不是 bool；记 enum 值）
  - `font.Color`（int → 转 #RRGGBB；负值 = wdColorAutomatic 记 "auto"）
  - `font.Highlight`（wdColorIndex enum；记名字或 "none"）
  - `font.StrikeThrough` / `Subscript` / `Superscript`（仅记 true）

**run 合并规则**：对一段 `Range`，遍历 `Characters[i]`，相邻字符如果 (NameAscii, NameFarEast, Size, Bold, Italic, Underline, Color, Highlight, Strike, Sub/Sup) 全等就并入当前 run，否则起新 run。空白字符不单独切 run（继承前一个）。

**文档级一次性**：
- 页面: `Doc.PageSetup` 的 PaperSize / TopMargin / LeftMargin / ...
- 默认: `Doc.Styles[wdStyleNormal]` 的 Font / ParagraphFormat
- InUse 样式列表: 遍历 `Doc.Styles`，过滤 `s.InUse == true`，记 NameLocal
- 编号定义: `Doc.ListTemplates`（每个 Template 的 9 级 NumberFormat / NumberStyle / TextBefore/After）

### Pass 2 — 层级归纳 + 格式族合并（LLM）

用 Pass 1 的数据 + 段落原文，先做“文档结构层级树”，再归纳语义角色，随后按关键格式约束合并成格式族规则，最后写逐段批注。内容原文只帮助判断 layer/role；不要评价内容质量。

#### 2A. 先建立结构树

从头到尾读段落内容，但输出不是线性表，而是结构树：

```
L0 document: Quarterly Product Review
  L1 front-matter: 段 1-3
    R1 report title: 段 1
    R2 author/date metadata: 段 2
    R3 draft note: 段 3
  L1 section Highlights: 段 5-9
    R4 section heading: 段 5
    L2 bullet-list: 段 6-9
      R5 highlights bullet item: 段 6-9
  L1 section Action Items: 段 12-15
    R4 section heading: 段 12
    L2 numbered-list:
      R6 action item task: 段 13-15
```

结构树必须回答：**这个段落为什么属于这个父 layer？在该 layer 内它承担什么角色？**

#### 2B. 再建立格式族规约表

先把段落按关键格式约束归并，再把语义角色挂到规则上。不要直接“每个角色一条规约”。

归并键优先看：

- styleName
- alignment
- font family / size / bold / color
- firstLineIndent / leftIndent / hanging
- spaceBefore / spaceAfter / lineSpacing
- listLevel / listString / listTemplate
- outlineLevel
- border / shading / keepWithNext / pageBreakBefore

示例：如果 R4、R7、R9、R10 都是 `Normal / Justify / +Body 12pt / after 8pt / no list`，应合并为：

```
ruleId: R4
规则名: Normal 正文段落格式
所属 layer: L1 front-matter / L1 section body / L1 appendix（跨 layer 共用）
适用角色/场景: overview paragraph、risk paragraph、appendix note、普通说明段
证据段: 3、7、9、10
内容线索: 都是无编号叙述性段落；承担正文说明，不是标题/列表/元信息控件
格式共性: Normal, Justify, +Body 12pt, after 8pt, no list
耦合度: 弱耦合到文档正文主题
套用规则: 新增普通叙述段统一引用 R4；后续改正文字号/间距只改 R4
异常/反例: 若某段有边框、显著强调色、不同缩进或列表编号，再拆成独立规则
```

规约表必须回答：**如果新文档在同一个 layer 出现同类内容，应该套哪条规则？**
同时还必须回答：**如果后续统一调整某一类字号/间距，应改哪一条规则，不能分散到多条重复规则。**

#### 2C. 再写逐段批注

每段批注四件套：
1. **归属 layer / 角色名**（用户语言起，**不要硬塞预设清单**——是「红头」就写红头，是「带编号的小节标题」就写带编号的小节标题，是「不知道」就写"未识别"）
2. **特征**（这段被识别为这个 layer/role 的可观察依据，1 行）
3. **说明**（为什么这种内容会这么排，链接到耦合度判断）
4. **套用建议**（引用统一 ruleId + 强/弱/存疑 + 一句话动作指引）

逐段批注可以有不同 role，但可以引用同一个格式规则。例如：

```
批注: [Risks 正文段 · 引用 R4 Normal 正文段落格式]
  特征: 位于 Risks section，承担风险说明；格式与 overview/appendix 普通正文同族。
  说明: 内容语义不同，但字号、间距、缩进、对齐均属于统一正文格式。
  套用建议: 引用 R4；不要新建一条只属于 Risks 的重复格式规则。
```

**判断耦合度的提问**（写批注时自问）：
- 把这段内容换成完全不同的文字，原排版还合理吗？
  - 合理 → 弱耦合（格式跟 profile 走）
  - 不合理（必须配合内容才说得通）→ 强耦合
- 这种格式在文档其他地方有没有重复出现？
  - 多次重复（≥3 次）→ 是规约，弱或强
  - 仅 1-2 次 → 可能强耦合，也可能存疑，看内容能不能解释
  - 仅 1 次且内容平庸 → 存疑

### Pass 3 — 写格式档 + 分离样本质检

读完所有段批注后，按固定顺序写 profile.md：

1. `## 文档总览`
2. `## 文档结构层级`
3. `## Layer/Role 格式规约`
4. `## 格式异常清单`
5. `## 逐段证据`
6. `## 样本质检（非格式规约）`（仅当存在拼写/TODO/placeholder 等内容质量信息时写）

`## Layer/Role 格式规约` 和 `## 格式异常清单` 只处理格式。`## 样本质检（非格式规约）` 才允许记录拼写错误、TODO、Lorem ipsum、业务语义问题、样本文案待替换等信息。

`## 文档总览` 写：
- 整体类型印象（公文 / 合同 / 论文 / 报告 / 自由排版……）
- 主导层级结构（"front matter → sections → list blocks → appendix"）
- 主导语义角色（"标题、元信息、章节标题、正文、bullet 指标、numbered action items、appendix/TODO"）
- 主导格式规约（"正文统一 +Body 12pt，Heading 2 统一 16pt，列表统一悬挂缩进 18pt"）。这里要按格式族汇总，不要按内容语义拆重复条目。
- 重复结构（"段 6-9 是 Highlights bullet；段 13-15 是 Action Items numbered list"）
- 格式异常清单（所有「存疑格式」段的段号汇总，并声明不进入正常规约）。不要列内容质量、拼写、placeholder、业务语义问题。
- 覆盖率粗估（多少段被有把握地分类了）

`## 文档结构层级` 写树。

`## Layer/Role 格式规约` 写格式族卡片。格式族卡片必须可直接指导后续“套格式”任务；逐段证据块只是附录证据。

`## 格式异常清单` 只写格式偏离，例如：

- 段 12: section heading 使用 `Heading 2` 但 alignment 为 `Justify`，目标 R3 应为 `Left`。
- 段 16: 同 R3 的 alignment 偏离。

不要写：

- 拼写错误、缺词、错别字。
- TODO / Lorem ipsum / placeholder。
- 内容是否合理、业务逻辑是否正确。

这些只能进入 `## 样本质检（非格式规约）`。

## 完整 C# 模板：Pass 1 扫描

```csharp
// extract-format / Pass 1：客观格式快照
// 用法：Track 不需要——只读，无任何修改
// 输出：用 Print 一行一行 JSON 吐出来（每段一行 + 文档级一行 prefix doc:）
using System.Text;
using System.Globalization;

string Json(string s) => System.Web.HttpUtility.JavaScriptStringEncode(s ?? "", true);
string ColorHex(int c) {
    if (c < 0) return "\"auto\"";
    int r = c & 0xFF, g = (c >> 8) & 0xFF, b = (c >> 16) & 0xFF;
    return string.Format("\"#{0:X2}{1:X2}{2:X2}\"", r, g, b);
}

// --- 文档级 ---
var ps = Doc.PageSetup;
var sb = new StringBuilder();
sb.Append("{\"kind\":\"doc\",");
sb.Append("\"name\":").Append(Json(Doc.Name)).Append(",");
sb.Append("\"paragraphCount\":").Append(Doc.Paragraphs.Count).Append(",");
sb.Append("\"page\":{");
sb.Append("\"width_pt\":").Append(ps.PageWidth.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
sb.Append("\"height_pt\":").Append(ps.PageHeight.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
sb.Append("\"top_pt\":").Append(ps.TopMargin.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
sb.Append("\"bottom_pt\":").Append(ps.BottomMargin.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
sb.Append("\"left_pt\":").Append(ps.LeftMargin.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
sb.Append("\"right_pt\":").Append(ps.RightMargin.ToString("F1", CultureInfo.InvariantCulture));
sb.Append("},");
// InUse styles
sb.Append("\"stylesInUse\":[");
bool first = true;
foreach (Microsoft.Office.Interop.Word.Style st in Doc.Styles) {
    try {
        if (!st.InUse) continue;
        if (!first) sb.Append(",");
        first = false;
        sb.Append(Json(st.NameLocal));
    } catch { /* 一些样式访问 InUse 会抛 */ }
}
sb.Append("]}");
Print(sb.ToString());

// --- 逐段 ---
int idx = 0;
foreach (Microsoft.Office.Interop.Word.Paragraph para in Doc.Paragraphs) {
    idx++;
    var rng = para.Range;
    var pf = para.Format;
    var fnt = rng.Font;
    var text = rng.Text ?? "";
    if (text.Length > 200) text = text.Substring(0, 200) + "…";

    var p = new StringBuilder();
    p.Append("{\"kind\":\"para\",\"idx\":").Append(idx).Append(",");
    p.Append("\"text\":").Append(Json(text.TrimEnd('\r', '\n', '\a'))).Append(",");
    p.Append("\"styleName\":").Append(Json(((Microsoft.Office.Interop.Word.Style)para.get_Style()).NameLocal)).Append(",");

    // pf
    p.Append("\"pf\":{");
    p.Append("\"alignment\":\"").Append(pf.Alignment.ToString()).Append("\",");
    p.Append("\"leftIndent_pt\":").Append(pf.LeftIndent.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
    p.Append("\"rightIndent_pt\":").Append(pf.RightIndent.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
    p.Append("\"firstLineIndent_pt\":").Append(pf.FirstLineIndent.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
    p.Append("\"spaceBefore_pt\":").Append(pf.SpaceBefore.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
    p.Append("\"spaceAfter_pt\":").Append(pf.SpaceAfter.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
    p.Append("\"lineSpacingRule\":\"").Append(pf.LineSpacingRule.ToString()).Append("\",");
    p.Append("\"lineSpacing\":").Append(pf.LineSpacing.ToString("F1", CultureInfo.InvariantCulture)).Append(",");
    p.Append("\"outlineLevel\":\"").Append(pf.OutlineLevel.ToString()).Append("\",");
    try {
        var lf = para.Range.ListFormat;
        p.Append("\"listLevel\":").Append(lf.ListLevelNumber).Append(",");
        p.Append("\"listString\":").Append(Json(lf.ListString ?? ""));
    } catch {
        p.Append("\"listLevel\":null,\"listString\":\"\"");
    }
    p.Append("},");

    // runs：遍历 Characters 合并相邻同格式
    p.Append("\"runs\":[");
    int charsCount = rng.Characters.Count;
    string curKey = null;
    var curText = new StringBuilder();
    string curHeader = null;
    bool firstRun = true;
    Action flush = () => {
        if (curKey == null) return;
        if (!firstRun) p.Append(",");
        firstRun = false;
        string t = curText.ToString();
        if (t.Length > 100) t = t.Substring(0, 100) + "…";
        p.Append("{").Append(curHeader).Append(",\"text\":").Append(Json(t.TrimEnd('\r', '\n', '\a'))).Append("}");
    };
    for (int i = 1; i <= charsCount; i++) {
        var ch = rng.Characters[i];
        var f = ch.Font;
        string nameAscii = f.NameAscii ?? "";
        string nameFarEast = f.NameFarEast ?? "";
        var size = f.Size;
        var bold = f.Bold;
        var italic = f.Italic;
        var underline = (int)f.Underline;
        var color = f.Color;
        var highlight = (int)f.Highlight;
        var strike = (int)f.StrikeThrough;
        var sub = (int)f.Subscript;
        var sup = (int)f.Superscript;
        string key = nameAscii + "|" + nameFarEast + "|" + size + "|" + bold + "|" + italic + "|" + underline + "|" + color + "|" + highlight + "|" + strike + "|" + sub + "|" + sup;
        if (key != curKey) {
            flush();
            curKey = key;
            curText = new StringBuilder();
            var h = new StringBuilder();
            h.Append("\"fontAscii\":").Append(Json(nameAscii));
            h.Append(",\"fontFarEast\":").Append(Json(nameFarEast));
            h.Append(",\"size_pt\":").Append(((float)size).ToString("F1", CultureInfo.InvariantCulture));
            h.Append(",\"bold\":").Append(((int)bold) == -1 ? "true" : ((int)bold) == 0 ? "false" : "\"mixed\"");
            h.Append(",\"italic\":").Append(((int)italic) == -1 ? "true" : ((int)italic) == 0 ? "false" : "\"mixed\"");
            h.Append(",\"underline\":\"").Append(f.Underline.ToString()).Append("\"");
            h.Append(",\"color\":").Append(ColorHex(color));
            h.Append(",\"highlight\":\"").Append(f.Highlight.ToString()).Append("\"");
            if (strike != 0) h.Append(",\"strike\":true");
            if (sub != 0) h.Append(",\"sub\":true");
            if (sup != 0) h.Append(",\"sup\":true");
            curHeader = h.ToString();
        }
        curText.Append(ch.Text);
    }
    flush();
    p.Append("]}");
    Print(p.ToString());
}
```

> **数据规模警告**：长文档（>200 段）一次性 Print 可能让上下文吃紧。可分批 (`for i in [1..50]`, `[51..100]`...) 或先 dump 到文件再 read。第一版先一次跑完，遇到上下文压力再优化。

## 工作流提示给 LLM

1. 用户说「抽取这份文档的格式，叫它『XXX』」时启动本 skill。如果用户没起名，**先问名字**再继续。
2. 跑 **Pass 1** 脚本，把 stdout 收回（每行是一条 JSON）。
3. 在工作区构造 `<dataDir>/format-profiles/<name>/`：
   - 用 `read` 工具确认 `<dataDir>` 路径（来自 systemPrompt）
   - exec_csharp 内用 `System.IO.File.WriteAllText(...)` 写 profile.md 和 meta.json
4. 不要立即写成最终 profile。先在脑内/草稿里完成结构树：`layerId -> layerName -> 段号范围 -> 子层/角色 -> 异常`。
5. 再完成格式族规约表：`ruleId -> 规则名/格式族 -> 适用角色/场景 -> 证据段 -> 格式约束 -> 异常/反例`。同一套 Normal 正文格式、同一套列表格式、同一套标题格式必须优先合并，除非关键格式约束或套用规则确实不同。
6. 写 profile.md 时按结构：文档头 → `## 文档总览` → `## 文档结构层级` → `## Layer/Role 格式规约` → `## 格式异常清单` → `## 逐段证据` → `## 样本质检（非格式规约）`。
7. 逐段证据 block 中必须标明 `归属 layer: L#`、`角色: ...` 和 `归属格式规约: R# / 存疑 / 未识别`。多个语义角色可以引用同一个 R#；这正是避免重复规则的期望结果。同格式段可以用 `[同段 N]` 简写，但不能丢失内容、layer、角色和归属规约。
8. 写完后执行“重复规则自检”：若两条规则的格式约束只有 section/内容不同，必须合并后再保存。若 `## 格式异常清单` 或 `## Layer/Role 格式规约` 里有拼写/语义/TODO/Lorem ipsum，必须移到 `## 样本质检（非格式规约）` 或删除。
9. 报告完成：给用户 profile.md 的路径 + 总览 + layer 数 + 格式族规约条数 + 格式异常条数。

## 不要做的事

- ❌ 不要只记流水账。逐段快照必须服务于上面的语义格式规约。
- ❌ 不要把段聚类成**预定义**角色清单；layer 和 role 必须从本文内容、位置、父子关系归纳出来。
- ❌ 不要先按段落顺序写角色，再事后补 layer；必须先建结构树。
- ❌ 不要把同类段只散落在逐段 block 里；同类格式族必须在 `## Layer/Role 格式规约` 合并成可复用规则。
- ❌ 不要因为 section 名称或内容语义不同，就复制一条字号/间距完全相同的规则。
- ❌ 不要评价内容写得好不好。内容只是辅助识别格式层级、角色和异常。
- ❌ 不要把拼写错误、语义问题、TODO、Lorem ipsum 放进格式异常清单。
- ❌ 不要跨 layer 强行合并规则；同样的样式在不同层里可能语义不同。
- ❌ 不要丢弃逐段证据——每段仍要保留，哪怕 200 段都是仿宋 16pt。
- ❌ 不要修改文档（这是只读 skill；用 Track 都不需要）
- ❌ 不要省略字段（"看起来不重要"的字段后续可能正是关键）
- ❌ 不要自动起名——`<name>` 永远来自用户

## 配套读物

- `word-com-cheatsheet` —— Paragraph / Range / Font / ParagraphFormat 的 COM API
- `word-runs-and-formatting` —— run 检测的逻辑（本 skill Pass 1 复用了那里的合并思路）
