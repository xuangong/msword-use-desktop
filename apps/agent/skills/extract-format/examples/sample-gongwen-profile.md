# Format Profile: 国务院通知样本

源文档: 国务院关于推进政务服务标准化的通知（合成样本）.docx
抽取时间: 2026-06-08T10:00:00+08:00
段落总数: 13
页面: A4 / 上 3.7cm 下 3.5cm 左 2.8cm 右 2.6cm
默认正文: 仿宋_GB2312 16pt 行距 fixed-28pt
被使用的样式: 正文, 标题 1, 标题 2, 红头, 落款
编号定义:
  - listTemplate#1（中文一级）: "一、", "二、", "三、" ...

## 文档总览

这是一份**典型的国务院通知体公文**（红头 → 发文字号 → 红线 → 标题 → 主送机关 → 正文 → 落款 → 成文日期 → 抄送）。整体格式由两套规约支配：

- **公文规约（强耦合）**：红头红色居中、发文字号格式、主送机关顶格冒号收尾、落款右对齐——这些不是该文档的私有选择，是公文必须这么排。
- **该文档的弱耦合规约**：正文统一仿宋_GB2312 16pt + 行距固定 28pt + 首行缩进 2 字符。占全文段落 60% 左右，是「这份文档的正文规约」。

**重复结构**：3 处 "一、""二、""三、" 编号块共享同一组段落格式（对应 listTemplate#1）。

**异常清单**：
- 段 8：编号正文里出现一处「政务一体化」加粗强调——单点出现，不是文档级规约。
- 段 10：比正文小 1pt（15pt vs 16pt），未见语义原因，存疑。

**覆盖率**：13 段全部分类，11 段判断有把握，2 段标存疑（段 8 的局部加粗 / 段 10 的字号异常）。

---

## 段 1
内容: 国务院

格式:
  styleName: 红头
  pf:
    alignment: Center
    firstLineIndent: 0pt
    lineSpacing: Single
    spaceBefore: 0pt
    spaceAfter: 6pt
    outlineLevel: BodyText
    listLevel: null
  runs:
    - "国务院"  方正小标宋简体 36pt 粗细=normal 颜色=#FF0000

批注: [发文机关红头·强耦合]
  特征: 红色 / 居中 / 方正小标宋简体 36pt
  说明: 公文头部固定模式，红色是规约要求，字号大于其他段是为了视觉醒目。不是该文档的私有选择。
  套用建议: 任何公文同位置应保留红色 + 方正小标宋 + 居中三件套。字号可按文件等级浮动（红头机关名通常 36pt 或 22pt）。

---

## 段 2
内容: 国发〔2024〕5 号

格式:
  styleName: 正文
  pf:
    alignment: Center
    firstLineIndent: 0pt
    lineSpacing: fixed-28pt
    spaceBefore: 12pt
    spaceAfter: 18pt
    outlineLevel: BodyText
  runs:
    - "国发〔2024〕5 号"  仿宋_GB2312 16pt

批注: [发文字号·强耦合]
  特征: 居中 / 与红头有较大段后距 / 仿宋 16pt
  说明: 公文规约要求发文字号居中，置于红头下方、红线上方。中括号写法 〔〕 也是规约（不是普通 []）。
  套用建议: 强耦合参数：居中、〔〕中括号；弱耦合参数：字体字号跟随 profile 全局。

---

## 段 3
内容: （空段，下边框 1.5pt 红色）

格式:
  styleName: 正文
  pf:
    alignment: Left
    firstLineIndent: 0pt
    lineSpacing: Single
    spaceBefore: 0pt
    spaceAfter: 24pt
    outlineLevel: BodyText
    border-bottom: 1.5pt solid #FF0000
  runs:
    - ""  仿宋_GB2312 16pt

批注: [红线分隔·强耦合]
  特征: 空段 + 下边框红色实线 1.5pt + 较大段后距
  说明: 公文用空段 + 段落下边框模拟红线，是 Word 排版常见 trick。这条线在视觉上分隔头部（红头/字号）和正文。
  套用建议: 必须保留——红线缺失不是合法公文。注意：边框是 *段落属性*，不是字符属性，一些复制粘贴会丢边框。

---

## 段 4
内容: 国务院关于推进政务服务标准化的通知

格式:
  styleName: 标题 1
  pf:
    alignment: Center
    firstLineIndent: 0pt
    lineSpacing: Single
    spaceBefore: 18pt
    spaceAfter: 18pt
    outlineLevel: 1
  runs:
    - "国务院关于推进政务服务标准化的通知"  方正小标宋简体 22pt

