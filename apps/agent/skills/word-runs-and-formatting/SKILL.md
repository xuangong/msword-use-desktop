---
name: word-runs-and-formatting
description: 字符级格式（粗体/斜体/下划线/字号/颜色/字体）保留与精确写入的策略。任何要保持原格式的文字变更（翻译、改写、polish）都必须先读这个 skill。配合 word-com-cheatsheet 一起用。
---

# Word 字符级格式守恒（runs & formatting）

## 关键概念

Word 文档不是平铺的字符流，是**多层嵌套**：

```
Document
└─ Paragraph (段落级属性: Style, OutlineLevel, Alignment, Numbering)
   └─ Range (任意区间)
      └─ Characters (单字符序列)
      └─ Words (空格分词)
      └─ Runs (隐式概念：连续的同格式字符块)
```

**Run** 不是 Word 对象模型的一等公民 —— Word COM 没有 `Range.Runs` 这种 API。但人脑中「同一段连续相同格式的文字」就叫 run。检测和处理 run 必须自己**遍历 `Characters`**，比对相邻字符的格式属性。

## 段落级 vs 字符级属性

**段落级**（`paragraph.Range` / `paragraph.Format` 上）—— `Range.Text =` 替换文字时**自动保留**：
- `Style`（标题/正文样式）
- `OutlineLevel`
- `Alignment`、`LeftIndent`、`FirstLineIndent`、`SpaceBefore/After`、`LineSpacing`
- `ListFormat`（编号、缩进等级）

**字符级**（`Range.Font` / `Range.Bold/Italic/Underline` 等）—— `Range.Text =` 会**统一成范围起始位置的格式**，多 run 段落的内部格式**全部丢失**：
- `Font.Name`、`Font.Size`、`Font.Color`、`Font.ColorIndex`
- `Font.Bold`、`Font.Italic`、`Font.Underline`、`Font.UnderlineColor`
- `Font.StrikeThrough`、`Font.Subscript`、`Font.Superscript`
- `Font.Highlight`（背景色）
- `Font.Spacing`、`Font.Scaling`、`Font.Position`

## 决策树（写入前先做这一步）

```
Step 1: 读目标 range
Step 2: 检测 range 的 run 分布
Step 3a: 单 run（整段一种字符格式）→ 直接 Range.Text = "..."（自动继承）
Step 3b: 多 run（混合格式）→ 走"per-run rewrite"（见下）
Step 3c: 不确定/复杂 → 用 FormattedText 备份-还原模式（见下）
```

## 检测段落是否单一字符格式

```csharp
// 判断 range 内是否只有一种字符格式
bool IsSingleCharFormat(Microsoft.Office.Interop.Word.Range rng) {
    var first = rng.Characters[1].Font;
    var refSize = first.Size;
    var refBold = first.Bold;
    var refItalic = first.Italic;
    var refUnderline = first.Underline;
    var refColor = first.Color;
    var refName = first.Name;

    int n = rng.Characters.Count;
    for (int i = 2; i <= n; i++) {
        var f = rng.Characters[i].Font;
        if (f.Size != refSize) return false;
        if (f.Bold != refBold) return false;
        if (f.Italic != refItalic) return false;
        if (f.Underline != refUnderline) return false;
        if (f.Color != refColor) return false;
        if (f.Name != refName) return false;
    }
    return true;
}

Print(IsSingleCharFormat(Doc.Paragraphs[3].Range) ? "单格式" : "多格式");
```

注意：跳过 paragraph 末尾的 `\r` 字符 —— 那个总是另一种格式（paragraph mark）。可以用 `rng.End - 1` 限制：

```csharp
var rng = Doc.Paragraphs[3].Range;
var body = Doc.Range(rng.Start, rng.End - 1); // 去掉 \r
```

## 模式 A：单 run 段落（最常见）

直接 `Range.Text =`，字符格式自动继承段首：

```csharp
Track(() => {
    var rng = Doc.Paragraphs[3].Range;
    rng.Text = "改写后的内容\r";  // 整段一种格式时，颜色/字号/粗体保留
});
```

## 模式 B：FormattedText 备份还原（保险，适合简单一次性替换）

`Range.FormattedText` 是 Word COM 提供的「整个 range 含格式的拷贝」对象。可以备份 → 替换 → 把段落级属性从备份还原（字符级仍是首字符格式）：

