using System;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// Driver main loop.
    ///
    /// Wire format: line-delimited JSON (LF terminator).
    ///   request:  {"id":"<str>","code":"<C# script>"}
    ///   response: {"id":"<str>","result":<json>,"stdout":"<str>","error":null}
    ///   error:    {"id":"<str>","result":null,"stdout":"<str>","error":"<msg>"}
    ///
    /// Special inputs:
    ///   {"id":"x","code":"_freeze"}  — hidden test trigger: blocks forever so the
    ///                                   sidecar supervisor can verify timeout+respawn.
    ///   {"id":"x","code":"_shutdown"} — cooperative shutdown; returns then exits.
    /// </summary>
    static class Program
    {
        static int Main()
        {
            // Force UTF-8 so Chinese content round-trips correctly through the pipe.
            Console.InputEncoding = Encoding.UTF8;
            Console.OutputEncoding = Encoding.UTF8;
            Console.Error.WriteLine("[driver] ready");

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;

                JObject req;
                try { req = JObject.Parse(line); }
                catch (Exception ex)
                {
                    WriteResponse(null, null, "", "parse_error: " + ex.Message);
                    continue;
                }

                var id = req["id"]?.ToString();
                var code = req["code"]?.ToString() ?? "";
                // Optional: hwnd of the Word window the user invoked from.
                // Roslyn.Host uses it to pick the right Document among
                // multiple open ones (App.ActiveDocument is unreliable).
                long triggerHwnd = req["triggerHwnd"]?.ToObject<long?>() ?? 0L;

                // Test/shutdown pseudo-codes (kept verbatim from v0.3 for the
                // existing supervisor hang test).
                if (code == "_freeze")
                {
                    while (true) System.Threading.Thread.Sleep(1000);
                }
                if (code == "_shutdown")
                {
                    try { WordSession.CloseAllReferences(); } catch { }
                    WriteResponse(id, new { bye = true }, "", null);
                    return 0;
                }

                // Reference document management — bypass Roslyn for typed RPC.
                // Format: _ref_open:<path> / _ref_close:<basename> / _ref_list / _ref_close_all
                if (code.StartsWith("_ref_open:"))
                {
                    var path = code.Substring("_ref_open:".Length);
                    try
                    {
                        var info = WordSession.OpenReference(path);
                        WriteResponse(id, info, "", null);
                    }
                    catch (Exception ex)
                    {
                        WriteResponse(id, null, "", "ref_open_error: " + ex.Message);
                    }
                    continue;
                }
                if (code.StartsWith("_ref_close:"))
                {
                    var name = code.Substring("_ref_close:".Length);
                    var ok = WordSession.CloseReference(name);
                    WriteResponse(id, new { closed = ok, name = name }, "", null);
                    continue;
                }
                if (code == "_ref_list")
                {
                    var list = new System.Collections.Generic.List<object>();
                    foreach (var kv in WordSession.References())
                    {
                        try { list.Add(new { name = kv.Key, path = kv.Value.FullName, paragraphs = kv.Value.Paragraphs.Count }); }
                        catch { /* dead handle, skip */ }
                    }
                    WriteResponse(id, new { references = list }, "", null);
                    continue;
                }
                if (code == "_ref_close_all")
                {
                    WordSession.CloseAllReferences();
                    WriteResponse(id, new { closed = true }, "", null);
                    continue;
                }
                if (code.StartsWith("_perf."))
                {
                    try
                    {
                        var perfResult = DispatchPerf(code);
                        WriteResponse(id, perfResult, "", null);
                    }
                    catch (Exception ex)
                    {
                        WriteResponse(id, null, "", "perf_error: " + ex.Message);
                    }
                    continue;
                }

                try
                {
                    Roslyn.ExecResult er;
                    using (Perf.Scope(id, "exec_csharp"))
                    {
                        var sw = System.Diagnostics.Stopwatch.StartNew();
                        er = Roslyn.Host.Run(code, triggerHwnd);
                        sw.Stop();
                        Perf.Record("exec_csharp", sw.ElapsedTicks * 1000_000L / System.Diagnostics.Stopwatch.Frequency, code.Length);
                    }
                    WriteResponse(id, er.Result, er.Stdout ?? "", er.Error);
                }
                catch (Exception ex)
                {
                    WriteResponse(id, null, "", "host_error: " + ex.GetType().Name + ": " + ex.Message);
                }
            }
            return 0;
        }

        static object DispatchPerf(string code)
        {
            string method = code;
            JObject p = new JObject();
            var colon = code.IndexOf(':');
            if (colon >= 0)
            {
                method = code.Substring(0, colon);
                var payload = code.Substring(colon + 1);
                if (!string.IsNullOrWhiteSpace(payload))
                {
                    p = JObject.Parse(payload);
                }
            }

            switch (method)
            {
                case "_perf.dump":
                {
                    long since = p["since"]?.ToObject<long?>() ?? 0L;
                    return new { entries = Perf.Dump(since), now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                }
                case "_perf.summary":
                {
                    long since = p["since"]?.ToObject<long?>() ?? 0L;
                    return Perf.Summary(since);
                }
                case "_perf.clear":
                    Perf.Clear();
                    return new { ok = true };
                case "_perf.record":
                {
                    string n = p["name"]?.ToString() ?? "(unknown)";
                    long us = p["durationUs"]?.ToObject<long?>() ?? 0L;
                    int ss = p["sampleSize"]?.ToObject<int?>() ?? 0;
                    string rid = p["requestId"]?.ToString();
                    string mth = p["method"]?.ToString();
                    Perf.Record(n, us, ss, rid, mth);
                    return new { ok = true };
                }
                default:
                    throw new Exception("unknown perf method: " + method);
            }
        }

        static void WriteResponse(string id, object result, string stdout, string error)
        {
            var resp = new
            {
                id = id,
                result = error == null ? result : null,
                stdout = stdout ?? "",
                error = error,
            };
            Console.Out.WriteLine(JsonConvert.SerializeObject(resp));
            Console.Out.Flush();
        }
    }
}
