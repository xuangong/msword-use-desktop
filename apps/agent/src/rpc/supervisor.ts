/**
 * Supervises a DriverClient: detects hangs via timeout, kills+restarts on hang,
 * tracks restart generations.
 *
 * Ported from `msword-use-spike/supervisor.py`. Same algorithm: race the RPC
 * call against an AbortController timeout; if timeout wins, kill and respawn.
 */

import { DriverClient, DriverError, type DriverClientOptions } from "./driverClient";
import type { MethodName, Params, Result } from "@msword/rpc-schema";

export interface SupervisorOptions extends DriverClientOptions {
  /** ms before a single call is considered hung. */
  callTimeoutMs?: number;
  /** Max restarts per minute before we give up. */
  maxRestartsPerMin?: number;
}

export class Supervisor {
  private client: DriverClient;
  private gen = 1;
  private restartHistory: number[] = [];
  private readonly opts: Required<SupervisorOptions>;

  constructor(opts: SupervisorOptions) {
    this.opts = {
      args: [],
      callTimeoutMs: 5000,
      maxRestartsPerMin: 3,
      ...opts,
    };
    this.client = new DriverClient(this.opts);
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
    try {
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      if (err instanceof HangError) {
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
    this.client.kill();
    await this.client.exited();
    this.gen++;
    this.client = new DriverClient(this.opts);
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
