using System;
using Newtonsoft.Json.Linq;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver.Methods
{
    /// <summary>
    /// Polish operations. All mutations are wrapped in TrackRevisions so the
    /// edit appears as a revision the user can review and accept/reject.
    /// </summary>
    static class Polish
    {
        public static object ReplaceRange(JObject p)
        {
            var doc = WordSession.ActiveDoc();
            var rng = ResolveRange(doc, p);
            string newText = p["newText"]?.ToString() ?? "";
            string action = p["action"]?.ToString() ?? "polish:replace";
            bool track = p["track"]?.ToObject<bool?>() ?? true;

            string original = Perf.Measure("Range.Text.get", () => rng.Text ?? "", 0);
            using (new RevisionScope(doc, track))
            {
                Perf.Measure("Range.Text.set", () => { rng.Text = newText; }, newText.Length);
            }
            int start = Perf.Measure("Range.Start.get", () => rng.Start, 0);
            int end = Perf.Measure("Range.End.get", () => rng.End, 0);
            return new
            {
                replacedChars = original.Length,
                newChars = newText.Length,
                rangeStart = start,
                rangeEnd = end
            };
        }

        public static object AddComment(JObject p)
        {
            var doc = WordSession.ActiveDoc();
            var rng = ResolveRange(doc, p);
            string text = p["text"]?.ToString() ?? "";
            string author = p["author"]?.ToString() ?? "msword-use AI";

            var app = Perf.Measure("Document.Application.get", () => doc.Application, 0);
            string prevAuthor = Perf.Measure("Application.UserName.get", () => app.UserName, 0);
            Word.Comment comment;
            try
            {
                Perf.Measure("Application.UserName.set", () => { app.UserName = author; }, 0);
                comment = Perf.Measure("Comments.Add", () => doc.Comments.Add(rng, text), text.Length);
            }
            finally
            {
                Perf.Measure("Application.UserName.set", () => { app.UserName = prevAuthor; }, 0);
            }
            string scopeText = Perf.Measure("Range.Text.get", () => rng.Text ?? "", 0);
            int commentIdx = Perf.Measure("Comment.Index.get", () => comment.Index, 0);
            return new
            {
                commentIndex = commentIdx,
                scope = scopeText.Length > 80 ? scopeText.Substring(0, 80) : scopeText
            };
        }

        static Word.Range ResolveRange(Word.Document doc, JObject p)
        {
            string bookmark = p["bookmark"]?.Type == JTokenType.Null ? null : p["bookmark"]?.ToString();
            int? start = p["start"]?.ToObject<int?>();
            int? end = p["end"]?.ToObject<int?>();
            int? paraIdx = p["paragraphIndex"]?.ToObject<int?>();

            if (!string.IsNullOrEmpty(bookmark))
            {
                bool exists = Perf.Measure("Bookmarks.Exists", () => doc.Bookmarks.Exists(bookmark), 0);
                if (!exists)
                    throw new Exception("bookmark not found: " + bookmark);
                return Perf.Measure("Bookmarks[].Range", () => doc.Bookmarks[bookmark].Range, 0);
            }
            if (paraIdx.HasValue)
                return Perf.Measure("Paragraphs[].Range", () => doc.Paragraphs[paraIdx.Value].Range, 0);
            if (start.HasValue && end.HasValue)
                return Perf.Measure("Document.Range", () => doc.Range(start.Value, end.Value), 0);
            throw new Exception("must provide bookmark, paragraphIndex, or start+end");
        }
    }

    /// <summary>
    /// RAII-style wrapper that enables TrackRevisions on entry and restores
    /// the previous value on dispose. Use:
    ///   using (new RevisionScope(doc, true)) { rng.Text = newText; }
    /// </summary>
    sealed class RevisionScope : IDisposable
    {
        readonly Word.Document _doc;
        readonly bool _prev;
        readonly bool _enabled;

        public RevisionScope(Word.Document doc, bool enabled)
        {
            _doc = doc;
            _prev = Perf.Measure("Document.TrackRevisions.get", () => _doc.TrackRevisions, 0);
            _enabled = enabled;
            if (enabled) Perf.Measure("Document.TrackRevisions.set", () => { _doc.TrackRevisions = true; }, 0);
        }

        public void Dispose()
        {
            if (_enabled) Perf.Measure("Document.TrackRevisions.set", () => { _doc.TrackRevisions = _prev; }, 0);
        }
    }
}
