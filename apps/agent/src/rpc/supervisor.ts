/**
 * Supervises a DriverClient: detects hangs via timeout, kills+restarts on hang,
 * tracks restart generations.
 *
 * Same algorithm as v0.3 but the wrapped API is a single `runScript(code)`
 * instead of `call(method, params)`.
 */

import {
  DriverClient,
  DriverError,
  type DriverClientOptions,
  type DriverResponse,
} from "./driverClient";

/**
 * Minimal DriverClient surface the Supervisor uses. Real DriverClient
 * satisfies this; tests pass a mock to avoid spawning a real driver.
 */
export interface DriverClientLike {
  runScript(code: string, triggerHwnd?: number): Promise<DriverResponse>;
  kill(): void;
  exited(): Promise<number>;
  isClosed?(): boolean;
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
  private readonly opts: Required<Omit<SupervisorOptions, "factory">> & {
    factory: NonNullable<SupervisorOptions["factory"]>;
  };

  constructor(opts: SupervisorOptions) {
    this.opts = {
      args: [],
      callTimeoutMs: 10_000,
      maxRestartsPerMin: 3,
      factory: (o: DriverClientOptions) => new DriverClient(o),
      ...opts,
    } as any;
    this.client = this.opts.factory(this.opts);
  }

  get generation(): number {
    return this.gen;
  }

  /** Run a C# script in the driver, with hang detection + restart on timeout.
   *  triggerHwnd pins which Word document the script's Doc/App globals point
   *  at. 0 / undefined falls back to App.ActiveDocument. */
  async runScript(code: string, triggerHwnd: number = 0): Promise<DriverResponse> {
    await this.ensureAlive();
    return await this.runWithTimeout(() => this.client.runScript(code, triggerHwnd));
  }

  /**
   * Self-healing path: if the underlying child died (crashed, killed, etc),
   * respawn before serving the next call. Distinct from hang handling, which
   * goes through handleHang's per-minute throttle.
   */
  private async ensureAlive(): Promise<void> {
    if (this.client.isClosed?.()) {
      await this.restart("died");
    }
  }

  private async runWithTimeout(fn: () => Promise<DriverResponse>): Promise<DriverResponse> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HangError()), this.opts.callTimeoutMs);
    });
    const work = fn();
    // Swallow delayed rejection from the abandoned work() promise so it
    // doesn't surface as an unhandledRejection.
    work.catch(() => {});
    try {
      return await Promise.race([work, timeout]);
    } catch (err) {
      if (err instanceof HangError) {
        // Kill so the in-flight work() promise resolves promptly with a
        // "driver exited" DriverResponse (which we then ignore).
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
    await this.restart("hang");
  }

  private trimRestartHistory() {
    const cutoff = Date.now() - 60_000;
    this.restartHistory = this.restartHistory.filter((t) => t > cutoff);
  }

  async restart(reason = "manual") {
    const oldGen = this.gen;
    this.client.kill();
    await this.client.exited();
    this.gen++;
    this.client = this.opts.factory(this.opts);
    this.onGenChange?.({ from: oldGen, to: this.gen, reason });
  }

  /** UI hook for showing restart toasts. */
  onGenChange?: (info: { from: number; to: number; reason: string }) => void;

  async shutdown() {
    try {
      await this.runWithTimeout(() => this.client.runScript("_shutdown"));
    } catch {
      /* expected — driver exits right after replying */
    }
    this.client.kill();
  }
}

export class HangError extends Error {
  constructor() {
    super(`driver call timed out`);
    this.name = "HangError";
  }
}
