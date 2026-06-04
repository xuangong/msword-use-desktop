using System;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// JSON-RPC entry point: reads NDJSON requests from stdin, dispatches to
    /// method handlers, writes JSON results to stdout. One line per message.
    ///
    /// Wire format:
    ///   request : {"id":"<str>","method":"<str>","params":{...}}
    ///   response: {"id":"<str>","result":{...},"error":null}
    ///   error   : {"id":"<str>","result":null,"error":"<msg>"}
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
                    WriteResponse(null, null, "parse_error: " + ex.Message);
                    continue;
                }

                var id = req["id"]?.ToString();
                var method = req["method"]?.ToString();
                var paramsObj = req["params"] as JObject ?? new JObject();

                try
                {
                    object result = Dispatch(method, paramsObj);
                    WriteResponse(id, result, null);
                }
                catch (Exception ex)
                {
                    WriteResponse(id, null, ex.GetType().Name + ": " + ex.Message);
                }

                // P0-12: shutdown writes its response above via the normal
                // path, then exits AFTER the write completes. The previous
                // version wrote twice (once in Dispatch, once here).
                if (method == "shutdown")
                {
                    return 0;
                }
            }
            return 0;
        }

        static object Dispatch(string method, JObject p)
        {
            switch (method)
            {
                case "ping":
                    return new { pong = true };

                // Hidden test method (not in schema): simulate a hang so the
                // supervisor can verify timeout + kill+respawn end-to-end.
                case "_freeze":
                    while (true) System.Threading.Thread.Sleep(1000);

                case "attach":
                    return WordSession.Attach();

                case "observe.selection":
                    return Methods.Observe.Selection();
                case "observe.outline":
                    return Methods.Observe.Outline(p["maxLevel"]?.ToObject<int?>() ?? 3);
                case "observe.paragraph":
                    return Methods.Observe.Paragraph(p["index"].ToObject<int>());

                case "polish.replaceRange":
                    return Methods.Polish.ReplaceRange(p);
                case "polish.addComment":
                    return Methods.Polish.AddComment(p);

                case "shutdown":
                    // Return cleanly; the main loop writes our response then
                    // exits the while-loop because of method == "shutdown".
                    return new { bye = true };

                default:
                    throw new Exception("unknown method: " + method);
            }
        }

        static void WriteResponse(string id, object result, string error)
        {
            var resp = new
            {
                id = id,
                result = error == null ? result : null,
                error = error
            };
            Console.Out.WriteLine(JsonConvert.SerializeObject(resp));
            Console.Out.Flush();
        }
    }
}
