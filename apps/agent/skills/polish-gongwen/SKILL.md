---
name: polish-gongwen
description: Polish a Word paragraph (or selection) into Chinese 公文 (官方公文) style. Use when the user says "公文风格" / "改成公文" / "polish gongwen".
---

# Polish to 公文 (官方公文风格)

公文 is Chinese institutional/government document style. Hallmarks:

- 平实庄重，无口语 ("我们" → "本单位/本部门"，去掉 "其实/感觉/可能")
- 多用四字结构与稳定搭配 ("高度重视、扎实推进、确保落实")
- 句子主谓清晰，避免长定语堆叠
- 数字、时间、法规表述精确，引用要带条款号
- 段首使用规范用语 ("现将...通知如下:"、"为深入贯彻..."、"经研究决定")
- 称谓正式 ("各位领导" → "各级领导干部")

## Workflow

1. **Identify target.** The user invoked from the spotlight; the preamble in this turn already tells you which paragraph (`paragraphIndex`). If unsure, use `exec_csharp` to call `Print(App.Selection.Text)` to confirm.

2. **Read the full paragraph text** if not already shown to you:
   ```csharp
   Print(Doc.Paragraphs[6].Range.Text);
   ```

3. **Decide the rewrite** in your reasoning. Keep factual content; only change register/phrasing. Preserve numbers, names, dates, citations exactly. Headings (`OutlineLevel < 10`) follow a different pattern — see below.

4. **Apply with Track + AI comment**, one `exec_csharp` call:
   ```csharp
   Track(() => {
       var rng = Doc.Paragraphs[6].Range;
       rng.Text = "本单位高度重视...（改写后正文）...\r";
       var prev = App.UserName;
       try {
           App.UserName = "msword-use AI";
           Doc.Comments.Add(rng, "[AI: 公文] 调整为公文体，强化正式表述");
       } finally { App.UserName = prev; }
   });
   return "ok";
   ```

5. **Confirm to the user** in 1-2 Chinese sentences. Do NOT paste the full new text — they'll see it as a tracked revision in Word.

## Headings (`OutlineLevel < 10`)

- Use 4-8 字 nominal phrasing: "关于...的通知", "关于...的实施意见", "工作总结报告"
- No trailing punctuation
- Don't change heading level unless asked

## Quoted text

引号内容 verbatim — never paraphrase quotations even if they sound colloquial.

## Skip conditions

If the original is already 公文 style (starts with "现将", "经研究决定", etc.), reply that it's already in style and skip the rewrite. Don't make cosmetic changes for their own sake.

## Anti-patterns

- ❌ Disabling Track Changes "to make the diff cleaner" — never (see `track-changes-protocol`)
- ❌ Replacing the entire document in one script — one paragraph at a time
- ❌ Inventing facts to make prose flow better — 公文 prizes accuracy over fluency
- ❌ Auto-correcting Chinese punctuation (用「」改成"" etc.) unless the user asked
