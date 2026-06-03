using System.Collections.Generic;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver.Methods
{
    static class Observe
    {
        public static object Selection()
        {
            var app = WordSession.App();
            var sel = app.Selection;
            int? paraIdx = null;
            if (sel.Paragraphs.Count > 0)
            {
                // 1-based index of selection's first paragraph. Derived from Range.Start
                // because Word doesn't expose Paragraph.Index directly.
                var doc = app.ActiveDocument;
                int targetStart = sel.Paragraphs[1].Range.Start;
                int i = 1;
                foreach (Word.Paragraph p in doc.Paragraphs)
                {
                    if (p.Range.Start == targetStart) { paraIdx = i; break; }
                    i++;
                }
            }

            int? page = null;
            try { page = (int)(object)sel.Information[Word.WdInformation.wdActiveEndPageNumber]; }
            catch { /* selection may be invalid; ignore */ }

            return new
            {
                text = sel.Text ?? "",
                start = sel.Start,
                end = sel.End,
                isEmpty = sel.Start == sel.End,
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
            foreach (Word.Paragraph p in doc.Paragraphs)
            {
                int lvl = (int)p.OutlineLevel;
                if (lvl >= 10 || lvl > maxLevel) continue;
                if (outline.Count >= maxNodes) { truncated = true; break; }
                var text = (p.Range.Text ?? "").Trim('\r', '\n', '\x07', ' ', '\t');
                outline.Add(new { level = lvl, text = text, start = p.Range.Start });
            }
            return new { total = doc.Paragraphs.Count, outline = outline, truncated = truncated };
        }
    }
}
