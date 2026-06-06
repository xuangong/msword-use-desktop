# Phase 4a — SessionRegistry

**Goal:** `Map<sessionId, Agent>` with LRU (keep last 10) and idle-timeout dispose (30 min). Lazy: `getOrCreate(sid)` builds the Agent on first hit. Re-getting an existing sid returns the same Agent (so multi-turn follow-ups reuse pi's in-memory message history).

**Files:**
- Create: `apps/agent/src/agent/sessionRegistry.ts`
- Create: `apps/agent/src/agent/sessionRegistry.test.ts`

**Why phase 4a:** Phase 4b's `index.ts` rewrite needs `getOrCreate(sid)` to construct Agents on demand. Building it independently lets us unit-test the LRU / idle / dispose semantics without a real pi `Agent` (we inject a fake `agentFactory`).

**Sizing rationale:** 10 sessions × ~50K tokens of pi message history each = ~500K tokens of in-memory state at peak. Fine for desktop. 30-min idle bound prevents stale spotlight sessions from accumulating across a workday. Both numbers exposed as constructor options so phase 4b can tune if needed.

**Out of scope:** No persistence (per `memory/session-lifecycle.md`); no cross-session coordination; no recovery after sidecar restart.

---

### Task 4a.1: Registry implementation

**File (new):** `apps/agent/src/agent/sessionRegistry.ts`

- [ ] **Step 1: Create the file**

Create `apps/agent/src/agent/sessionRegistry.ts`:

```typescript
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
      maxSessions: 10,
      idleMs: 30 * 60 * 1000,
      now: () => Date.now(),
      onDispose: opts.onDispose,
      agentFactory: opts.agentFactory,
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
    this.entries.set(sessionId, { agent, createdAt: now, lastUsed: now });
    return agent;
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
```

- [ ] **Step 2: Syntax check**

```bash
cd apps/agent && bunx tsc --noEmit src/agent/sessionRegistry.ts 2>&1 | head -10
cd ../..
```

Expected: no errors on this file. (Loop.ts / index.ts errors still present — ignore.)

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/agent/sessionRegistry.ts
git commit -m "feat(sidecar): SessionRegistry with LRU + idle eviction"
```

---

### Task 4a.2: Unit tests

**File (new):** `apps/agent/src/agent/sessionRegistry.test.ts`

Cover: lazy creation; reuse; LRU eviction order; idle eviction; explicit dispose; disposeAll; onDispose callback fires exactly once per entry.

- [ ] **Step 1: Create the tests**

Create `apps/agent/src/agent/sessionRegistry.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { SessionRegistry } from "./sessionRegistry";

/** Fake Agent — just a tag for identity checks. */
interface FakeAgent {
  sid: string;
  serial: number;
}

function makeFactory() {
  let serial = 0;
  return (sid: string): FakeAgent => ({ sid, serial: ++serial });
}

/** Manual clock so idle-eviction tests are deterministic. */
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("getOrCreate: first call builds agent, second call returns same instance", () => {
  const reg = new SessionRegistry<FakeAgent>({ agentFactory: makeFactory() });
  const a = reg.getOrCreate("sid_X");
  const b = reg.getOrCreate("sid_X");
  expect(a).toBe(b);
  expect(a.serial).toBe(1);
  expect(reg.size).toBe(1);
});

test("getOrCreate: distinct sids get distinct agents", () => {
  const reg = new SessionRegistry<FakeAgent>({ agentFactory: makeFactory() });
  const a = reg.getOrCreate("sid_A");
  const b = reg.getOrCreate("sid_B");
  expect(a).not.toBe(b);
  expect(a.sid).toBe("sid_A");
  expect(b.sid).toBe("sid_B");
  expect(reg.size).toBe(2);
});

test("LRU: oldest unused sid is evicted when over cap", () => {
  const disposed: string[] = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    maxSessions: 3,
    onDispose: (sid) => disposed.push(sid),
  });
  reg.getOrCreate("a");
  reg.getOrCreate("b");
  reg.getOrCreate("c");
  // Touch a so it's most recent; b is now oldest.
  reg.getOrCreate("a");
  // Adding a 4th: 'b' should be evicted.
  reg.getOrCreate("d");
  expect(disposed).toEqual(["b"]);
  expect(reg.list().sort()).toEqual(["a", "c", "d"]);
});

