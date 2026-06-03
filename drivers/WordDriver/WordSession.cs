using System;
using System.Runtime.InteropServices;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// Lazy singleton over Word.Application. Always attaches to a running Word
    /// (never launches one) — the user owns the Word window's lifecycle.
    /// </summary>
    static class WordSession
    {
        static Word.Application _app;

        public static object Attach()
        {
            if (_app != null)
            {
                return Describe();
            }
            var obj = Marshal.GetActiveObject("Word.Application");
            _app = obj as Word.Application;
            if (_app == null) throw new Exception("Word.Application not found (is Word running?)");
            return Describe();
        }

        public static Word.Application App()
        {
            if (_app == null) Attach();
            return _app;
        }

        public static Word.Document ActiveDoc()
        {
            var app = App();
            if (app.Documents.Count == 0) throw new Exception("no active document");
            return app.ActiveDocument;
        }

        static object Describe()
        {
            return new
            {
                attached = true,
                version = _app.Version,
                documents = _app.Documents.Count,
                activeDoc = _app.Documents.Count > 0 ? _app.ActiveDocument.Name : null
            };
        }
    }
}
