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

**⚠️ 字符级格式守恒**：`rng.Text = "..."` 会把多 run 段落（含粗体 / 斜体 / 不同颜色 / 不同字号）压成单一格式 —— 内部格式信息全部丢失。任何要保格式的文字变更（翻译 / 改写 / polish 多 run 段落）必须先读 `word-runs-and-formatting` skill。

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
