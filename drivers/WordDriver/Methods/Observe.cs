using System.Collections.Generic;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver.Methods
{
    static class Observe
    {
        public static object Selection()
        {
            var app = WordSession.App();
            var sel = Perf.Measure("Application.Selection.get", () => app.Selection, 0);
            int? paraIdx = null;
            int paraCount = Perf.Measure("Selection.Paragraphs.Count", () => sel.Paragraphs.Count, 0);
            if (paraCount > 0)
            {
                // 1-based index of selection's first paragraph. Derived from Range.Start
                // because Word doesn't expose Paragraph.Index directly.
                var doc = Perf.Measure("Application.ActiveDocument.get", () => app.ActiveDocument, 0);
                int targetStart = Perf.Measure("Selection.Paragraphs[1].Range.Start", () => sel.Paragraphs[1].Range.Start, 0);
                int i = 1;
                Perf.Measure("Document.Paragraphs.iter", () =>
                {
                    foreach (Word.Paragraph p in doc.Paragraphs)
                    {
                        if (p.Range.Start == targetStart) { paraIdx = i; break; }
                        i++;
                    }
                }, 0);
            }

            int? page = null;
            try { page = Perf.Measure("Selection.Information(activeEndPage)", () => (int)(object)sel.Information[Word.WdInformation.wdActiveEndPageNumber], 0); }
            catch { /* selection may be invalid; ignore */ }

            string text = Perf.Measure("Selection.Text.get", () => sel.Text ?? "", 0);
            int start = Perf.Measure("Selection.Start.get", () => sel.Start, 0);
            int end = Perf.Measure("Selection.End.get", () => sel.End, 0);
            return new
            {
                text = text,
                start = start,
                end = end,
                isEmpty = start == end,
                paragraphIndex = paraIdx,
                page = page
            };
        }

        public static object Outline(int maxLevel)
        {
            const int maxNodes = 200;
            var doc = WordSession.ActiveDoc();
            var outline = new List<object>();
            bool truncated = false;
            int total = 0;
            Perf.Measure("Document.Paragraphs.iter", () =>
            {
                foreach (Word.Paragraph p in doc.Paragraphs)
                {
                    int lvl = (int)p.OutlineLevel;
                    if (lvl >= 10 || lvl > maxLevel) continue;
                    if (outline.Count >= maxNodes) { truncated = true; break; }
                    var text = (p.Range.Text ?? "").Trim('\r', '\n', '\x07', ' ', '\t');
                    outline.Add(new { level = lvl, text = text, start = p.Range.Start });
                }
            }, 0);
            total = Perf.Measure("Document.Paragraphs.Count", () => doc.Paragraphs.Count, 0);
            return new { total = total, outline = outline, truncated = truncated };
        }

        /// <summary>
        /// Read a single paragraph by 1-based index. Returns its text +
        /// position so the agent can polish it without an active selection.
        /// </summary>
        public static object Paragraph(int index)
        {
            var doc = WordSession.ActiveDoc();
            int count = Perf.Measure("Document.Paragraphs.Count", () => doc.Paragraphs.Count, 0);
            if (index < 1 || index > count)
                throw new System.Exception("paragraph index out of range: " + index);
            var p = Perf.Measure("Paragraphs[]", () => doc.Paragraphs[index], 0);
            int lvl = Perf.Measure("Paragraph.OutlineLevel.get", () => (int)p.OutlineLevel, 0);
            var text = Perf.Measure("Paragraph.Range.Text.get", () => p.Range.Text ?? "", 0);
            string styleName = null;
            try
            {
                var styleObj = Perf.Measure("Range.Style.get", () => p.Range.get_Style() as Word.Style, 0);
                if (styleObj != null) styleName = Perf.Measure("Style.NameLocal.get", () => styleObj.NameLocal, 0);
            }
            catch { /* style read may fail in some doc states; skip */ }
            int start = Perf.Measure("Paragraph.Range.Start.get", () => p.Range.Start, 0);
            int end = Perf.Measure("Paragraph.Range.End.get", () => p.Range.End, 0);
            return new
            {
                index = index,
                text = text,
                trimmedText = text.Trim('\r', '\n', '\x07', ' ', '\t'),
                start = start,
                end = end,
                outlineLevel = lvl,
                isHeading = lvl < 10,
                styleName = styleName,
            };
        }
    }
}
