/**
 * SessionRegistry — owns the Map<sessionId, Agent> with LRU + idle eviction.
 *
 * Design:
 *   - getOrCreate(sid) is lazy. First call for a sid runs `agentFactory(sid)`.
 *   - Each access updates `lastUsed`. eviction pass on every getOrCreate.
 *   - LRU bound: at most `maxSessions` entries. Oldest by `lastUsed` evicted first.
 *   - Idle bound: entries unused for `idleMs` are evicted regardless of cap.
 *   - dispose(sid) is explicit (e.g., user closes a chat); also called by eviction.
 *
 * Notes:
 *   - `dispose` is fire-and-forget. If the Agent has in-flight work it's the caller's
 *     job to abort it first (see index.ts global FIFO — sessions never have
 *     concurrent work, so an idle-dispose can never race a running prompt).
 *   - We export the constructor options as a type so phase 4b can tune.
 */

export interface SessionEntry<TAgent> {
  agent: TAgent;
  createdAt: number;
  lastUsed: number;
  /** HWND of the Word window the agent is pinned to. Refreshed on every
   *  prompt/steer so subsequent exec_csharp calls hit the right document
   *  even if the user has multiple Word docs open. 0 = use ActiveDocument. */
  triggerHwnd: number;
}

export interface SessionRegistryOptions<TAgent> {
  /** Build a new Agent for a freshly-seen sid. Called at most once per sid. */
  agentFactory: (sessionId: string) => TAgent;
  /** Called when an Agent is evicted (LRU or idle) or explicitly disposed. */
  onDispose?: (sessionId: string, agent: TAgent) => void;
  /** Max concurrent sessions before LRU kicks in. Default 10. */
  maxSessions?: number;
  /** Idle ms after which an Agent is evicted on next getOrCreate. Default 30 min. */
  idleMs?: number;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
}

export class SessionRegistry<TAgent> {
  private readonly entries = new Map<string, SessionEntry<TAgent>>();
  private readonly opts: Required<Omit<SessionRegistryOptions<TAgent>, "onDispose">> & {
    onDispose: SessionRegistryOptions<TAgent>["onDispose"];
  };

  constructor(opts: SessionRegistryOptions<TAgent>) {
    this.opts = {
      agentFactory: opts.agentFactory,
      onDispose: opts.onDispose,
      maxSessions: opts.maxSessions ?? 10,
      idleMs: opts.idleMs ?? 30 * 60 * 1000,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** Return the Agent for `sid`, building it if absent. Updates lastUsed. */
  getOrCreate(sessionId: string): TAgent {
    this.evictIdle();
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.lastUsed = this.opts.now();
      return existing.agent;
    }
    this.evictToCap(this.opts.maxSessions - 1);
    const now = this.opts.now();
    const agent = this.opts.agentFactory(sessionId);
    this.entries.set(sessionId, { agent, createdAt: now, lastUsed: now, triggerHwnd: 0 });
    return agent;
  }

  /** Update the Word HWND this session's agent should pin against on the
   *  next exec_csharp. Called on every chat / steer with a hwnd in the
   *  payload. No-op if the session doesn't exist (caller should
   *  getOrCreate first). */
  setTriggerHwnd(sessionId: string, hwnd: number): void {
    const entry = this.entries.get(sessionId);
    if (entry) entry.triggerHwnd = hwnd;
  }

  /** Return the pinned HWND for the given session, or 0 if none /
   *  session unknown. */
  getTriggerHwnd(sessionId: string): number {
    return this.entries.get(sessionId)?.triggerHwnd ?? 0;
  }

  /** True iff this sid currently has an Agent in the registry. */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Number of currently-resident Agents. */
  get size(): number {
    return this.entries.size;
  }

  /** List of sids currently resident, in insertion order. */
  list(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Iterate over (sid, agent) pairs without exposing internals. */
  forEach(fn: (sessionId: string, agent: TAgent) => void): void {
    for (const [sid, entry] of this.entries) {
      fn(sid, entry.agent);
    }
  }

  /** Drop a specific session and invoke onDispose. No-op if absent. */
  dispose(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.opts.onDispose?.(sessionId, entry.agent);
  }

  /** Drop everything. Useful for sidecar shutdown. */
  disposeAll(): void {
    for (const sid of Array.from(this.entries.keys())) {
      this.dispose(sid);
    }
  }

  private evictIdle(): void {
    const cutoff = this.opts.now() - this.opts.idleMs;
    for (const [sid, entry] of this.entries) {
      if (entry.lastUsed < cutoff) {
        this.dispose(sid);
      }
    }
  }

  private evictToCap(targetSize: number): void {
    if (this.entries.size <= targetSize) return;
    // Build a sorted-by-lastUsed snapshot. Smallest (oldest) first.
    const sorted = Array.from(this.entries.entries()).sort(
      ([, a], [, b]) => a.lastUsed - b.lastUsed,
    );
    while (this.entries.size > targetSize && sorted.length > 0) {
      const [sid] = sorted.shift()!;
      this.dispose(sid);
    }
  }
}
