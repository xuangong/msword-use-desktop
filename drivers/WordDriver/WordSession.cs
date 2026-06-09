using System;
using System.Collections.Generic;
using System.IO;
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
        // P/Invoke: Word.Window.Hwnd returns the *content* window (_WwG / _WwF
        // class), but Win32's GetForegroundWindow gives the top-level OpusApp
        // shell window — different ancestors of the same logical window.
        // GetAncestor(hwnd, GA_ROOT) climbs to the top-level so we can compare
        // against the trigger HWND captured by Tauri's capture_foreground().
        [DllImport("user32.dll")]
        static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
        const uint GA_ROOT = 2;

        static IntPtr ToRoot(IntPtr h)
        {
            if (h == IntPtr.Zero) return h;
            try { var r = GetAncestor(h, GA_ROOT); return r == IntPtr.Zero ? h : r; }
            catch { return h; }
        }

        static Word.Application _app;

        // HRESULTs that indicate the cached COM pointer is dead (or no Word is
        // running at all) and we must re-attach. Source: MS-RPCE / OLE error codes.
        //   0x800706BA = RPC_S_SERVER_UNAVAILABLE  (Word process gone)
        //   0x80010108 = RPC_E_DISCONNECTED         (object disconnected from clients)
        //   0x800401FD = CO_E_OBJNOTCONNECTED       (object not connected)
        //   0x800401E3 = MK_E_UNAVAILABLE           (no Word.Application in ROT —
        //                                            either Word isn't running, or
        //                                            it's still starting up)
        public static bool IsDisconnected(COMException ex)
        {
            uint h = (uint)ex.HResult;
            return h == 0x800706BAu || h == 0x80010108u || h == 0x800401FDu || h == 0x800401E3u;
        }

        public static object Attach()
        {
            ResetIfDead();
            if (_app != null)
            {
                return Describe();
            }
            try
            {
                var obj = Marshal.GetActiveObject("Word.Application");
                _app = obj as Word.Application;
            }
            catch (COMException ex) when (IsDisconnected(ex))
            {
                // Translate the raw HRESULT into a message friendlyDriverError
                // can recognize on the agent side.
                throw new Exception("Word.Application not found (is Word running?)");
            }
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
        /// Resolve the Word.Document whose top-level window has the given HWND.
        /// Used to pin the agent to the EXACT Word window the user invoked the
        /// hotkey from, instead of trusting App.ActiveDocument (which is
        /// application-level and lags behind / points at the wrong window when
        /// the user has multiple Word documents open).
        ///
        /// Returns null when no window matches — caller should fall back to
        /// ActiveDoc() and surface the mismatch to the user.
        /// </summary>
        public static Word.Document DocByHwnd(long hwnd)
        {
            if (hwnd == 0) return null;
            var target = new IntPtr(hwnd);
            var app = App();
            try
            {
                foreach (Word.Window w in app.Windows)
                {
                    try
                    {
                        var raw = new IntPtr(w.Hwnd);
                        var rootHwnd = ToRoot(raw);
                        Console.Error.WriteLine(string.Format(
                            "[DocByHwnd] candidate doc={0} raw=0x{1:X} root=0x{2:X} target=0x{3:X}",
                            w.Document?.Name ?? "(null)", raw.ToInt64(), rootHwnd.ToInt64(), target.ToInt64()));
                        if (rootHwnd == target || raw == target) return w.Document;
                    }
                    catch (COMException) { /* dead window in the collection, skip */ }
                }
            }
            catch (COMException ex) when (IsDisconnected(ex))
            {
                _app = null;
                var fresh = App();
                foreach (Word.Window w in fresh.Windows)
                {
                    try
                    {
                        var raw = new IntPtr(w.Hwnd);
                        var rootHwnd = ToRoot(raw);
                        if (rootHwnd == target || raw == target) return w.Document;
                    }
                    catch (COMException) { }
                }
            }
            Console.Error.WriteLine(string.Format("[DocByHwnd] NO MATCH for target=0x{0:X}", target.ToInt64()));
            return null;
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

        // ---------- reference documents (read-only attachments) ----------
        //
        // The UI lets the user pick one or more .docx files as "reference"
        // material. We open each invisibly via Documents.Open(ReadOnly:=true,
        // Visible:=false) so the user's foreground Word session is undisturbed,
        // and expose them to LLM-authored scripts via Globals.Refs[name].
        //
        // Storage is a simple Dictionary keyed by the file's basename (which
        // is what scripts will reference). If the same basename is opened
        // twice, the existing handle is reused; if a different file with the
        // same basename comes in, the old one is closed first.
        //
        // Lifecycle: scripts treat these as read-only — there is no Save()
        // path. CloseReference() is called on detach + on driver shutdown
        // (best-effort; if Word died, the COM call no-ops).

        static readonly Dictionary<string, Word.Document> _refs = new Dictionary<string, Word.Document>(StringComparer.OrdinalIgnoreCase);

        public static IDictionary<string, Word.Document> References()
        {
            return _refs;
        }

        public static object OpenReference(string fullPath)
        {
            if (string.IsNullOrWhiteSpace(fullPath)) throw new Exception("path is empty");
            if (!File.Exists(fullPath)) throw new Exception("file not found: " + fullPath);
            var name = Path.GetFileName(fullPath);
            var app = App();
            // If we already opened this name, decide: same path → reuse; different
            // path → close the old one and open the new one.
            if (_refs.TryGetValue(name, out var existing))
            {
                try
                {
                    if (string.Equals(existing.FullName, fullPath, StringComparison.OrdinalIgnoreCase))
                    {
                        return new { name, path = existing.FullName, paragraphs = existing.Paragraphs.Count, reused = true };
                    }
                    CloseDoc(existing);
                }
                catch { /* dead handle, just drop */ }
                _refs.Remove(name);
            }
            object pathObj = fullPath;
            object readOnly = true;
            object visible = false;
            object addToRecent = false;
            // Documents.Open is heavily overloaded; use named-args via reflection-style
            // would be cleaner, but Word's late-bound surface accepts boxed `object`
            // refs in this order: FileName, ConfirmConversions, ReadOnly, AddToRecentFiles
            // … (a long tail). We pass ReadOnly + AddToRecentFiles + Visible explicitly.
            object missing = Type.Missing;
            var doc = app.Documents.Open(
                ref pathObj,
                ref missing,           // ConfirmConversions
                ref readOnly,
                ref addToRecent,
                ref missing,           // PasswordDocument
                ref missing,           // PasswordTemplate
                ref missing,           // Revert
                ref missing,           // WritePasswordDocument
                ref missing,           // WritePasswordTemplate
                ref missing,           // Format
                ref missing,           // Encoding
                ref visible,
                ref missing,           // OpenAndRepair
                ref missing,           // DocumentDirection
                ref missing,           // NoEncodingDialog
                ref missing            // XMLTransform
            );
            _refs[name] = doc;
            return new { name, path = doc.FullName, paragraphs = doc.Paragraphs.Count, reused = false };
        }

        public static bool CloseReference(string name)
        {
            if (!_refs.TryGetValue(name, out var doc)) return false;
            _refs.Remove(name);
            CloseDoc(doc);
            return true;
        }

        public static void CloseAllReferences()
        {
            foreach (var kv in new List<KeyValuePair<string, Word.Document>>(_refs))
            {
                CloseDoc(kv.Value);
            }
            _refs.Clear();
        }

        static void CloseDoc(Word.Document doc)
        {
            try
            {
                object save = Word.WdSaveOptions.wdDoNotSaveChanges;
                object originalFormat = Type.Missing;
                object routeDocument = Type.Missing;
                doc.Close(ref save, ref originalFormat, ref routeDocument);
            }
            catch { /* dead handle, ignore */ }
        }
    }
}
