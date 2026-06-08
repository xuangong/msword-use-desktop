---
name: translate
description: 翻译选中段落、指定范围或整篇文档到指定语言（中⇄英 / 中⇄日 等），保持原格式（编号、字号、字体、颜色、粗体、下划线、斜体、缩进、对齐、样式）。当用户说"翻译"/"translate"/"译成 X 语"/"全文翻译"/"整篇翻译"时使用。
---

# 翻译（保格式）

## 总体原则

翻译 = 在原文档原位置做对应修改：在保留段落级属性（编号 / 缩进 / 样式 / 对齐）和字符级格式（字号 / 颜色 / 粗体 / 下划线 / 斜体）的前提下，**只把原文字替换为目标语言**。

产品语义：
- **原地修改**：译文必须写回原段落 / 原 range，替换对应原文。
- **段落对应**：原文第 N 段翻译后仍是第 N 段；不要把多段合并成一段，也不要把一段拆成多段，除非用户明确要求。
- **结构对应**：标题仍是标题，列表项仍是列表项，表格单元格仍在原单元格，脚注/批注/引用编号不乱移动。
- **不要另起译文**：不要在文档开头、结尾或光标处额外插入一份完整译文；不要保留原文再追加译文，除非用户明确要求"双语对照"。
- **不要重排文档**：不要重新组织章节、移动段落、改大纲层级。翻译只改变目标 range 内的文字内容。

用户可能要求：
- **单段 / 当前选区**：例如"把这段翻译成中文"、"翻译当前段落"。
- **指定范围**：例如"翻译第 3-8 段"、"翻译选中的几段"。
- **整篇 / 全文 / 整份文档**：例如"翻译整篇文章"、"全文译成中文"、"把这份文档翻译成英文"。

三种场景都必须遵守同一条底线：**翻译完整目标范围，并保持原格式**。不能因为是全文任务就只翻译前几段；也不能因为是单段任务就省略格式检测。

引用的 skill：
- `word-com-cheatsheet` — 基础 API
- `word-runs-and-formatting` — 字符级格式守恒（**必读**）
- `track-changes-protocol` — 写操作必须 `Track(...)`

## Workflow

### 0. 先确认目标范围（必须）

先根据用户措辞确定范围：

| 用户措辞 | 目标范围 |
|---|---|
| "这段" / "当前段落" / 光标所在段落 | preamble 的 paragraphIndex 或 App.Selection.Paragraphs |
| "选中内容" / "选中的几段" | App.Selection.Range 覆盖的所有段落 |
| "第 N 段" / "第 N-M 段" | Doc.Paragraphs[N..M] |
| "整篇" / "全文" / "整份文档" / "整篇文章" | Doc.Paragraphs[1..Doc.Paragraphs.Count] 中所有非空正文/标题段落 |

如果用户明确说"整篇/全文/整份文档"，**不要只处理当前选区或光标段落**。当前选区只作为上下文，不是范围限制。

确定范围后，所有写入都必须是**范围内原段落正文的对应替换**。例如全文翻译时，按段落编号逐段替换 `Doc.Range(Doc.Paragraphs[i].Range.Start, Doc.Paragraphs[i].Range.End - 1)`；不要创建新的译文段落集合。

Track Changes 下的硬规则：
- **只替换正文 range，不替换 paragraph mark**：用 `body = Doc.Range(para.Range.Start, para.Range.End - 1)`，然后 `body.Text = translated`。
- **不要用 `para.Range.Text = translated + "\r"`**。这会把段落标记也放进修订，Word 可能把译文/批注显示到修订气泡区域，原文留在下面，段落对应关系变得不可读。
- **替换后不要用旧坐标 `start + translated.Length` 猜测新文字位置**。TrackRevisions 下旧坐标可能指向删除修订或别的显示层。直接对刚写入的 `body` range 恢复格式。
- **翻译默认不加批注**。不要为每段 `Doc.Comments.Add(...)`；用户要看的是 Word 的 tracked revision。只有用户明确要批注时才加。

全文任务必须先扫描并打印计划：

```csharp
var total = Doc.Paragraphs.Count;
int nonEmpty = 0;
for (int i = 1; i <= total; i++) {
    var t = Doc.Paragraphs[i].Range.Text.TrimEnd('\r', '\a');
    if (!string.IsNullOrWhiteSpace(t)) {
        nonEmpty++;
        Print($"[{i}] {t.Substring(0, Math.Min(60, t.Length)).Replace("\r", "\\r")}");
    }
}
Print($"计划翻译非空段落: {nonEmpty}/{total}");
```

### 1. 确认每个目标段落的原文 + run 分布

