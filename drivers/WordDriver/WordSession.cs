using System;
using System.Runtime.InteropServices;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// Lazy singleton over Word.Application. Always attaches to a running Word
    /// (never launches one) — the user owns the Word window's lifecycle.
    ///
    /// Self-heals from "RPC server unavailable" / "call rejected by callee" —
    /// these happen when the user closes Word and reopens it; the cached COM
    /// pointer becomes dead and any call returns 0x800706BA / 0x80010108.
    /// </summary>
    static class WordSession
    {
        static Word.Application _app;

        // HRESULTs that indicate the cached COM pointer is dead and we must
        // re-attach. Source: MS-RPCE / OLE error codes.
        //   0x800706BA = RPC_S_SERVER_UNAVAILABLE  (Word process gone)
        //   0x80010108 = RPC_E_DISCONNECTED         (object disconnected from clients)
        //   0x800401FD = CO_E_OBJNOTCONNECTED       (object not connected)
        public static bool IsDisconnected(COMException ex)
        {
            uint h = (uint)ex.HResult;
            return h == 0x800706BAu || h == 0x80010108u || h == 0x800401FDu;
        }

        public static object Attach()
        {
            ResetIfDead();
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
            ResetIfDead();
            if (_app == null) Attach();
            return _app;
        }

        public static Word.Document ActiveDoc()
        {
            var app = App();
            try
            {
                if (app.Documents.Count == 0) throw new Exception("no active document");
                return app.ActiveDocument;
            }
            catch (COMException ex) when (IsDisconnected(ex))
            {
                _app = null;
                // Re-attach once and retry. If Word really is gone, this throws
                // a fresh COMException that the caller turns into a friendly error.
                var fresh = App();
                if (fresh.Documents.Count == 0) throw new Exception("no active document");
                return fresh.ActiveDocument;
            }
        }

        /// <summary>
        /// Probe the cached pointer with a cheap call. If it's dead (Word
        /// process killed and possibly relaunched), null it out so the next
        /// Attach() picks up a fresh ROT entry.
        /// </summary>
        static void ResetIfDead()
        {
            if (_app == null) return;
            try
            {
                // Touching any property forces a COM round-trip. Documents.Count
                // is cheap and always available.
                var _ = _app.Documents.Count;
            }
            catch (COMException ex) when (IsDisconnected(ex))
            {
                _app = null;
            }
            catch (InvalidComObjectException)
            {
                _app = null;
            }
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
