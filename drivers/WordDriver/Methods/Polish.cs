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

            string original = rng.Text ?? "";
            using (new RevisionScope(doc, track))
            {
                rng.Text = newText;
            }
            return new
            {
                replacedChars = original.Length,
                newChars = newText.Length,
                rangeStart = rng.Start,
                rangeEnd = rng.End
            };
        }

        public static object AddComment(JObject p)
        {
            var doc = WordSession.ActiveDoc();
            var rng = ResolveRange(doc, p);
            string text = p["text"]?.ToString() ?? "";
            string author = p["author"]?.ToString() ?? "msword-use AI";

            var app = doc.Application;
            string prevAuthor = app.UserName;
            Word.Comment comment;
            try
            {
                app.UserName = author;
                comment = doc.Comments.Add(rng, text);
            }
            finally
            {
                app.UserName = prevAuthor;
            }
            return new
            {
                commentIndex = comment.Index,
                scope = (rng.Text ?? "").Length > 80
                    ? (rng.Text ?? "").Substring(0, 80)
                    : (rng.Text ?? "")
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
                if (!doc.Bookmarks.Exists(bookmark))
                    throw new Exception("bookmark not found: " + bookmark);
                return doc.Bookmarks[bookmark].Range;
            }
            if (paraIdx.HasValue)
                return doc.Paragraphs[paraIdx.Value].Range;
            if (start.HasValue && end.HasValue)
                return doc.Range(start.Value, end.Value);
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
            _prev = _doc.TrackRevisions;
            _enabled = enabled;
            if (enabled) _doc.TrackRevisions = true;
        }

        public void Dispose()
        {
            if (_enabled) _doc.TrackRevisions = _prev;
        }
    }
}
