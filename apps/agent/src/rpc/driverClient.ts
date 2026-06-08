/**
 * Single-action stdio client for the .NET WordDriver subprocess.
 *
 * Each call writes one JSON line {id, code} to the driver's stdin and waits
 * for the matching JSON line {id, result, stdout, error} on stdout. Hang
 * detection / restart is the Supervisor's responsibility.
 *
 * One DriverClient owns one child process. If the child dies, build a fresh
 * DriverClient.
 */

import { NdjsonSplitter } from "./ndjson";

export interface DriverClientOptions {
  exePath: string;
  /** Args forwarded to the driver (unused today; reserved). */
  args?: string[];
}

export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverError";
  }
}

export interface DriverResponse {
  id: string;
  result: unknown;
  stdout: string;
  error: string | null;
}

export class DriverClient {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<string, (resp: DriverResponse) => void>();
  private closed = false;
  private exitPromise: Promise<number>;

  constructor(opts: DriverClientOptions) {
    this.proc = Bun.spawn({
      cmd: [opts.exePath, ...(opts.args ?? [])],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.exitPromise = this.proc.exited.then((code) => {
      this.closed = true;
      // Reject all in-flight callers so they don't hang forever after the
      // child dies (kill, crash, Word killed externally, etc).
      for (const [id, cb] of this.pending) {
        cb({
          id,
          result: null,
          stdout: "",
          error: `driver exited (code=${code})`,
        });
      }
      this.pending.clear();
      return code;
    });
    void this.pump();
  }

  private async pump() {
    const reader = this.proc.stdout.getReader();
    const splitter = new NdjsonSplitter();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const line of splitter.push(value)) {
        let parsed: DriverResponse;
        try {
          parsed = JSON.parse(line) as DriverResponse;
        } catch {
          continue;
        }
        const cb = parsed.id ? this.pending.get(parsed.id) : null;
        if (cb) {
          this.pending.delete(parsed.id);
          cb(parsed);
        }
      }
    }
  }

  /** Run a C# script in the live Word session. */
  async runScript(code: string): Promise<DriverResponse> {
    if (this.closed) {
      throw new DriverError("driver already exited");
    }
    const id = String(this.nextId++);
    const req = JSON.stringify({ id, code });
    return await new Promise<DriverResponse>((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(req + "\n");
      void this.proc.stdin.flush?.();
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  kill(): void {
    if (!this.closed) {
      try {
        this.proc.kill();
      } catch {
        /* best-effort */
      }
    }
  }

  exited(): Promise<number> {
    return this.exitPromise;
  }
}
