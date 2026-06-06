# Phase 2 — Sidecar: simplify supervisor + drop rpc-schema

**Goal:** Replace the typed `call(method, params)` API with a single `runScript(code)`. Delete the `@msword/rpc-schema` workspace package and `scripts/gen-rpc-types.ts`. Verify the new pipe end-to-end against the phase-1 driver via a sidecar smoke test.

**Files:**
- Modify: `apps/agent/src/rpc/driverClient.ts` (drop typed methods, add `runScript`)
- Modify: `apps/agent/src/rpc/supervisor.ts` (drop `call`/`callRaw`, add `runScript`)
- Modify: `apps/agent/src/rpc/supervisor.test.ts` (rewrite mocks for new API)
- Keep unchanged: `apps/agent/src/rpc/ndjson.ts`, `ndjson.test.ts`
- Modify: `apps/agent/package.json` (drop `@msword/rpc-schema` dependency)
- Modify: `package.json` (drop `gen` script if it only generates rpc-schema)
- Delete: `packages/rpc-schema/` (entire workspace package)
- Delete: `scripts/gen-rpc-types.ts`
- Test fixture (created here): `apps/agent/src/rpc/runScript.test.ts`

**Why this is phase 2:** Phase 3+ pi tools (`exec_csharp`) need the new `runScript` API to call into the driver. The whole agent loop in phase 4 depends on a clean supervisor surface.

**Constraint:** Existing v0.3 callers of `supervisor.call(...)` from `apps/agent/src/index.ts` and `apps/agent/src/agent/loop.ts` will break compile. **That's expected.** They are deleted in phase 4. For now, leave `index.ts` broken; we'll guard the build in this phase by only running unit tests, not full project compile.

---

### Task 2.1: Rewrite `driverClient.ts` to single-action API

**File:** `apps/agent/src/rpc/driverClient.ts`

- [ ] **Step 1: Replace the file**

Open `apps/agent/src/rpc/driverClient.ts` and replace its full contents with:

```typescript
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
```

The two notable changes from v0.3:
1. No more `MethodName` / `Params` / `Result` generic types — just one shape.
2. The pending callback receives a `DriverResponse` object directly, not the raw JSON line.

- [ ] **Step 2: Run NdjsonSplitter tests to confirm we didn't break the framing layer**

```bash
cd apps/agent && bun test src/rpc/ndjson.test.ts
cd ../..
```

