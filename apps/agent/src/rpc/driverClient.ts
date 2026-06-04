/**
 * NDJSON-over-stdio client for the .NET WordDriver subprocess.
 *
 * Each call writes one JSON line to the driver's stdin and waits for the
 * matching JSON line on stdout. Hang detection (timeout) is the caller's
 * responsibility — see Supervisor for the wrapping retry/restart logic.
 *
 * One DriverClient owns one child process. If the child dies or the caller
 * gives up on a hang, build a fresh DriverClient.
 */

import type { MethodName, Params, Result, RpcResponse } from "@msword/rpc-schema";
import { NdjsonSplitter } from "./ndjson";

export interface DriverClientOptions {
  exePath: string;
  /** Args forwarded to the driver (unused today; reserved). */
  args?: string[];
}

export class DriverError extends Error {
  constructor(message: string, public readonly method?: string) {
    super(message);
    this.name = "DriverError";
  }
}

export class DriverClient {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private pending = new Map<string, (line: string) => void>();
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
      // Reject all pending responses so callers don't hang forever.
      for (const [id, resolve] of this.pending) {
        resolve(JSON.stringify({ id, result: null, error: `driver exited (code=${code})` }));
      }
      this.pending.clear();
      return code;
    });

    // Stream stdout, split on newlines, dispatch to pending callers.
    void this.pump();
  }

  private async pump() {
    const reader = this.proc.stdout.getReader();
    const splitter = new NdjsonSplitter();
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const line of splitter.push(value)) {
        let parsed: RpcResponse;
        try { parsed = JSON.parse(line); }
        catch { continue; }
        const cb = parsed.id ? this.pending.get(parsed.id) : null;
        if (cb) {
          this.pending.delete(parsed.id!);
          cb(line);
        }
      }
    }
  }

  async call<M extends MethodName>(method: M, params?: Params<M>): Promise<Result<M>> {
    if (this.closed) throw new DriverError("driver already exited", method);

    const id = String(this.nextId++);
    const req = JSON.stringify({ id, method, params: params ?? {} });

    const responseLine = await new Promise<string>((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(req + "\n");
    });

    const resp = JSON.parse(responseLine) as RpcResponse<M>;
    if (resp.error) throw new DriverError(resp.error, method);
    return resp.result as Result<M>;
  }

  /** Send a raw method (for ad-hoc methods not in the typed schema, e.g. _freeze). */
  async callRaw(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new DriverError("driver already exited", method);
    const id = String(this.nextId++);
    const req = JSON.stringify({ id, method, params: params ?? {} });
    const responseLine = await new Promise<string>((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(req + "\n");
    });
    const resp = JSON.parse(responseLine);
    if (resp.error) throw new DriverError(resp.error, method);
    return resp.result;
  }

  kill() {
    if (!this.closed) {
      try { this.proc.kill(); } catch { /* already gone */ }
    }
  }

  exited(): Promise<number> {
    return this.exitPromise;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