```csharp
// 显示段落原文 + run 详情
var rng = Doc.Paragraphs[N].Range;  // N 来自 preamble 的 paragraphIndex

// 列段落级属性供参考
Print($"Style: {(rng.get_Style() as Microsoft.Office.Interop.Word.Style)?.NameLocal}");
Print($"Alignment: {Doc.Paragraphs[N].Alignment}");
Print($"OutlineLevel: {Doc.Paragraphs[N].OutlineLevel}");

// 列 run 分布（用 word-runs-and-formatting 的 ScanRuns，这里简化版）
var n = rng.Characters.Count - 1; // skip trailing \r
Print($"原文 ({n} 字): '{rng.Text.TrimEnd('\r')}'");
Print($"段首格式: ascii={rng.Characters[1].Font.NameAscii} farEast={rng.Characters[1].Font.NameFarEast} size={rng.Characters[1].Font.Size} sizeBi={rng.Characters[1].Font.SizeBi} bold={rng.Characters[1].Font.Bold} italic={rng.Characters[1].Font.Italic} color={rng.Characters[1].Font.Color}");

// 探测是否单一字符格式（来自 word-runs-and-formatting）
bool single = true;
var f0 = rng.Characters[1].Font;
for (int i = 2; i <= n; i++) {
    var f = rng.Characters[i].Font;
    if (f.Bold != f0.Bold || f.Italic != f0.Italic || f.Underline != f0.Underline ||
        f.Color != f0.Color || f.Size != f0.Size || f.SizeBi != f0.SizeBi ||
        f.NameAscii != f0.NameAscii || f.NameFarEast != f0.NameFarEast || f.NameOther != f0.NameOther) {
        single = false; break;
    }
}
Print($"单一字符格式: {single}");
```

全文/多段任务要对**每个非空目标段落**做这个判断。不要只检查第一段就假设后续段落格式相同。

### 2. 决策分支（每段独立判断）

#### 2a. 单一字符格式段落 → 模式 A（90% 的常见情况）

整段一种格式 —— 可以替换整段文本，但必须先保存并恢复完整字体槽，尤其是 `NameFarEast` / `NameAscii` / `NameOther` 和 `Size` / `SizeBi`。只保存 `Font.Name` / `Font.Size` 不够，插入中文时 Word 可能走默认 East Asian 字体，导致字号/字体观感改变。

```csharp
Track(() => {
    var paraRng = Doc.Paragraphs[N].Range;
    string translated = "Translated text here.";

    // Replace only paragraph body. Keep the paragraph mark outside the edit so
    // the original paragraph/list/style anchor remains in place.
    var body = Doc.Range(paraRng.Start, paraRng.End - 1);
    var f = body.Characters.Count > 0 ? body.Characters[1].Font : paraRng.Font;

    // Capture all relevant font slots before replacing text.
    var name = f.Name;
    var nameAscii = f.NameAscii;
    var nameFarEast = f.NameFarEast;
    var nameOther = f.NameOther;
    var nameBi = f.NameBi;
    var size = f.Size;
    var sizeBi = f.SizeBi;
    var bold = f.Bold;
    var boldBi = f.BoldBi;
    var italic = f.Italic;
    var italicBi = f.ItalicBi;
    var underline = f.Underline;
    var color = f.Color;
    var colorIndex = f.ColorIndex;
    var highlight = f.HighlightColorIndex;
    var strike = f.StrikeThrough;
    var sub = f.Subscript;
    var sup = f.Superscript;

    body.Text = translated;

    // Apply formatting to the same body range. Do not recalculate with
    // start + translated.Length under TrackRevisions.
    body.Font.Name = name;
    body.Font.NameAscii = nameAscii;
    body.Font.NameFarEast = nameFarEast;
    body.Font.NameOther = nameOther;
    body.Font.NameBi = nameBi;
    body.Font.Size = size;
    body.Font.SizeBi = sizeBi;
    body.Font.Bold = bold;
    body.Font.BoldBi = boldBi;
    body.Font.Italic = italic;
    body.Font.ItalicBi = italicBi;
    body.Font.Underline = underline;
    body.Font.Color = color;
    body.Font.ColorIndex = colorIndex;
    body.Font.HighlightColorIndex = highlight;
    body.Font.StrikeThrough = strike;
    body.Font.Subscript = sub;
    body.Font.Superscript = sup;
});
return "ok";
```

#### 2b. 多 run 混合格式段落 → 模式 C（per-run 重写）

原文有粗体/斜体/超链接/特殊颜色等。不能直接 `Text =`（会丢格式），必须：

1. 先 `ScanRuns` 列出原 runs（参考 word-runs-and-formatting 的 ScanRuns 函数）
2. 在你头脑里做**语义对齐**：原文 run i 的语义对应译文哪几个字 → 那几个字带 run i 的格式
3. 构造 `List<RunSpec>` 列表
4. 调 `WriteRuns` 写入

**示例**：原文 "The **quick** brown fox jumps" → 译成 "敏捷的**棕色**狐狸跳跃"

```csharp
Track(() => {
    var paraRng = Doc.Paragraphs[N].Range;

    // 清空段落正文（保留 paragraph mark）
    var bodyEnd = paraRng.End - 1;
    Doc.Range(paraRng.Start, bodyEnd).Text = "";

    int p = paraRng.Start;

    // run 1: "敏捷的" 普通
    Doc.Range(p, p).Text = "敏捷的";
    p += 3;

    // run 2: "棕色" 粗体（对应原文 "quick"）
    Doc.Range(p, p).Text = "棕色";
    var r2 = Doc.Range(p, p + 2);
    r2.Font.Bold = 1;
    p += 2;

    // run 3: "狐狸跳跃" 普通
    Doc.Range(p, p).Text = "狐狸跳跃";

    // Do not add per-paragraph comments for routine translation; tracked
    // revisions are the visible review artifact.
});
return "ok";
```

