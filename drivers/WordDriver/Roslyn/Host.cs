using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using Word = Microsoft.Office.Interop.Word;

namespace MswordUse.WordDriver.Roslyn
{
    /// <summary>
    /// Globals exposed to LLM-authored C# scripts. Keep this surface small
    /// and stable — the `word-com-cheatsheet` skill documents these names
    /// to the model. Renames are breaking changes for skills.
    /// </summary>
    public class Globals
    {
        public Word.Document Doc;
        public Word.Application App;
        /// <summary>
        /// Read-only reference documents the user attached via the UI. Keyed
        /// by file basename (e.g. "国务院通知.docx"). Always opened
        /// invisible + ReadOnly:=true. DO NOT call Save / SaveAs / set Text on
        /// these — Track() does not protect them and revisions don't track
        /// across docs anyway. Use them for reading format / sample content.
        /// </summary>
        public Dictionary<string, Word.Document> Refs;
        public StringBuilder __Stdout;

        public void Print(object o)
        {
            __Stdout.AppendLine(o == null ? "null" : o.ToString());
        }

        /// <summary>
        /// Wrap a write block so all mutations are recorded as tracked
        /// revisions. Skill `track-changes-protocol` mandates that every
        /// mutating script run inside Track(...). Reads do not need it.
        /// </summary>
        public void Track(Action body)
        {
            if (body == null) throw new ArgumentNullException("body");
            using (new RevisionScope(Doc, true))
            {
                body();
            }
        }
    }

    /// <summary>
    /// Result envelope returned to the sidecar.
    /// `Result` is whatever the script's last expression evaluated to (often
    /// null for void-returning scripts). It will be serialised to JSON by
    /// Newtonsoft. Stdout is collected from `Print(...)` calls.
    /// </summary>
    public class ExecResult
    {
        public object Result;
        public string Stdout;
        public string Error;
    }

    public static class Host
    {
        // Whitelisted using-namespaces. Adding to this list is cheap; removing
        // is breaking for existing skills.
        static readonly string[] DefaultImports = new[]
        {
            "System",
            "System.Linq",
            "System.Collections.Generic",
            "System.Text",
            "System.Text.RegularExpressions",
            "Microsoft.Office.Interop.Word",
        };

        static ScriptOptions _cachedOptions;

        static ScriptOptions BuildOptions()
        {
            if (_cachedOptions != null) return _cachedOptions;

            // Reference every assembly already loaded in the driver process.
            // Filtering would be safer, but the LLM legitimately wants Linq,
            // Regex, Office Interop, etc. The Roslyn sandbox is "lock the
            // front door", not a true sandbox — that's an accepted tradeoff
            // for a local desktop app.
            var refs = new List<Microsoft.CodeAnalysis.MetadataReference>();
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    if (string.IsNullOrEmpty(asm.Location)) continue;
                    refs.Add(Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(asm.Location));
                }
                catch { /* dynamic / in-memory assemblies; skip */ }
            }
            _cachedOptions = ScriptOptions.Default
                .WithReferences(refs)
                .WithImports(DefaultImports);
            return _cachedOptions;
        }

        public static ExecResult Run(string code)
        {
            if (string.IsNullOrWhiteSpace(code))
                return new ExecResult { Error = "empty_code" };

            // Lazy attach: scripts that only use System types don't need Word.
            // If Word isn't running, Doc/App stay null and the script will
            // NRE on first use — surfaced as a runtime_error to the LLM.
            Word.Document doc = null;
            Word.Application app = null;
            try
            {
                doc = WordSession.ActiveDoc();
                app = doc.Application;
            }
            catch
            {
                /* leave nulls; LLM will see a clear runtime error if it tries to access Doc/App */
            }

            var globals = new Globals
            {
                Doc = doc,
                App = app,
                Refs = new Dictionary<string, Word.Document>(WordSession.References(), StringComparer.OrdinalIgnoreCase),
                __Stdout = new StringBuilder(),
            };

            try
            {
                var task = CSharpScript.RunAsync(code, BuildOptions(), globals);
                task.Wait();
                return new ExecResult
                {
                    Result = task.Result.ReturnValue,
                    Stdout = globals.__Stdout.ToString(),
                };
            }
            catch (CompilationErrorException cex)
            {
                return new ExecResult
                {
                    Stdout = globals.__Stdout.ToString(),
                    Error = "compile_error: " + string.Join("\n", cex.Diagnostics),
                };
            }
            catch (AggregateException aex) when (aex.InnerException != null)
            {
                return new ExecResult
                {
                    Stdout = globals.__Stdout.ToString(),
                    Error = "runtime_error: " + aex.InnerException.GetType().Name + ": " + aex.InnerException.Message,
                };
            }
            catch (Exception ex)
            {
                return new ExecResult
                {
                    Stdout = globals.__Stdout.ToString(),
                    Error = "runtime_error: " + ex.GetType().Name + ": " + ex.Message,
                };
            }
        }
    }
}