```csharp
Track(() => {
    var rng = Doc.Paragraphs[3].Range;
    var backup = rng.FormattedText;  // 含所有格式的快照

    // 简单替换
    rng.Text = "新内容\r";
    // 此时段落级 Style/Alignment/Numbering 已自动保留
    // 字符级被压成首字符格式
});
```

**FormattedText 不能让多 run 段落"恢复原 run 边界"** —— 那是不可能的，因为新译文和原文边界对应不上。FormattedText 主要用于 **整段挪位置**（剪切一段保格式黏到另一处）。

## 模式 C：Per-run 重写（多 run 段落的正确做法）

混合格式段落要保留 run 边界 → 必须**逐 run 替换**。但翻译/改写后**新文字的 run 划分**是语义问题：

- 原段落："The **quick** brown fox" → 翻译后哪几个汉字应该粗体？
- 一种合理策略：**按 run 占比映射**（粗体词在原段占 33%，译文也大致取中间 33%）
- 另一种：**保留特殊 run（粗体/斜体/超链接）的语义对齐**，由 LLM 自己决定译文里哪几个字是该 run 的对应

实操模板（翻译时 LLM 给出**run 列表**，每个 run 是 `{text, bold, italic, underline, color, fontSize}`）：

```csharp
Track(() => {
    var paraRng = Doc.Paragraphs[3].Range;
    // 去掉末尾 \r
    var bodyEnd = paraRng.End - 1;

    // Step 1: 清空段落正文（保留 paragraph mark）
    var body = Doc.Range(paraRng.Start, bodyEnd);
    body.Text = "";

    // Step 2: 在段首逐 run 插入新内容
    var cursor = Doc.Range(paraRng.Start, paraRng.Start);

    // run 1: 普通
    cursor.Text = "敏捷的";
    var r1 = Doc.Range(paraRng.Start, paraRng.Start + 3);
    r1.Font.Bold = 0; r1.Font.Italic = 0;
    cursor = Doc.Range(r1.End, r1.End);

    // run 2: 粗体
    cursor.Text = "棕色";
    var r2 = Doc.Range(r1.End, r1.End + 2);
    r2.Font.Bold = 1;
    cursor = Doc.Range(r2.End, r2.End);

    // run 3: 普通
    cursor.Text = "狐狸";
    var r3 = Doc.Range(r2.End, r2.End + 2);
    r3.Font.Bold = 0;
});
```

更鲁棒的写法是**收集 (text, fmt) 列表后用 InsertAfter**：

```csharp
// 通用 helper（写在 exec_csharp 内即可，不需要复用）
class RunSpec {
    public string Text;
    public bool? Bold;     // null = 继承段首
    public bool? Italic;
    public Microsoft.Office.Interop.Word.WdUnderline? Underline;
    public int? Color;
    public float? FontSize;
    public string FontName;
}

void WriteRuns(Microsoft.Office.Interop.Word.Range paraRng, List<RunSpec> runs) {
    var bodyEnd = paraRng.End - 1;
    Doc.Range(paraRng.Start, bodyEnd).Text = "";
    int p = paraRng.Start;
    foreach (var r in runs) {
        var cur = Doc.Range(p, p);
        cur.Text = r.Text;
        var written = Doc.Range(p, p + r.Text.Length);
        if (r.Bold.HasValue) written.Font.Bold = r.Bold.Value ? 1 : 0;
        if (r.Italic.HasValue) written.Font.Italic = r.Italic.Value ? 1 : 0;
        if (r.Underline.HasValue) written.Font.Underline = r.Underline.Value;
        if (r.Color.HasValue) written.Font.Color = (Microsoft.Office.Interop.Word.WdColor)r.Color.Value;
        if (r.FontSize.HasValue) written.Font.Size = r.FontSize.Value;
        if (r.FontName != null) written.Font.Name = r.FontName;
        p += r.Text.Length;
    }
}
```

## 探测 run 边界（写之前先 observe）

简单粗暴的"扫描连续同格式"算法：