实际遇到多 run 时建议把 `WriteRuns`/`RunSpec` helper（见 word-runs-and-formatting）粘进脚本，不要一行行裸写 `Doc.Range(p,p).Text =` 容易出错。

#### 2c. 不确定或复杂 → 不要静默破坏格式

如果你判断不准段落复杂度（比如 run 很多、表格/超链接/脚注混杂、需要语义对齐但无法确定），不要静默走 2a。应停下来说明："检测到复杂格式，直接替换会改变字体/粗体/链接，是否允许按段首格式统一替换，还是逐 run 保守翻译？"

### 3. 全文/多段任务的批处理规则

全文翻译不能一次只做前几段就结束。必须：

1. 扫描目标范围，得到 `targetParagraphs`。
2. 每批处理 3-5 个非空段落，避免脚本超时和 LLM 上下文过大。
3. 每批写入必须逐段原地替换对应段落，例如第 4 段原文只写回第 4 段。
4. 每批写入后 `Print("已翻译段落: 1,2,3 / 待翻译: 4,5,...")`。
5. 如果还有未翻译段落，继续下一批，不要 final。
6. 最后一批后执行验证脚本，确认目标段落都已处理。

推荐验证输出：

```csharp
// 简化验证：打印仍可能包含源语言的段落，供下一轮继续处理
for (int i = 1; i <= Doc.Paragraphs.Count; i++) {
    var t = Doc.Paragraphs[i].Range.Text.TrimEnd('\r', '\a');
    if (string.IsNullOrWhiteSpace(t)) continue;
    // 英文->中文任务示例：仍有较多 ASCII 单词则可疑
    if (System.Text.RegularExpressions.Regex.IsMatch(t, @"[A-Za-z]{4,}")) {
        Print($"可能未译 [{i}]: {t.Substring(0, Math.Min(80, t.Length))}");
    }
}
```

全文任务 final text 必须包含完成范围，例如："已翻译全文 18/18 个非空段落。" 如果只完成部分，必须说："已完成 1-5，仍剩 6-18"，并继续或请用户确认继续。

## 用户语义提示词

| 用户说 | 目标 |
|---|---|
| "翻译成英文" / "translate to English" | zh-CN → en |
| "译成中文" / "翻译成简体" | en → zh-CN |
| "译成日语" | → ja |
| "改成英文" | 同 "翻译成英文"（不是 polish）|

如果不明确，问一句「目标语言是？」再做。

## 翻译质量原则

1. **专有名词**：人名 / 公司名 / 产品名 / 商标 → **保留原文不译**（"Microsoft Word" 不译成 "微软文字处理")
2. **数字 / 日期 / 引用编号**：原样保留（"第 3 章"译为 "Chapter 3" 但 "see [12]" 中 [12] 不动）
3. **引号内容**：用户原话或文献引用，**不译**
4. **专业术语**：根据上下文用通用译法，不创造
5. **公文/合同/法律文本**：按目标语言的对应正式语体（英文公文 → 半被动 + 名词化；日文公文 → 敬体）

## 不要做的事

- ❌ **不要在聊天里复述完整译文** —— 用户在 Word 里看 tracked revision，复述只是噪音
- ❌ **不要"顺手 polish"** —— 用户要的是翻译，不是改写。语序 / 风格保持原意
- ❌ **不要主动加注释** —— 译文里不要插入"译者注: ..."
- ❌ **不要默默改格式** —— 单段和全文都一样：如果探测发现要走 per-run，但你不会做对齐，**停下来问用户**
- ❌ **不要只翻译前几段就结束全文任务** —— 全文任务必须完成扫描出的全部非空目标段落，或明确报告剩余段落并继续
- ❌ **不要追加一份译文** —— 翻译是在原文位置替换，不是在文档里新增一份译文副本
- ❌ **不要合并/拆分段落** —— 段落与段落要一一对应，除非用户明确要求重排或双语对照
- ❌ **不要替换段落标记** —— 不要 `para.Range.Text = translated + "\r"`；只替换 `Doc.Range(para.Range.Start, para.Range.End - 1).Text`
- ❌ **不要默认加批注** —— 翻译修订用 Track Changes 表达，批注会干扰审阅视图
- ❌ **不要禁用 Track Changes** —— 永远用 `Track(...)`

## 示例对话节奏（理想）

> User: 翻译成英文
> 
> Agent (turn 1): observe 原文 + run 分布 → "原文 25 字，单一字符格式（黑色 11pt 宋体），可直接替换"
> 
> Agent (turn 2): `exec_csharp` 原位写入译文，保留 Track Changes
> 
> Agent (turn 3 final text): "已将第 3 段译为英文。"

3 轮 done，每轮一个 exec_csharp。
