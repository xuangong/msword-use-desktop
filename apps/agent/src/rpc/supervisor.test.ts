import { test, expect } from "bun:test";
import { Supervisor, HangError, type DriverClientLike } from "./supervisor";
import type { DriverResponse } from "./driverClient";

/** A scriptable mock that replaces the real driver process. */
class MockDriver implements DriverClientLike {
  public runScriptImpl: (code: string) => Promise<DriverResponse>;
  public killed = false;
  private exitResolve: (code: number) => void = () => {};
  private exitPromise: Promise<number>;

  constructor(behavior?: (code: string) => Promise<DriverResponse>) {
    this.runScriptImpl = behavior ?? (async () => ({
      id: "1",
      result: { ok: true },
      stdout: "",
      error: null,
    }));
    this.exitPromise = new Promise((res) => (this.exitResolve = res));
  }
  async runScript(code: string) {
    if (this.killed) throw new Error("dead");
    return this.runScriptImpl(code);
  }
  kill() {
    if (!this.killed) {
      this.killed = true;
      this.exitResolve(143);
    }
  }
  exited() {
    return this.exitPromise;
  }
  isClosed() {
    return this.killed;
  }
}

test("runScript: forwards code and returns result", async () => {
  let received = "";
  const mock = new MockDriver(async (code) => {
    received = code;
    return { id: "1", result: 42, stdout: "", error: null };
  });
  const sup = new Supervisor({
    exePath: "/dev/null",
    factory: () => mock,
  });
  const r = await sup.runScript("return 42;");
  expect(received).toBe("return 42;");
  expect(r.result).toBe(42);
  expect(r.error).toBeNull();
});

test("runScript: throws HangError when call exceeds timeout, then respawns", async () => {
  let factoryCalls = 0;
  const mocks: MockDriver[] = [];
  const sup = new Supervisor({
    exePath: "/dev/null",
    callTimeoutMs: 50,
    factory: () => {
      factoryCalls++;
      const m = new MockDriver(
        () => new Promise<DriverResponse>(() => {}), // hangs forever
      );
      mocks.push(m);
      return m;
    },
  });

  expect(factoryCalls).toBe(1);
  await expect(sup.runScript("while(true){}")).rejects.toBeInstanceOf(HangError);
  // After the hang, supervisor should have killed mock 1 and built mock 2.
  expect(mocks[0]!.killed).toBe(true);
  expect(factoryCalls).toBe(2);
  expect(sup.generation).toBe(2);
});

test("ensureAlive respawns after external death", async () => {
  let factoryCalls = 0;
  const sup = new Supervisor({
    exePath: "/dev/null",
    factory: () => {
      factoryCalls++;
      return new MockDriver();
    },
  });
  // Simulate the child dying out from under us.
  (sup as any).client.kill();
  // Next runScript should detect closed and rebuild.
  await sup.runScript("return 1;");
  expect(factoryCalls).toBe(2);
  expect(sup.generation).toBe(2);
});

test("hang restart budget: throws DriverError after maxRestartsPerMin", async () => {
  const sup = new Supervisor({
    exePath: "/dev/null",
    callTimeoutMs: 20,
    maxRestartsPerMin: 2,
    factory: () => new MockDriver(() => new Promise<DriverResponse>(() => {})),
  });

  await expect(sup.runScript("hang1")).rejects.toBeInstanceOf(HangError);
  await expect(sup.runScript("hang2")).rejects.toBeInstanceOf(HangError);
  // 3rd hang exceeds budget → DriverError, NOT HangError.
  await expect(sup.runScript("hang3")).rejects.toThrow(/giving up/);
});

test("onGenChange fires with reason 'hang'", async () => {
  const events: Array<{ from: number; to: number; reason: string }> = [];
  const sup = new Supervisor({
    exePath: "/dev/null",
    callTimeoutMs: 20,
    factory: () => new MockDriver(() => new Promise<DriverResponse>(() => {})),
  });
  sup.onGenChange = (info) => events.push(info);

  await expect(sup.runScript("hang")).rejects.toBeInstanceOf(HangError);
  expect(events).toEqual([{ from: 1, to: 2, reason: "hang" }]);
});
