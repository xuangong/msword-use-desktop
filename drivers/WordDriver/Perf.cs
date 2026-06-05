using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;

namespace MswordUse.WordDriver
{
    /// <summary>
    /// Process-wide perf ring buffer + Measure helper.
    ///
    /// Records a fixed-size FIFO of recent COM-call timings (default 10000
    /// entries). The driver dispatcher is single-threaded, but dump/record
    /// can race with the in-flight handler so all reads/writes hold _lock.
    ///
    /// Each entry is keyed by a stable string `name` (e.g. "Range.Text.set",
    /// "Find.Execute", "polish.replaceRange"). Names should be compile-time
    /// constants — string interpolation in hot paths defeats GC.
    ///
    /// duration is microseconds. Stopwatch.Frequency on Windows is QPC, ~100ns
    /// resolution, so µs is honest. Most COM calls land 100µs–10ms.
    /// </summary>
    public static class Perf
    {
        public struct Entry
        {
            public long Ts;             // unix ms
            public long DurationUs;     // microseconds
            public string Name;         // "Range.Text.set" etc.
            public string RequestId;    // optional — set via Scope; correlates to top RPC id
            public string Method;       // optional — top-level RPC method, e.g. "polish.replaceRange"
            public int SampleSize;      // optional — input size signal (text length, paragraph count, …)
        }

        const int CAP = 10000;
        static readonly Entry[] _buf = new Entry[CAP];
        static int _head = 0;        // next write slot
        static long _seq = 0;        // monotonic event counter, increases past CAP
        static readonly object _lock = new object();

        // Per-thread ambient context. Set by Scope at the top of an RPC handler so
        // every Measure() inside auto-tags request_id + method. Avoids threading
        // these args through every call site.
        [ThreadStatic] static string _ctxRequestId;
        [ThreadStatic] static string _ctxMethod;

        /// <summary>
        /// RAII scope: sets ambient request_id + method for all Measure() calls
        /// on this thread until disposed. Use at the top of each RPC handler:
        ///   using (Perf.Scope(id, method)) { ... }
        /// </summary>
        public static IDisposable Scope(string requestId, string method)
        {
            var prevId = _ctxRequestId;
            var prevMethod = _ctxMethod;
            _ctxRequestId = requestId;
            _ctxMethod = method;
            return new Pop(prevId, prevMethod);
        }

        sealed class Pop : IDisposable
        {
            readonly string _prevId;
            readonly string _prevMethod;
            public Pop(string id, string m) { _prevId = id; _prevMethod = m; }
            public void Dispose() { _ctxRequestId = _prevId; _ctxMethod = _prevMethod; }
        }

        /// <summary>Time fn() and record the result. Returns fn()'s value.</summary>
        public static T Measure<T>(string name, Func<T> fn, int sampleSize = 0)
        {
            var sw = Stopwatch.StartNew();
            try { return fn(); }
            finally { sw.Stop(); Record(name, ToUs(sw.ElapsedTicks), sampleSize); }
        }

        public static void Measure(string name, Action fn, int sampleSize = 0)
        {
            var sw = Stopwatch.StartNew();
            try { fn(); }
            finally { sw.Stop(); Record(name, ToUs(sw.ElapsedTicks), sampleSize); }
        }

        /// <summary>Direct entry — used by _perf.record (sidecar pushes LLM timings).</summary>
        public static void Record(string name, long durationUs, int sampleSize, string requestId = null, string method = null)
        {
            var e = new Entry
            {
                Ts = NowMs(),
                DurationUs = durationUs,
                Name = name ?? "(unknown)",
                RequestId = requestId ?? _ctxRequestId,
                Method = method ?? _ctxMethod,
                SampleSize = sampleSize,
            };
            lock (_lock)
            {
                _buf[_head] = e;
                _head = (_head + 1) % CAP;
                _seq++;
            }
        }

        static void Record(string name, long durationUs, int sampleSize)
        {
            Record(name, durationUs, sampleSize, null, null);
        }

        static long ToUs(long ticks)
        {
            // ticks * 1_000_000 / Frequency. Avoid double for stability.
            // Frequency is typically 10_000_000 (QPC) but not guaranteed.
            return ticks * 1_000_000L / Stopwatch.Frequency;
        }

        static long NowMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        /// <summary>
        /// Dump entries with ts &gt; sinceTs (exclusive). Returns at most CAP
        /// entries; if buffer wrapped past sinceTs the older ones are silently
        /// lost (UI should poll faster than ~1-2min @ heavy load).
        /// </summary>
        public static List<Entry> Dump(long sinceTs)
        {
            var result = new List<Entry>(256);
            lock (_lock)
            {
                long total = _seq;
                if (total == 0) return result;
                int count = total < CAP ? (int)total : CAP;
                int start = total < CAP ? 0 : _head;
                for (int i = 0; i < count; i++)
                {
                    int idx = (start + i) % CAP;
                    var e = _buf[idx];
                    if (e.Ts > sinceTs) result.Add(e);
                }
            }
            return result;
        }

        public static void Clear()
        {
            lock (_lock)
            {
                _head = 0;
                _seq = 0;
                Array.Clear(_buf, 0, _buf.Length);
            }
        }

        /// <summary>
        /// Pre-aggregated summary: by name and by method. Single pass over the
        /// buffer; UI calls this each tick instead of recomputing client-side.
        /// </summary>
        public static object Summary(long sinceTs)
        {
            var byName = new Dictionary<string, Agg>();
            var byMethod = new Dictionary<string, Agg>();
            lock (_lock)
            {
                long total = _seq;
                int count = total < CAP ? (int)total : CAP;
                int start = total < CAP ? 0 : _head;
                for (int i = 0; i < count; i++)
                {
                    var e = _buf[(start + i) % CAP];
                    if (e.Ts <= sinceTs) continue;
                    Add(byName, e.Name ?? "(unknown)", e.DurationUs);
                    if (!string.IsNullOrEmpty(e.Method))
                        Add(byMethod, e.Method, e.DurationUs);
                }
            }
            return new
            {
                byName = Materialize(byName),
                byMethod = Materialize(byMethod),
            };
        }

        sealed class Agg
        {
            public List<long> Samples = new List<long>(); // µs
            public long Total;
            public long Max;
            public long Last;
        }

        static void Add(Dictionary<string, Agg> map, string key, long us)
        {
            Agg a;
            if (!map.TryGetValue(key, out a)) { a = new Agg(); map[key] = a; }
            a.Samples.Add(us);
            a.Total += us;
            if (us > a.Max) a.Max = us;
            a.Last = us;
        }

        static List<object> Materialize(Dictionary<string, Agg> map)
        {
            var rows = new List<object>(map.Count);
            foreach (var kv in map)
            {
                var s = kv.Value.Samples;
                s.Sort();
                int n = s.Count;
                long p50 = s[n / 2];
                long p95 = s[Math.Min(n - 1, (int)(n * 0.95))];
                rows.Add(new
                {
                    name = kv.Key,
                    count = n,
                    totalUs = kv.Value.Total,
                    avgUs = kv.Value.Total / n,
                    p50Us = p50,
                    p95Us = p95,
                    maxUs = kv.Value.Max,
                    lastUs = kv.Value.Last,
                });
            }
            return rows;
        }
    }
}