test("idle eviction: entries unused for idleMs are dropped on next getOrCreate", () => {
  const clock = makeClock();
  const disposed: string[] = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    idleMs: 10_000,
    now: clock.now,
    onDispose: (sid) => disposed.push(sid),
  });
  reg.getOrCreate("a");
  clock.advance(5_000);
  reg.getOrCreate("b"); // a now 5s old, still alive
  clock.advance(6_000); // total: a=11s, b=6s
  // Next getOrCreate triggers eviction pass: a is past 10s, evicted.
  reg.getOrCreate("c");
  expect(disposed).toEqual(["a"]);
  expect(reg.has("a")).toBe(false);
  expect(reg.has("b")).toBe(true);
  expect(reg.has("c")).toBe(true);
});

test("idle eviction: getOrCreate on an idle entry rebuilds it", () => {
  const clock = makeClock();
  const factory = makeFactory();
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: factory,
    idleMs: 10_000,
    now: clock.now,
  });
  const first = reg.getOrCreate("a");
  clock.advance(11_000);
  const second = reg.getOrCreate("a");
  expect(second).not.toBe(first);
  expect(second.serial).toBeGreaterThan(first.serial);
});

test("dispose: explicit dispose calls onDispose and removes entry", () => {
  const disposed: Array<{ sid: string; agent: FakeAgent }> = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    onDispose: (sid, agent) => disposed.push({ sid, agent }),
  });
  const a = reg.getOrCreate("a");
  reg.dispose("a");
  expect(reg.has("a")).toBe(false);
  expect(disposed).toEqual([{ sid: "a", agent: a }]);
});

test("dispose: no-op when sid not present (does not call onDispose)", () => {
  const disposed: string[] = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    onDispose: (sid) => disposed.push(sid),
  });
  reg.dispose("never-existed");
  expect(disposed).toEqual([]);
});

test("disposeAll: drops every entry exactly once", () => {
  const disposed: string[] = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    onDispose: (sid) => disposed.push(sid),
  });
  reg.getOrCreate("a");
  reg.getOrCreate("b");
  reg.getOrCreate("c");
  reg.disposeAll();
  expect(disposed.sort()).toEqual(["a", "b", "c"]);
  expect(reg.size).toBe(0);
});

test("LRU does not evict the entry being currently created", () => {
  // Regression guard: when adding a 4th sid with cap=3, we must evict an old
  // entry BEFORE inserting, and we must not accidentally include the new
  // entry in the eviction candidate set.
  const disposed: string[] = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    maxSessions: 3,
    onDispose: (sid) => disposed.push(sid),
  });
  reg.getOrCreate("a");
  reg.getOrCreate("b");
  reg.getOrCreate("c");
  const newAgent = reg.getOrCreate("d");
  // 'a' should be evicted (oldest by lastUsed); 'd' should still be present.
  expect(disposed).toEqual(["a"]);
  expect(reg.has("d")).toBe(true);
  expect(reg.getOrCreate("d")).toBe(newAgent);
});
```

- [ ] **Step 2: Run the tests**

```bash
cd apps/agent && bun test src/agent/sessionRegistry.test.ts
cd ../..
```

Expected: 9 tests pass.

If the "LRU does not evict the entry being currently created" test fails, the implementation has the classic bug of evicting `maxSessions` items before insertion (target should be `maxSessions - 1`). Re-check the `evictToCap(this.opts.maxSessions - 1)` call in `getOrCreate`.

- [ ] **Step 3: Combined regression run**

```bash
cd apps/agent && bun test src/rpc/ src/agent/
cd ../..
```

Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/agent/sessionRegistry.test.ts
git commit -m "test(sidecar): SessionRegistry unit tests (LRU + idle eviction)"
```

---

## Phase 4a acceptance

- ✅ `apps/agent/src/agent/sessionRegistry.ts` exports `SessionRegistry<TAgent>` with `getOrCreate`, `has`, `size`, `list`, `dispose`, `disposeAll`.
- ✅ LRU evicts oldest by `lastUsed` when over cap; the just-inserted entry is never evicted.
- ✅ Idle-based eviction fires on `getOrCreate` calls.
- ✅ `onDispose` callback runs exactly once per evicted/disposed entry.
- ✅ All 9 unit tests pass.
- ✅ Phase 1/2/3 tests all still green.

If any criterion fails, fix in place — do not start phase 4b.
