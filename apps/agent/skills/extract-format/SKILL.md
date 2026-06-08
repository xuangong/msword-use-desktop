---
name: extract-format
description: 从当前 Word 文档抽取一份高保真「格式档」（profile.md），用作后续套用、对比、分类的基础。产物是逐段落的客观格式快照 + 内容驱动的批注，写入 `<dataDir>/format-profiles/<name>/profile.md`。适用于：用户拿到一份样板（公文 / 合同 / 论文 / 内部模板）希望以后能按这个文档的风格排版别的文档。
---

# 文档格式蒸馏（extract-format）

## 目标

把当前 Word 文档「这段为什么这么排」的信息**无损**保存下来。产物只描述当前文档，**不做聚类、不做重命名、不做泛化**——这些都留给后续步骤（人工梳理或另一个 skill）。

## 产物

```
<dataDir>/format-profiles/<name>/
  profile.md          ← 主产物。文档级 summary + 逐段块（数据 + 批注合并）
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
（LLM 写一段：整体观感、能看出的风格、重复结构、明显异常清单）

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

## 工作流（两遍 + 一次总览）

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

### Pass 2 — 内容驱动批注（LLM）

用 Pass 1 的数据 + 段落原文，**逐段**写批注。

每段批注三件套：
1. **角色名**（用户语言起，**不要硬塞预设清单**——是「红头」就写红头，是「带编号的小节标题」就写带编号的小节标题，是「不知道」就写"未识别"）
2. **特征**（这段被识别为这个角色的可观察依据，1 行）
3. **说明**（为什么这种内容会这么排，链接到耦合度判断）
4. **套用建议**（强/弱/存疑 + 一句话动作指引）

**判断耦合度的提问**（写批注时自问）：
- 把这段内容换成完全不同的文字，原排版还合理吗？
  - 合理 → 弱耦合（格式跟 profile 走）
  - 不合理（必须配合内容才说得通）→ 强耦合
- 这种格式在文档其他地方有没有重复出现？
  - 多次重复（≥3 次）→ 是规约，弱或强
  - 仅 1-2 次 → 可能强耦合，也可能存疑，看内容能不能解释
  - 仅 1 次且内容平庸 → 存疑

### Pass 3 — 文档级总览

读完所有段批注后，在 profile.md 头部 `## 文档总览` 写一段：
- 整体类型印象（公文 / 合同 / 论文 / 报告 / 自由排版……）
- 主导规约（"全文 80% 段落是仿宋 16pt 行距 28pt 首行缩进 2 字"）
- 重复结构（"出现 X 次的「（数字）」编号块统一格式"）
- 异常清单（所有「存疑」段的段号汇总）
- 覆盖率粗估（多少段被有把握地分类了）

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
4. 写 profile.md 时按上面定义的结构：先文档头 → 占位的 `## 文档总览`（写「待 Pass 3 填充」） → 逐段 block。每个 block 的「批注:」字段写 `(待批注)`。
5. **Pass 2**：从头到尾走一遍 block，把 `(待批注)` 替换成真批注。批注时**先看内容、再看格式**——如果只看格式数据就开始分类，会忽略内容驱动的耦合度判断。
6. **Pass 3**：所有段批注完后回头填 `## 文档总览`。
7. 报告完成：给用户 profile.md 的路径 + 总览段的内容。

## 不要做的事

- ❌ 不要把段聚类成预定义角色清单（「这段是发文字号、这段是主送机关」这种事是用户后续梳理时干的，不是抽取阶段干的）
- ❌ 不要合并同类段——每段独立保留，哪怕 200 段都是仿宋 16pt
- ❌ 不要修改文档（这是只读 skill；用 Track 都不需要）
- ❌ 不要省略字段（"看起来不重要"的字段后续可能正是关键）
- ❌ 不要自动起名——`<name>` 永远来自用户

## 配套读物

- `word-com-cheatsheet` —— Paragraph / Range / Font / ParagraphFormat 的 COM API
- `word-runs-and-formatting` —— run 检测的逻辑（本 skill Pass 1 复用了那里的合并思路）
