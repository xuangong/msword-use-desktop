---
name: translate
description: 翻译选中段落到指定语言（中⇄英 / 中⇄日 等），保持原段落格式（编号、字号、字体、颜色、粗体、下划线、斜体、缩进、对齐、样式）。当用户说"翻译"/"translate"/"译成 X 语"时使用。
---

# 翻译（保格式）

## 总体原则

翻译 = 在保留段落级属性（编号 / 缩进 / 样式 / 对齐）和字符级格式（字号 / 颜色 / 粗体 / 下划线 / 斜体）的前提下，**只换语言**。

引用的 skill：
- `word-com-cheatsheet` — 基础 API
- `word-runs-and-formatting` — 字符级格式守恒（**必读**）
- `track-changes-protocol` — 写操作必须 `Track(...)`

## Workflow

### 1. 确认目标段落 + 原文 + run 分布

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
Print($"段首格式: bold={rng.Characters[1].Font.Bold} italic={rng.Characters[1].Font.Italic} size={rng.Characters[1].Font.Size} color={rng.Characters[1].Font.Color}");

// 探测是否单一字符格式（来自 word-runs-and-formatting）
bool single = true;
var f0 = rng.Characters[1].Font;
for (int i = 2; i <= n; i++) {
    var f = rng.Characters[i].Font;
    if (f.Bold != f0.Bold || f.Italic != f0.Italic || f.Underline != f0.Underline ||
        f.Color != f0.Color || f.Size != f0.Size || f.Name != f0.Name) {
        single = false; break;
    }
}
Print($"单一字符格式: {single}");
```

### 2. 决策分支

#### 2a. 单一字符格式段落 → 模式 A（90% 的常见情况）

整段一种格式 —— 直接 `Range.Text =` 替换，字符格式自动继承段首，段落级属性自动保留。

```csharp
Track(() => {
    var rng = Doc.Paragraphs[N].Range;
    rng.Text = "Translated text here.\r";  // 必须保留 \r
    Doc.Comments.Add(rng, "[AI: 翻译] zh→en, 单格式段落直接替换");
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

    Doc.Comments.Add(paraRng, "[AI: 翻译] zh→en, 保留粗体 run");
});
return "ok";
```

实际遇到多 run 时建议把 `WriteRuns`/`RunSpec` helper（见 word-runs-and-formatting）粘进脚本，不要一行行裸写 `Doc.Range(p,p).Text =` 容易出错。

#### 2c. 不确定 → 先单格式假设 + 让用户确认

如果你判断不准段落复杂度（比如检测到 run 数=2 但只是 paragraph mark 干扰），**默认走 2a 单格式路径**，在 comment 里注明「假设单一格式直接替换；如有粗体/斜体丢失请告知」。

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
- ❌ **不要默默改格式** —— 如果探测发现要走 per-run，但你不会做对齐，**停下来问用户**
- ❌ **不要禁用 Track Changes** —— 永远用 `Track(...)`

## 示例对话节奏（理想）

> User: 翻译成英文
> 
> Agent (turn 1): observe 原文 + run 分布 → "原文 25 字，单一字符格式（黑色 11pt 宋体），可直接替换"
> 
> Agent (turn 2): `exec_csharp` 写入译文 + 加批注
> 
> Agent (turn 3 final text): "已将第 3 段译为英文。"

3 轮 done，每轮一个 exec_csharp。
