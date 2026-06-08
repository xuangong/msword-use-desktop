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
  const clock = makeClock();
  const disposed: string[] = [];
  const reg = new SessionRegistry<FakeAgent>({
    agentFactory: makeFactory(),
    maxSessions: 3,
    now: clock.now,
    onDispose: (sid) => disposed.push(sid),
  });
  reg.getOrCreate("a");
  clock.advance(1);
  reg.getOrCreate("b");
  clock.advance(1);
  reg.getOrCreate("c");
  clock.advance(1);
  // Touch a so it's most recent; b is now oldest.
  reg.getOrCreate("a");
  clock.advance(1);
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