```csharp
class RunInfo {
    public int Start; public int End;
    public string Text;
    public bool Bold; public bool Italic;
    public int Color; public float Size; public string Name;
}

List<RunInfo> ScanRuns(Microsoft.Office.Interop.Word.Range rng) {
    var runs = new List<RunInfo>();
    int n = rng.Characters.Count;
    if (n == 0) return runs;

    var first = rng.Characters[1];
    var cur = new RunInfo {
        Start = first.Start,
        End = first.End,
        Text = first.Text ?? "",
        Bold = (first.Font.Bold != 0),
        Italic = (first.Font.Italic != 0),
        Color = (int)first.Font.Color,
        Size = first.Font.Size,
        Name = first.Font.Name,
    };

    for (int i = 2; i <= n; i++) {
        var ch = rng.Characters[i];
        bool sameFmt =
            (ch.Font.Bold != 0) == cur.Bold &&
            (ch.Font.Italic != 0) == cur.Italic &&
            (int)ch.Font.Color == cur.Color &&
            ch.Font.Size == cur.Size &&
            ch.Font.Name == cur.Name;
        if (sameFmt) {
            cur.End = ch.End;
            cur.Text += (ch.Text ?? "");
        } else {
            runs.Add(cur);
            cur = new RunInfo {
                Start = ch.Start, End = ch.End,
                Text = ch.Text ?? "",
                Bold = (ch.Font.Bold != 0),
                Italic = (ch.Font.Italic != 0),
                Color = (int)ch.Font.Color,
                Size = ch.Font.Size,
                Name = ch.Font.Name,
            };
        }
    }
    runs.Add(cur);
    return runs;
}

// 用法：先扫描，把 run 信息 Print 出来给自己看，然后下一轮 exec_csharp 决定怎么写
var runs = ScanRuns(Doc.Paragraphs[3].Range);
foreach (var r in runs) {
    Print($"[{r.Start}-{r.End}] '{r.Text.Replace("\r", "\\r")}' bold={r.Bold} italic={r.Italic} color={r.Color} size={r.Size}");
}
```

**注意**：`Characters[i]` 在大段落里非常慢（O(n) per access）。对超过几百字符的段落优先用 `Words` 或先 `rng.Copy()` 到剪贴板再 paste 的策略，或干脆走模式 B。

## 段落级属性 ≠ 字符级 —— 不要混淆

| 想做的事 | 在哪里改 |
|---|---|
| 段落整体加粗 | `paragraph.Range.Font.Bold = 1` ✓（字符级，但作用于整 range）|
| 改样式（"标题 1"） | `paragraph.Style = Doc.Styles["Heading 1"]` ✓（段落级）|
| 改对齐（居中） | `paragraph.Alignment = WdParagraphAlignment.wdAlignParagraphCenter` |
| 改编号格式 | 见 numbering 专题（未来 skill）|
| 段前段后空行 | `paragraph.Format.SpaceBefore` / `SpaceAfter` |

## 常见陷阱

- **`Font.Bold` 是 int**：`0` = 关、`-1` 或 `1` = 开、`9999999` = "混合"（mixed run 时 Word 返回这个魔数）
- **`Font.Underline` 是 WdUnderline 枚举**，不是 bool
- **`Range.Characters[i]` 1-based**
- **修改 `\r` 的格式无效**：paragraph mark 字符不能加粗
- **`Doc.Range(s, s)` 是空 range**，可以当 cursor 用，`.Text = ".."` 会在该位置插入
- **TrackRevisions 下的 run 替换**：每个 `cur.Text = ""` 都会产生一条 deletion 修订，逐 run 写入会产生一串 insertion 修订 —— 用户审阅时看到的是「整段被删 + 整段新插入」，不是逐字符 diff，正常现象

## 任务模板

**保格式翻译**（多 run 中文 → 英文）：

1. observe：用 `ScanRuns` 列出原段落 run 分布
2. 检查 run 数：若只 1 个 → 走模式 A（直接 Range.Text =）
3. 若多 run → 在你（LLM）头脑里做语义对齐：原文哪些词粗体/斜体 → 译文中哪几个对应词应该相应格式
4. 构造 `List<RunSpec>` → 调 `WriteRuns`
5. 加 `[AI: 翻译保格式]` 批注

**保格式 polish**（中文改写）：

- 单 run 段落 90% 直接走模式 A（这也是 polish-* skill 当前的默认假设）
- 引用、强调、超链接等特殊 run 极少见 —— 出现时同翻译，per-run 处理

## 引用

- 基础 API：`word-com-cheatsheet`
- Track Changes 协议：`track-changes-protocol`
- 翻译任务 workflow：`translate`