批注: [文件标题·强耦合]
  特征: 居中 / 方正小标宋简体 22pt / OutlineLevel=1
  说明: 公文标题统一使用方正小标宋简体（这是 GB/T 9704 公文格式国标的硬性要求）。OutlineLevel=1 让导航窗格能识别。
  套用建议: 字体不可替换（必须方正小标宋系），字号可在 22-26pt 浮动看标题字数。

---

## 段 5
内容: 各省、自治区、直辖市人民政府，国务院各部委、各直属机构：

格式:
  styleName: 正文
  pf:
    alignment: Justify
    firstLineIndent: 0pt
    lineSpacing: fixed-28pt
    spaceBefore: 0pt
    spaceAfter: 0pt
  runs:
    - "各省、自治区、直辖市人民政府，国务院各部委、各直属机构："  仿宋_GB2312 16pt

批注: [主送机关·强耦合]
  特征: 顶格（无首行缩进）/ 冒号收尾 / 仿宋 16pt
  说明: 公文规约要求主送机关顶格、冒号结尾。**不缩进**是规约（与正文的首行缩进 2 字形成对比，提示读者这是收件方而非正文）。
  套用建议: 强耦合参数：顶格、冒号收尾。弱耦合参数：字体字号跟随 profile 全局。

---

## 段 6
内容: 为深入贯彻落实党中央、国务院关于深化"放管服"改革的决策部署，全面推进政务服务标准化建设，现就有关事项通知如下：

格式:
  styleName: 正文
  pf:
    alignment: Justify
    firstLineIndent: 32pt （= 2 字符 @ 16pt）
    lineSpacing: fixed-28pt
    spaceBefore: 0pt
    spaceAfter: 0pt
  runs:
    - "为深入贯彻落实党中央、国务院关于深化"  仿宋_GB2312 16pt
    - "放管服"  仿宋_GB2312 16pt
    - "改革的决策部署，全面推进政务服务标准化建设，现就有关事项通知如下："  仿宋_GB2312 16pt

批注: [引导段（正文）·弱耦合]
  特征: 首行缩进 2 字符 / 仿宋 16pt 行距 28pt / "通知如下："收尾
  说明: 标准正文段格式，是该文档的弱耦合规约——所有正文段都该长这样。"通知如下："是引导段的语义标志，但格式上和后续正文段一致。
  套用建议: 跟随 profile 的"正文规约"全局参数（仿宋 / 16pt / 28pt 行距 / 首行 2 字缩进）。

---

## 段 7
内容: 一、明确标准化建设总体要求

格式:
  styleName: 标题 2
  pf:
    alignment: Justify
    firstLineIndent: 32pt
    lineSpacing: fixed-28pt
    spaceBefore: 12pt
    spaceAfter: 0pt
    outlineLevel: 2
    listLevel: 1
    listTemplate: 中文一级（"一、""二、""三、"）
  runs:
    - "一、"  黑体 16pt
    - "明确标准化建设总体要求"  黑体 16pt

批注: [一级条目标题·强耦合]
  特征: 黑体 16pt / "一、""二、" 中文编号 / OutlineLevel=2
  说明: 公文一级条目规约：黑体（与正文仿宋形成对比）、中文数字编号、与正文同字号（不像合同那样放大）。编号 + 标题用同一字号同一字体一气呵成。
  套用建议: 强耦合参数：中文数字编号、黑体；弱耦合参数：字号跟随 profile 全局正文字号。

---

## 段 8
内容: 二、推进政务一体化平台建设

格式:
  styleName: 标题 2
  pf:
    alignment: Justify
    firstLineIndent: 32pt
    lineSpacing: fixed-28pt
    spaceBefore: 12pt
    spaceAfter: 0pt
    outlineLevel: 2
    listLevel: 1
    listTemplate: 中文一级
  runs:
    - "二、推进"  黑体 16pt 粗细=normal
    - "政务一体化"  黑体 16pt 粗细=BOLD
    - "平台建设"  黑体 16pt 粗细=normal

批注: [一级条目标题·强耦合 + 局部存疑]
  特征: 与段 7 同结构，但中段 "政务一体化" 加粗，形成多 run
  说明: 段落格式部分跟段 7 完全一致，是同一规约。但内部 "政务一体化" 加粗——单点出现，未在段 7、9 重复，不是文档级规约。可能是作者强调这个新概念，也可能是粘贴遗留。
  套用建议: 段落格式按段 7 处理（强耦合一级条目）；内部加粗**不要**泛化到其他文档，但保留为该段的固有特征。

