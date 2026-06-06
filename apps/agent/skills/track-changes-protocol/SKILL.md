---
name: track-changes-protocol
description: Mandatory rule — every Word mutation must run inside Track(() => { ... }) so the user can review/accept/reject as a tracked revision. Read this skill before writing any script that modifies the document.
---

# Track Changes protocol

The user reviews every AI edit as a Word tracked revision. They accept or reject each one. **This is the product invariant.**

## The rule

Every script submitted to `exec_csharp` that mutates the document MUST wrap its mutations in `Track(...)`:

```csharp
Track(() => {
    // any write goes here: rng.Text = ..., Doc.Comments.Add(...), Find.Execute(...), style changes, etc.
});
```

`Track` enables `Doc.TrackRevisions` for the duration of the lambda and restores the previous setting on exit. So:

- **Reads outside `Track` are fine.** `Print(Doc.Paragraphs[3].Range.Text)` does not need wrapping.
- **Writes outside `Track` silently bypass the review flow. NEVER do this.**
- **Do not manually toggle `Doc.TrackRevisions` yourself.** Use `Track`.

## What counts as a write

Anything that changes document state, including:

- `range.Text = "..."`
- `App.Selection.TypeText(...)`, `TypeParagraph()`
- `Doc.Comments.Add(...)` (yes, comments are tracked too)
- `find.Execute(Replace: ...)` with any wdReplace mode
- Paragraph format changes (`p.Style = ...`, `p.OutlineLevel = ...`)
- `range.Font.Size = ...`, color, bold, etc.
- Inserting tables, images, shapes

## Pattern: read → think → write

```csharp
// Read OUTSIDE Track (no wrapping needed)
var current = Doc.Paragraphs[5].Range.Text;
Print("current: " + current);
```

After reading, **submit a separate `exec_csharp` call** for the write, wrapped in `Track`. Don't try to read-decide-write in one giant script — multiple small scripts let you reason about state between steps and recover from individual failures.

## Comment annotation convention

AI edits should also drop an `[AI:<reason>]` comment on the changed range so the human reviewer sees *why*:

```csharp
Track(() => {
    var rng = Doc.Paragraphs[5].Range;
    rng.Text = newText;
    Doc.Comments.Add(rng, "[AI: 公文] 改写理由：...");
});
```

Author attribution is optional but nice — see `word-com-cheatsheet` for the safe `App.UserName` swap pattern.

## What about read-then-write in one script?

If you absolutely must read-then-write in the same script (e.g., to avoid race conditions with the user), the read can be inside `Track` too — `TrackRevisions=true` does not affect reads:

```csharp
Track(() => {
    var rng = Doc.Paragraphs[5].Range;
    if (rng.Text.Contains("旧词")) {
        rng.Text = rng.Text.Replace("旧词", "新词");
    }
});
```

This is the only acceptable shape. **Never** open `Track`, do a read, close `Track`, then open a fresh script that writes — Track scoping doesn't compose across `exec_csharp` calls (each script is independent).
