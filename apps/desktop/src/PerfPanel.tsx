/**
 * Performance panel — Task Manager-style view of driver perf data.
 *
 * Polls _perf.summary and _perf.dump at 1Hz. Renders:
 *   - Overview: 4 sparklines (calls/s, com_ms/s, llm_ms/s, active_turns) +
 *     Top 5 slowest API in last window.
 *   - By API: sortable table grouped by `name` with count/total/avg/p50/p95/max/last.
 *   - By Method: same shape, grouped by RPC method (rpc:polish.replaceRange,
 *     agent.turn, etc.). Click row to drill into inner names.
 *   - Recent: last 50 distinct request_ids, with method + total ms split by
 *     llm vs com.
 *
 * Updates hold a 60s sliding window in memory; older samples are dropped.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { rawCall } from "./rpc";

type PerfEntry = {
  Ts: number;
  DurationUs: number;
  Name: string;
  RequestId?: string | null;
  Method?: string | null;
  SampleSize?: number;
};

type AggRow = {
  name: string;
  count: number;
  totalUs: number;
  avgUs: number;
  p50Us: number;
  p95Us: number;
  maxUs: number;
  lastUs: number;
};

type Tab = "overview" | "byApi" | "byMethod" | "recent";

export function PerfPanel() {
  const [tab, setTab] = useState<Tab>("overview");
  const [tickHz, setTickHz] = useState<number>(1);
  const [paused, setPaused] = useState(false);
  const [byName, setByName] = useState<AggRow[]>([]);
  const [byMethod, setByMethod] = useState<AggRow[]>([]);
  const [entries, setEntries] = useState<PerfEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef<number>(0);
  // Per-second sparkline buckets: kept as a flat array of {ts, calls, comUs, llmUs}.
  const seriesRef = useRef<{ ts: number; calls: number; comUs: number; llmUs: number }[]>([]);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const sum = (await rawCall("_perf.summary", { since: 0 })) as {
          byName: AggRow[];
          byMethod: AggRow[];
        };
        const dump = (await rawCall("_perf.dump", { since: sinceRef.current })) as {
          entries: PerfEntry[];
          now: number;
        };
        if (cancelled) return;
        if (sum) {
          setByName(sum.byName ?? []);
          setByMethod(sum.byMethod ?? []);
        }
        if (dump?.entries?.length) {
          // Update last seen ts.
          for (const e of dump.entries) {
            if (e.Ts > sinceRef.current) sinceRef.current = e.Ts;
          }
          setEntries((prev) => {
            const cutoff = Date.now() - 5 * 60_000;
            return [...prev, ...dump.entries].filter((e) => e.Ts > cutoff).slice(-5000);
          });
          // Bucket into per-second series for sparklines.
          const bucket = new Map<number, { calls: number; comUs: number; llmUs: number }>();
          for (const e of dump.entries) {
            const sec = Math.floor(e.Ts / 1000);
            const cur = bucket.get(sec) ?? { calls: 0, comUs: 0, llmUs: 0 };
            cur.calls += 1;
            if (e.Name?.startsWith("llm.")) cur.llmUs += e.DurationUs;
            else cur.comUs += e.DurationUs;
            bucket.set(sec, cur);
          }
          for (const [sec, v] of bucket) {
            const tsMs = sec * 1000;
            const i = seriesRef.current.findIndex((x) => x.ts === tsMs);
            if (i >= 0) {
              seriesRef.current[i] = {
                ts: tsMs,
                calls: seriesRef.current[i]!.calls + v.calls,
                comUs: seriesRef.current[i]!.comUs + v.comUs,
                llmUs: seriesRef.current[i]!.llmUs + v.llmUs,
              };
            } else {
              seriesRef.current.push({ ts: tsMs, ...v });
            }
          }
          // Trim to last 60 seconds, sort.
          const since = Date.now() - 60_000;
          seriesRef.current = seriesRef.current.filter((s) => s.ts >= since).sort((a, b) => a.ts - b.ts);
          forceTick((n) => n + 1);
        } else {
          forceTick((n) => n + 1); // refresh sparkline scale even if no new events
        }
        setError(null);
      } catch (err: any) {
        setError(String(err?.message ?? err));
      }
    };
    tick();
    const interval = setInterval(tick, 1000 / tickHz);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [paused, tickHz]);

  return (
    <main className="h-full flex flex-col bg-neutral-50">
      <header className="px-4 py-3 border-b border-neutral-200 bg-white flex items-center gap-4 shrink-0">
        <h2 className="text-lg font-semibold">性能</h2>
        <nav className="flex gap-1 text-sm">
          <TabBtn active={tab === "overview"} onClick={() => setTab("overview")}>概览</TabBtn>
          <TabBtn active={tab === "byApi"} onClick={() => setTab("byApi")}>按 API</TabBtn>
          <TabBtn active={tab === "byMethod"} onClick={() => setTab("byMethod")}>按方法</TabBtn>
          <TabBtn active={tab === "recent"} onClick={() => setTab("recent")}>最近请求</TabBtn>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <select
            value={tickHz}
            onChange={(e) => setTickHz(Number(e.currentTarget.value))}
            className="border border-neutral-300 rounded px-1.5 py-0.5 bg-white"
            title="更新速度"
          >
            <option value={2}>2 Hz</option>
            <option value={1}>1 Hz</option>
            <option value={0.5}>0.5 Hz</option>
          </select>
          <button
            onClick={() => setPaused((p) => !p)}
            className={`px-2 py-0.5 rounded border ${paused ? "bg-amber-100 border-amber-300" : "border-neutral-300"}`}
          >
            {paused ? "▶ 恢复" : "⏸ 暂停"}
          </button>
          <button
            onClick={async () => {
              await rawCall("_perf.clear", {});
              setByName([]); setByMethod([]); setEntries([]); seriesRef.current = []; sinceRef.current = 0;
              forceTick((n) => n + 1);
            }}
            className="px-2 py-0.5 rounded border border-neutral-300"
          >
            🗑 清空
          </button>
        </div>
      </header>

      {error && <div className="px-4 py-1 text-xs text-red-700 bg-red-50 border-b border-red-200">{error}</div>}

      <section className="flex-1 overflow-auto">
        {tab === "overview" && <OverviewTab series={seriesRef.current} byName={byName} entries={entries} />}
        {tab === "byApi" && <AggTable rows={byName} title="API" />}
        {tab === "byMethod" && <AggTable rows={byMethod} title="Method" />}
        {tab === "recent" && <RecentTab entries={entries} />}
      </section>
    </main>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded ${active ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
    >
      {children}
    </button>
  );
}

// ============================================================
// Overview
// ============================================================

function OverviewTab({
  series,
  byName,
  entries,
}: {
  series: { ts: number; calls: number; comUs: number; llmUs: number }[];
  byName: AggRow[];
  entries: PerfEntry[];
}) {
  // Fill 60 buckets ending at "now" so the sparkline keeps moving when idle.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const buckets: { ts: number; calls: number; comUs: number; llmUs: number }[] = [];
  const map = new Map(series.map((s) => [s.ts, s]));
  for (let i = 59; i >= 0; i--) {
    const ts = now - i * 1000;
    buckets.push(map.get(ts) ?? { ts, calls: 0, comUs: 0, llmUs: 0 });
  }
  const callsArr = buckets.map((b) => b.calls);
  const comArr = buckets.map((b) => b.comUs / 1000);
  const llmArr = buckets.map((b) => b.llmUs / 1000);

  // Top 5 slowest API in the last 30s window from the entries buffer.
  const cutoff = Date.now() - 30_000;
  const recent = entries.filter((e) => e.Ts >= cutoff);
  const top = aggregate(recent).sort((a, b) => b.totalUs - a.totalUs).slice(0, 5);

  return (
    <div className="p-4 grid grid-cols-2 gap-4">
      <Sparkline title="COM 调用 / 秒" data={callsArr} color="#2563eb" suffix=" /s" />
      <Sparkline title="COM 时间 / 秒" data={comArr} color="#16a34a" suffix=" ms" />
      <Sparkline title="LLM 时间 / 秒" data={llmArr} color="#9333ea" suffix=" ms" />
      <Sparkline
        title="最近 60 秒最慢调用"
        data={buckets.map((b) => Math.max(b.comUs, b.llmUs) / 1000)}
        color="#ea580c"
        suffix=" ms"
      />
      <div className="col-span-2 bg-white border border-neutral-200 rounded p-3">
        <h3 className="text-sm font-semibold mb-2">最近 30 秒 Top 5 调用</h3>
        {top.length === 0 ? (
          <div className="text-xs text-neutral-500">无数据</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-left">name</th>
                <th className="text-right">count</th>
                <th className="text-right">total</th>
                <th className="text-right">avg</th>
                <th className="text-right">p95</th>
                <th className="text-right">max</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.name} className="border-t border-neutral-100">
                  <td className="py-1 font-mono">{r.name}</td>
                  <td className="text-right">{r.count}</td>
                  <td className="text-right">{fmtUs(r.totalUs)}</td>
                  <td className="text-right">{fmtUs(r.avgUs)}</td>
                  <td className={`text-right ${heatClass(r.p95Us)}`}>{fmtUs(r.p95Us)}</td>
                  <td className={`text-right ${heatClass(r.maxUs)}`}>{fmtUs(r.maxUs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="col-span-2 text-xs text-neutral-500">
        累计：{byName.length} 个 API · {byName.reduce((a, b) => a + b.count, 0)} 次调用 ·{" "}
        {fmtUs(byName.reduce((a, b) => a + b.totalUs, 0))} 总耗时
      </div>
    </div>
  );
}

function Sparkline({ title, data, color, suffix }: { title: string; data: number[]; color: string; suffix: string }) {
  const w = 320, h = 60, pad = 4;
  const max = Math.max(1, ...data);
  const last = data[data.length - 1] ?? 0;
  const points = data
    .map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - pad * 2);
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <div className="bg-white border border-neutral-200 rounded p-3 flex flex-col">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs text-neutral-500">{title}</span>
        <span className="text-sm font-mono" style={{ color }}>
          {Math.round(last * 10) / 10}
          {suffix}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
        <polyline fill="none" stroke={color} strokeWidth={1.5} points={points} />
      </svg>
      <div className="text-[10px] text-neutral-400 flex justify-between">
        <span>-60s</span>
        <span>峰 {Math.round(max * 10) / 10}{suffix}</span>
        <span>now</span>
      </div>
    </div>
  );
}

// ============================================================
// By API / By Method
// ============================================================

type SortKey = "name" | "count" | "totalUs" | "avgUs" | "p50Us" | "p95Us" | "maxUs" | "lastUs";

function AggTable({ rows, title }: { rows: AggRow[]; title: string }) {
  const [sortKey, setSortKey] = useState<SortKey>("totalUs");
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => {
    const f = filter.toLowerCase();
    const filtered = f ? rows.filter((r) => r.name.toLowerCase().includes(f)) : rows;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] as any;
      const bv = b[sortKey] as any;
      const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return desc ? -cmp : cmp;
    });
  }, [rows, sortKey, desc, filter]);

  function head(key: SortKey, label: string, align: "left" | "right" = "right") {
    const active = sortKey === key;
    return (
      <th
        onClick={() => {
          if (active) setDesc((d) => !d);
          else { setSortKey(key); setDesc(true); }
        }}
        className={`cursor-pointer select-none px-2 py-1 ${align === "right" ? "text-right" : "text-left"} ${active ? "text-neutral-900" : "text-neutral-500"}`}
      >
        {label}
        {active && (desc ? " ↓" : " ↑")}
      </th>
    );
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          placeholder={`筛选 ${title}…`}
          className="text-xs border border-neutral-300 rounded px-2 py-1 bg-white w-64"
        />
        <span className="text-xs text-neutral-500">{sorted.length} 行</span>
      </div>
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 border-b border-neutral-200 text-[11px]">
            <tr>
              {head("name", title, "left")}
              {head("count", "count")}
              {head("totalUs", "total")}
              {head("avgUs", "avg")}
              {head("p50Us", "p50")}
              {head("p95Us", "p95")}
              {head("maxUs", "max")}
              {head("lastUs", "last")}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-neutral-100 hover:bg-neutral-50">
                <td className="px-2 py-1 font-mono">{r.name}</td>
                <td className="px-2 py-1 text-right">{r.count}</td>
                <td className="px-2 py-1 text-right">{fmtUs(r.totalUs)}</td>
                <td className={`px-2 py-1 text-right ${heatClass(r.avgUs)}`}>{fmtUs(r.avgUs)}</td>
                <td className={`px-2 py-1 text-right ${heatClass(r.p50Us)}`}>{fmtUs(r.p50Us)}</td>
                <td className={`px-2 py-1 text-right ${heatClass(r.p95Us)}`}>{fmtUs(r.p95Us)}</td>
                <td className={`px-2 py-1 text-right ${heatClass(r.maxUs)}`}>{fmtUs(r.maxUs)}</td>
                <td className={`px-2 py-1 text-right ${heatClass(r.lastUs)}`}>{fmtUs(r.lastUs)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-4 text-neutral-400 text-xs">无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// Recent requests
// ============================================================

function RecentTab({ entries }: { entries: PerfEntry[] }) {
  // Group by request_id; for each show: method, total ms, llm vs com split, # calls.
  const groups = new Map<string, PerfEntry[]>();
  for (const e of entries) {
    const id = e.RequestId || "(no-id)";
    const arr = groups.get(id) ?? [];
    arr.push(e);
    groups.set(id, arr);
  }
  const rows = [...groups.entries()]
    .map(([id, evs]) => {
      const totalUs = evs.reduce((a, b) => a + b.DurationUs, 0);
      const llmUs = evs.filter((e) => e.Name.startsWith("llm.")).reduce((a, b) => a + b.DurationUs, 0);
      const comUs = totalUs - llmUs;
      const method = evs.find((e) => e.Method)?.Method ?? "(unknown)";
      const startTs = Math.min(...evs.map((e) => e.Ts));
      return { id, method, totalUs, llmUs, comUs, count: evs.length, startTs };
    })
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, 50);

  return (
    <div className="p-4">
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-neutral-50 border-b border-neutral-200 text-[11px] text-neutral-500">
            <tr>
              <th className="text-left px-2 py-1">request</th>
              <th className="text-left px-2 py-1">method</th>
              <th className="text-right px-2 py-1">total</th>
              <th className="text-right px-2 py-1">LLM</th>
              <th className="text-right px-2 py-1">COM</th>
              <th className="text-right px-2 py-1">calls</th>
              <th className="text-right px-2 py-1">when</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-neutral-100 hover:bg-neutral-50">
                <td className="px-2 py-1 font-mono text-neutral-500">{r.id}</td>
                <td className="px-2 py-1 font-mono">{r.method}</td>
                <td className={`px-2 py-1 text-right ${heatClass(r.totalUs)}`}>{fmtUs(r.totalUs)}</td>
                <td className="px-2 py-1 text-right text-purple-700">{fmtUs(r.llmUs)}</td>
                <td className="px-2 py-1 text-right text-green-700">{fmtUs(r.comUs)}</td>
                <td className="px-2 py-1 text-right">{r.count}</td>
                <td className="px-2 py-1 text-right text-neutral-400">{fmtAgo(r.startTs)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-4 text-neutral-400 text-xs">无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// helpers
// ============================================================

function aggregate(es: PerfEntry[]): AggRow[] {
  const m = new Map<string, number[]>();
  for (const e of es) {
    const arr = m.get(e.Name) ?? [];
    arr.push(e.DurationUs);
    m.set(e.Name, arr);
  }
  const rows: AggRow[] = [];
  for (const [name, samples] of m) {
    samples.sort((a, b) => a - b);
    const n = samples.length;
    const total = samples.reduce((a, b) => a + b, 0);
    rows.push({
      name,
      count: n,
      totalUs: total,
      avgUs: Math.floor(total / n),
      p50Us: samples[Math.floor(n / 2)] ?? 0,
      p95Us: samples[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0,
      maxUs: samples[n - 1] ?? 0,
      lastUs: samples[n - 1] ?? 0,
    });
  }
  return rows;
}

function fmtUs(us: number): string {
  if (!isFinite(us) || us < 0) return "-";
  if (us < 1000) return `${Math.round(us)}µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function heatClass(us: number): string {
  if (us < 1000) return "text-neutral-500";
  if (us < 10_000) return "text-green-700";
  if (us < 100_000) return "text-amber-700";
  return "text-red-700 font-semibold";
}