Expected: ndjson tests still pass (we didn't touch them).

- [ ] **Step 3: Commit (DO NOT yet run a full project build — `index.ts`/`loop.ts` will be broken until phase 4)**

```bash
git add apps/agent/src/rpc/driverClient.ts
git commit -m "refactor(sidecar): driverClient → runScript single-action API"
```

---

### Task 2.2: Rewrite `supervisor.ts` to wrap `runScript`

**File:** `apps/agent/src/rpc/supervisor.ts`

- [ ] **Step 1: Replace the file**

Open `apps/agent/src/rpc/supervisor.ts` and replace its full contents with:

```typescript
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
  runScript(code: string): Promise<DriverResponse>;
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
      factory: (o) => new DriverClient(o),
      ...opts,
    } as any;
    this.client = this.opts.factory(this.opts);
  }

  get generation(): number {
    return this.gen;
  }

  /** Run a C# script in the driver, with hang detection + restart on timeout. */
  async runScript(code: string): Promise<DriverResponse> {
    await this.ensureAlive();
    return await this.runWithTimeout(() => this.client.runScript(code));
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
```

Notable changes from v0.3:
- Public API is now just `runScript(code)` — no `call`/`callRaw`.
- `callTimeoutMs` default bumped from 5s → 10s. Roslyn first-compile is heavy (~1-2s on cold start); 5s would false-positive on first call. Subsequent calls are cached.
- `shutdown()` sends `"_shutdown"` (the magic code phase 1 added) instead of `method:"shutdown"`.

- [ ] **Step 2: Commit**

```bash
git add apps/agent/src/rpc/supervisor.ts
git commit -m "refactor(sidecar): supervisor.runScript replaces call/callRaw"
```

---

### Task 2.3: Rewrite the supervisor unit tests

**File:** `apps/agent/src/rpc/supervisor.test.ts`

The old tests use `call(method, params)`. Rewrite for the new API.

- [ ] **Step 1: Replace the test file**

Open `apps/agent/src/rpc/supervisor.test.ts` and replace its full contents with:

```typescript
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
```

- [ ] **Step 2: Run only the supervisor + ndjson tests (the rest of the project won't compile yet)**

```bash
cd apps/agent && bun test src/rpc/
cd ../..
```

Expected: all tests pass.

If you see a TS error in `src/agent/loop.ts` or `src/index.ts` — ignore it. We're scoping `bun test` to `src/rpc/` precisely because the agent loop is broken until phase 4.

If a supervisor test fails, debug it; do not proceed.

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/rpc/supervisor.test.ts
git commit -m "test(sidecar): supervisor unit tests for runScript API"
```

---

### Task 2.4: Sidecar smoke against real phase-1 driver

**File (new):** `apps/agent/src/rpc/runScript.test.ts`

This is an integration test: launches the real `WordDriver.exe` (via Supervisor), runs a couple of scripts, asserts responses. Skipped when no driver binary is present (e.g. CI without .NET) so the unit-test suite still passes everywhere.

- [ ] **Step 1: Create the test**

Create `apps/agent/src/rpc/runScript.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Supervisor } from "./supervisor";

const driverExe = process.env.MSWORD_DRIVER_EXE ?? resolve(
  import.meta.dir,
  "../../../../drivers/WordDriver/bin/Debug/net48/WordDriver.exe",
);

const driverAvailable = existsSync(driverExe);

test.skipIf(!driverAvailable)(
  "supervisor.runScript reaches a real driver and returns a structured response",
  async () => {
    const sup = new Supervisor({ exePath: driverExe, callTimeoutMs: 15_000 });
    try {
      const r = await sup.runScript("return 1 + 41;");
      expect(r.result).toBe(42);
      expect(r.error).toBeNull();
    } finally {
      await sup.shutdown();
    }
  },
);

test.skipIf(!driverAvailable)(
  "supervisor.runScript captures stdout from Print()",
  async () => {
    const sup = new Supervisor({ exePath: driverExe, callTimeoutMs: 15_000 });
    try {
      const r = await sup.runScript('Print("hello"); Print(123);');
      expect(r.error).toBeNull();
      expect(r.stdout).toContain("hello");
      expect(r.stdout).toContain("123");
    } finally {
      await sup.shutdown();
    }
  },
);

test.skipIf(!driverAvailable)(
  "supervisor.runScript reports compile errors structurally",
  async () => {
    const sup = new Supervisor({ exePath: driverExe, callTimeoutMs: 15_000 });
    try {
      const r = await sup.runScript("this is not c#;");
      expect(r.error).not.toBeNull();
      expect(r.error).toMatch(/compile_error/);
    } finally {
      await sup.shutdown();
    }
  },
);
```

`test.skipIf(!driverAvailable)` is a Bun feature — in CI without the .NET driver built, these are skipped instead of failing.

- [ ] **Step 2: Run**

```bash
cd apps/agent && bun test src/rpc/runScript.test.ts
cd ../..
```

Expected: 3 tests pass (or all skipped if `driver:build` was never run; in that case, run `bun run driver:build` from repo root and re-run).

- [ ] **Step 3: Commit**

```bash
git add apps/agent/src/rpc/runScript.test.ts
git commit -m "test(sidecar): integration smoke against real driver"
```

---

### Task 2.5: Drop the `@msword/rpc-schema` package

**Files:**
- Modify: `apps/agent/package.json` (remove `@msword/rpc-schema` dep)
- Modify: `package.json` (remove `gen` script)
- Modify: root `package.json` `workspaces` array (remove `packages/*` if `rpc-schema` is the only one)
- Delete: `packages/rpc-schema/` (entire directory)
- Delete: `scripts/gen-rpc-types.ts`

- [ ] **Step 1: Verify rpc-schema is the only thing under `packages/`**

```bash
ls packages/
```

Expected: only `rpc-schema/`. If there are other packages, narrow the `workspaces` change in step 4 below to keep them.

- [ ] **Step 2: Remove the dep from `apps/agent/package.json`**

Edit `apps/agent/package.json`. Remove the line:

```json
    "@msword/rpc-schema": "workspace:*",
```

The remaining `dependencies` block should contain only `@anthropic-ai/sdk`. Keep that line for now (phase 4 deletes it).

- [ ] **Step 3: Remove `gen` from root `package.json`**

Open root `package.json`. In `scripts`, remove the `"gen"` line and the `"gen": ` reference inside `"build"` (which currently begins with `"bun run gen && ..."`).

The new `scripts` block should be:

```json
  "scripts": {
    "driver:build": "cd drivers/WordDriver && dotnet build -c Debug",
    "driver:test": "bun run scripts/test-driver.ts",
    "dev": "cd apps/desktop && bun run tauri dev",
    "build": "bun run driver:build && cd apps/desktop && bun run tauri build",
    "spike": "drivers/WordDriver/bin/Debug/net48/WordDriver.exe"
  },
```

(Note: `driver:test` now points at the new phase-1 script `scripts/test-driver.ts`, replacing the v0.3 path `scripts/test-sidecar.ts` if it existed. The v0.3 `test-sidecar.ts` is leftover and may be deleted in phase 7.)

Also `devDependencies` should drop `json-schema-to-typescript`:

```json
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
```

- [ ] **Step 4: Remove `packages/*` from root workspaces if rpc-schema is the only one**

If `ls packages/` showed only `rpc-schema/`, edit root `package.json` `workspaces`:

Old:
```json
  "workspaces": [
    "apps/desktop",
    "apps/agent",
    "packages/*"
  ],
```

New:
```json
  "workspaces": [
    "apps/desktop",
    "apps/agent"
  ],
```

- [ ] **Step 5: Delete the package directory and gen script**

```bash
git rm -r packages/rpc-schema scripts/gen-rpc-types.ts
rmdir packages 2>/dev/null || true
```

- [ ] **Step 6: Refresh the lockfile**

```bash
bun install
```

Expected: bun reports no errors, removes the rpc-schema symlink/entry from `node_modules/@msword/`.

- [ ] **Step 7: Re-run rpc tests**

```bash
cd apps/agent && bun test src/rpc/
cd ../..
```

Expected: still pass.

- [ ] **Step 8: Commit**

```bash
git add apps/agent/package.json package.json bun.lock
# Stage the deletions:
git status --porcelain | grep '^ D' | awk '{print $2}' | xargs -r git add
git commit -m "chore: drop @msword/rpc-schema package and gen script"
```

---

## Phase 2 acceptance

- ✅ `apps/agent/src/rpc/driverClient.ts` exposes only `runScript`, `kill`, `exited`, `isClosed`.
- ✅ `apps/agent/src/rpc/supervisor.ts` exposes only `runScript`, `restart`, `shutdown`, `onGenChange`, `generation`.
- ✅ `apps/agent/src/rpc/supervisor.test.ts` rewritten and passes.
- ✅ `apps/agent/src/rpc/runScript.test.ts` integration test passes (or skipped if driver not built).
- ✅ `packages/rpc-schema/` and `scripts/gen-rpc-types.ts` deleted.
- ✅ `apps/agent/package.json` no longer depends on `@msword/rpc-schema`.
- ✅ Root `package.json` no longer has `gen` script.
- ✅ `bun install` clean.
- ✅ Phase-1 driver smoke (`bun run scripts/test-driver.ts`) still passes — we didn't break anything driver-side.

**Known broken** at end of phase 2 (intentional): `apps/agent/src/index.ts` and `apps/agent/src/agent/loop.ts` no longer compile. They reference `supervisor.call(...)` and `MethodName` types that no longer exist. Phase 4 deletes them. Do not attempt `bun run dev` or full project compile until phase 4 completes.

If any of the acceptance criteria is missing, do not start phase 3.