---

## 段 9
内容: 三、加强标准实施监督

格式:
  styleName: 标题 2
  pf:
    alignment: Justify
    firstLineIndent: 32pt
    lineSpacing: fixed-28pt
    spaceBefore: 12pt
    spaceAfter: 0pt
    outlineLevel: 2
    listLevel: 1
    listTemplate: 中文一级
  runs:
    - "三、加强标准实施监督"  黑体 16pt

批注: [一级条目标题·强耦合]
  特征: 与段 7 完全一致
  说明: 与段 7 共同确认了一级条目的规约（重复 ≥3 次 → 是规约不是偶发）。
  套用建议: 同段 7。

---

## 段 10
内容: 各地区、各部门要按照本通知要求，结合本地实际，制定具体实施方案，确保各项任务落到实处。

格式:
  styleName: 正文
  pf:
    alignment: Justify
    firstLineIndent: 30pt （= 2 字符 @ 15pt）
    lineSpacing: fixed-28pt
    spaceBefore: 0pt
    spaceAfter: 0pt
  runs:
    - "各地区、各部门要按照本通知要求…落到实处。"  仿宋_GB2312 15pt ⚠

批注: [收尾正文段·弱耦合 + 字号存疑]
  特征: 内容是收尾段，但字号 15pt（比正文 16pt 小 1pt）
  说明: 角色是普通正文段无疑（语义、对齐、缩进与段 6 一致）。但字号 15pt 与全文正文 16pt 不一致，又找不到内容驱动的理由（不是脚注、不是引文、不是小字提示），疑似手误 override 或粘贴遗留。
  套用建议: 字号 15pt **不要**泛化——按 profile 的弱耦合规约，正文应是 16pt。提示用户复核此段。

---

## 段 11
内容: 国务院

格式:
  styleName: 落款
  pf:
    alignment: Right
    firstLineIndent: 0pt
    lineSpacing: fixed-28pt
    spaceBefore: 24pt
    spaceAfter: 0pt
  runs:
    - "国务院"  仿宋_GB2312 16pt

批注: [落款单位·强耦合]
  特征: 右对齐 / 顶部段距 24pt（与正文拉开）/ 仿宋 16pt
  说明: 公文规约：落款单位右对齐、置于成文日期上方一行。顶部段距是为了视觉上和正文分开。
  套用建议: 强耦合参数：右对齐、与正文拉开段距；弱耦合参数：字体字号跟随 profile。

---

## 段 12
内容: 2024 年 3 月 15 日

格式:
  styleName: 落款
  pf:
    alignment: Right
    firstLineIndent: 0pt
    lineSpacing: fixed-28pt
    spaceBefore: 0pt
    spaceAfter: 24pt
  runs:
    - "2024 年 3 月 15 日"  仿宋_GB2312 16pt

批注: [成文日期·强耦合]
  特征: 右对齐 / 紧接落款单位 / 中文格式日期 "X 年 X 月 X 日"
  说明: 公文规约：成文日期右对齐、紧贴落款单位下方。**必须**使用中文 "年月日"（不能 "2024-03-15" 或 "2024.3.15"），且数字与汉字间留空格的标点排印是约定俗成。
  套用建议: 强耦合参数：右对齐、中文 "年月日"、与落款单位贴近。

---

## 段 13
内容: 抄送：各省、自治区、直辖市党委办公厅，最高人民法院，最高人民检察院。

格式:
  styleName: 正文
  pf:
    alignment: Justify
    firstLineIndent: 0pt
    lineSpacing: fixed-22pt
    spaceBefore: 18pt
    spaceAfter: 0pt
    border-top: 0.5pt solid #000000
    border-bottom: 0.5pt solid #000000
  runs:
    - "抄送：各省、自治区、直辖市党委办公厅，最高人民法院，最高人民检察院。"  仿宋_GB2312 14pt

批注: [抄送·强耦合]
  特征: 顶格 / 上下边框 / 字号小于正文（14pt vs 16pt）/ 行距收紧（22pt vs 28pt）
  说明: 公文版记部分。上下边框是版记区的视觉规约（与正文区分隔），小字号是因为版记内容信息密度高、不属于正文阅读路径。
  套用建议: 强耦合参数：上下边框、字号 14pt（小于正文）、行距 22pt（紧）、"抄送：" 前缀；弱耦合参数：字体跟随 profile。
