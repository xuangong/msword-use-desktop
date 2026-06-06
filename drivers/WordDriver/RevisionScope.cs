using System;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// RAII-style wrapper that enables TrackRevisions on entry and restores
    /// the previous value on dispose. Used by the `Track(...)` global
    /// exposed to Roslyn-scripted code.
    ///
    /// Pattern:
    ///   using (new RevisionScope(doc, true)) { rng.Text = newText; }
    /// </summary>
    public sealed class RevisionScope : IDisposable
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
