/**
 * Supervises a DriverClient: detects hangs via timeout, kills+restarts on hang,
 * tracks restart generations.
 *
 * Ported from `msword-use-spike/supervisor.py`. Same algorithm: race the RPC
 * call against an AbortController timeout; if timeout wins, kill and respawn.
 */

import { DriverClient, DriverError, type DriverClientOptions } from "./driverClient";
import type { MethodName, Params, Result } from "@msword/rpc-schema";

/**
 * Minimal DriverClient surface the Supervisor uses. Real DriverClient
 * satisfies this; tests pass a mock to avoid spawning a real driver.
 */
export interface DriverClientLike {
  call<M extends MethodName>(method: M, params?: Params<M>): Promise<Result<M>>;
  callRaw(method: string, params?: unknown): Promise<unknown>;
  kill(): void;
  exited(): Promise<number>;
}

export interface SupervisorOptions extends DriverClientOptions {
  /** ms before a single call is considered hung. */
  callTimeoutMs?: number;
  /** Max restarts per minute before we give up. */
  maxRestartsPerMin?: number;
  /** Test seam: override how new driver clients are constructed. */
  factory?: (opts: DriverClientOptions) => DriverClientLike;
}

export class Supervisor {
  private client: DriverClientLike;
  private gen = 1;
  private restartHistory: number[] = [];
  private readonly opts: Required<Omit<SupervisorOptions, "factory">> & { factory: NonNullable<SupervisorOptions["factory"]> };

  constructor(opts: SupervisorOptions) {
    this.opts = {
      args: [],
      callTimeoutMs: 5000,
      maxRestartsPerMin: 3,
      factory: (o) => new DriverClient(o),
      ...opts,
    } as any;
    this.client = this.opts.factory(this.opts);
  }

  get generation(): number {
    return this.gen;
  }

  async call<M extends MethodName>(method: M, params?: Params<M>): Promise<Result<M>> {
    return await this.runWithTimeout(() => this.client.call(method, params), method);
  }

  async callRaw(method: string, params?: unknown): Promise<unknown> {
    return await this.runWithTimeout(() => this.client.callRaw(method, params), method);
  }

  private async runWithTimeout<T>(fn: () => Promise<T>, method: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HangError(method)), this.opts.callTimeoutMs);
    });
    const work = fn();
    // P1: if the timeout wins, the in-flight work() promise will still
    // resolve/reject later (when client.kill→exited→pending callback fires).
    // Swallow that delayed rejection so it doesn't become an
    // unhandledRejection — the supervisor already turned the hang into a
    // HangError for the caller.
    work.catch(() => {});
    try {
      return await Promise.race([work, timeout]);
    } catch (err) {
      if (err instanceof HangError) {
        // Kill the driver immediately so the in-flight `work` resolves with
        // "driver exited" rather than continuing to take time before the
        // user sees the failure. handleHang then respawns with throttling.
        this.client.kill();
        await this.handleHang();
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleHang() {
    this.trimRestartHistory();
    if (this.restartHistory.length >= this.opts.maxRestartsPerMin) {
      throw new DriverError(
        `driver restarted ${this.opts.maxRestartsPerMin} times in the last minute — giving up`,
      );
    }
    this.restartHistory.push(Date.now());
    await this.restart();
  }

  private trimRestartHistory() {
    const cutoff = Date.now() - 60_000;
    this.restartHistory = this.restartHistory.filter((t) => t > cutoff);
  }

  async restart() {
    const oldGen = this.gen;
    // client.kill() is idempotent; runWithTimeout already called it for the
    // hang path, but explicit restart() callers (tests, manual recovery) rely
    // on us doing it here.
    this.client.kill();
    await this.client.exited();
    this.gen++;
    this.client = this.opts.factory(this.opts);
    this.onGenChange?.({ from: oldGen, to: this.gen, reason: "hang" });
  }

  /** Caller can hook into generation changes to surface restart events to the UI. */
  onGenChange?: (info: { from: number; to: number; reason: string }) => void;

  async shutdown() {
    try {
      await this.runWithTimeout(() => this.client.callRaw("shutdown"), "shutdown");
    } catch { /* expected — process exits right after */ }
    this.client.kill();
  }
}

export class HangError extends Error {
  constructor(public readonly method: string) {
    super(`call timed out: ${method}`);
    this.name = "HangError";
  }
}
