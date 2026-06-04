/**
 * Supervisor unit tests. Uses a mock DriverClient — no real subprocess.
 *
 * Run: bun test (from apps/agent/)
 */

import { test, expect, describe } from "bun:test";
import { Supervisor, HangError, type DriverClientLike } from "./supervisor";
import type { MethodName, Params, Result } from "@msword/rpc-schema";

/** Configurable mock: scripted behavior per call. */
class MockDriver implements DriverClientLike {
  exitResolve!: (code: number) => void;
  exitPromise: Promise<number>;
  killed = false;
  callBehaviors: Array<(method: string, drv: MockDriver) => Promise<any>> = [];
  callCount = 0;
  /** Pending resolvers for in-flight calls — flushed by kill(). */
  pendingRejecters: Array<(e: Error) => void> = [];

  constructor(behaviors: Array<(method: string, drv: MockDriver) => Promise<any>> = []) {
    this.callBehaviors = behaviors;
    this.exitPromise = new Promise((r) => (this.exitResolve = r));
  }

  async call<M extends MethodName>(method: M, _params?: Params<M>): Promise<Result<M>> {
    const idx = this.callCount++;
    const behavior = this.callBehaviors[idx] ?? (async () => ({ pong: true } as any));
    return behavior(method, this) as any;
  }

  async callRaw(method: string): Promise<unknown> {
    const idx = this.callCount++;
    const behavior = this.callBehaviors[idx] ?? (async () => ({}));
    return behavior(method, this);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    // Mimic real DriverClient: flush in-flight callers with a "driver exited"
    // rejection, so a "hang" Promise that's tied to this driver finally settles
    // and the supervisor's runWithTimeout doesn't keep the event loop alive.
    for (const reject of this.pendingRejecters) {
      reject(new Error("driver exited (code=0)"));
    }
    this.pendingRejecters = [];
    this.exitResolve(0);
  }

  exited(): Promise<number> {
    return this.exitPromise;
  }
}

/** Behavior helper: a call that hangs until the driver is killed. */
const hangUntilKilled = () => (_method: string, drv: MockDriver) =>
  new Promise((_, reject) => {
    drv.pendingRejecters.push(reject);
  });

describe("Supervisor", () => {
  test("normal call passes through and gen stays at 1", async () => {
    const drv = new MockDriver([async () => ({ pong: true })]);
    const sup = new Supervisor({
      exePath: "noop",
      factory: () => drv,
      callTimeoutMs: 1000,
    });
    const r = await sup.call("ping");
    expect(r).toEqual({ pong: true } as any);
    expect(sup.generation).toBe(1);
    expect(drv.killed).toBe(false);
  });

  test("hung call throws HangError and triggers a respawn (gen 1 → 2)", async () => {
    // First driver: hangs until killed.
    const drv1 = new MockDriver([hangUntilKilled()]);
    // Replacement driver: healthy.
    const drv2 = new MockDriver([async () => ({ pong: true })]);
    let nth = 0;
    const sup = new Supervisor({
      exePath: "noop",
      callTimeoutMs: 100,
      factory: () => (nth++ === 0 ? drv1 : drv2),
    });

    await expect(sup.call("ping")).rejects.toThrow(HangError);
    expect(drv1.killed).toBe(true);
    expect(sup.generation).toBe(2);

    const r = await sup.call("ping");
    expect(r).toEqual({ pong: true } as any);
  });

  test("onGenChange fires on every respawn with from/to/reason", async () => {
    const drv1 = new MockDriver([hangUntilKilled()]);
    const drv2 = new MockDriver([async () => ({ pong: true })]);
    let nth = 0;
    const sup = new Supervisor({
      exePath: "noop",
      callTimeoutMs: 50,
      factory: () => (nth++ === 0 ? drv1 : drv2),
    });
    const seen: Array<{ from: number; to: number; reason: string }> = [];
    sup.onGenChange = (info) => seen.push(info);

    await expect(sup.call("ping")).rejects.toThrow(HangError);
    expect(seen).toEqual([{ from: 1, to: 2, reason: "hang" }]);
  });

  test("restart throttle: more than maxRestartsPerMin hangs throws DriverError", async () => {
    // Every driver instance hangs.
    const sup = new Supervisor({
      exePath: "noop",
      callTimeoutMs: 30,
      maxRestartsPerMin: 2,
      factory: () => new MockDriver([hangUntilKilled()]),
    });

    // First hang → respawn (gen 1→2), still throws HangError to caller.
    await expect(sup.call("ping")).rejects.toThrow(HangError);
    // Second hang → respawn (gen 2→3), still throws HangError.
    await expect(sup.call("ping")).rejects.toThrow(HangError);
    // Third hang → would be gen 3→4, but we hit the per-minute cap of 2.
    // handleHang throws DriverError instead of restarting.
    await expect(sup.call("ping")).rejects.toThrow(/restarted 2 times/);
  });

  test("a delayed rejection from the hung call doesn't become unhandled", async () => {
    // Driver where kill() triggers a delayed work() rejection.
    const drv1 = new MockDriver([hangUntilKilled()]);
    const drv2 = new MockDriver([async () => ({ pong: true })]);
    let nth = 0;
    const sup = new Supervisor({
      exePath: "noop",
      callTimeoutMs: 50,
      factory: () => (nth++ === 0 ? drv1 : drv2),
    });

    // Snapshot unhandledRejection events during the call.
    const unhandled: unknown[] = [];
    const handler = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", handler);

    try {
      await expect(sup.call("ping")).rejects.toThrow(HangError);
      // Wait long enough for any delayed driver-exit rejection to fire.
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});
