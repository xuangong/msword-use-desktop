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

                // Test/shutdown pseudo-codes (kept verbatim from v0.3 for the
                // existing supervisor hang test).
                if (code == "_freeze")
                {
                    while (true) System.Threading.Thread.Sleep(1000);
                }
                if (code == "_shutdown")
                {
                    WriteResponse(id, new { bye = true }, "", null);
                    return 0;
                }

                try
                {
                    var er = Roslyn.Host.Run(code);
                    WriteResponse(id, er.Result, er.Stdout ?? "", er.Error);
                }
                catch (Exception ex)
                {
                    WriteResponse(id, null, "", "host_error: " + ex.GetType().Name + ": " + ex.Message);
                }
            }
            return 0;
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
