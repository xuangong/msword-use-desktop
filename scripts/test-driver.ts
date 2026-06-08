/**
 * Phase 1 driver smoke test.
 *
 * Spawns WordDriver.exe, pipes a few requests, checks responses.
 * Does NOT need Word running — every script here only uses System types
 * (no `Doc` / `App` access). Word-aware tests come at e2e in phase 7.
 *
 * Run from repo root:
 *   bun run scripts/test-driver.ts
 *
 * Exit 0 on all-pass, 1 on any failure. Output is human-readable.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const driverExe = process.env.MSWORD_DRIVER_EXE ?? resolve(
  "drivers/WordDriver/bin/Debug/net48/WordDriver.exe"
);

interface DriverResp {
  id: string | null;
  result: unknown;
  stdout: string;
  error: string | null;
}

async function runFixtures(): Promise<number> {
  const child = spawn(driverExe, [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const responses = new Map<string, DriverResp>();
  let resolveDone: ((v: void) => void) | null = null;

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const r = JSON.parse(line) as DriverResp;
        responses.set(String(r.id), r);
      } catch {
        // ignore
      }
    }
  });

  function send(id: string, code: string): Promise<DriverResp> {
    child.stdin.write(JSON.stringify({ id, code }) + "\n");
    return new Promise(async (resolveResp) => {
      for (let i = 0; i < 50; i++) {
        if (responses.has(id)) return resolveResp(responses.get(id)!);
        await delay(100);
      }
      resolveResp({ id, result: null, stdout: "", error: "timeout_in_test" });
    });
  }

  let failures = 0;
  function expect(name: string, ok: boolean, detail = "") {
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures++;
  }

  // Wait for driver ready (it writes [driver] ready to stderr; we just delay
  // and rely on the first request waking it up).
  await delay(200);

  // 1. Trivial integer return
  let r = await send("t1", "return 1 + 2;");
  expect("t1: integer return", r.result === 3 && r.error === null, JSON.stringify(r));

  // 2. Compile error
  r = await send("t2", "this is not c#;");
  expect(
    "t2: compile error reported",
    r.error !== null && r.error.startsWith("compile_error"),
    r.error ?? "(no error)"
  );

  // 3. Runtime error (divide by zero)
  r = await send("t3", "int x = 0; return 1 / x;");
  expect(
    "t3: runtime error reported",
    r.error !== null && r.error.startsWith("runtime_error"),
    r.error ?? "(no error)"
  );

  // 4. Print -> stdout
  r = await send("t4", 'Print("hello"); Print(42);');
  expect(
    "t4: stdout captured",
    r.error === null && r.stdout.includes("hello") && r.stdout.includes("42"),
    JSON.stringify(r.stdout)
  );

  // 5. Empty code rejected
  r = await send("t5", "");
  expect(
    "t5: empty_code error",
    r.error === "empty_code",
    r.error ?? "(no error)"
  );

  // 6. Cooperative shutdown
  r = await send("t6", "_shutdown");
  expect("t6: shutdown returns bye:true", (r.result as any)?.bye === true && r.error === null, JSON.stringify(r));

  // Wait for driver to actually exit on its own.
  // Guard against the race where the child has already exited before this
  // listener is attached — in that case `child.on("exit")` never fires.
  await new Promise<void>((res) => {
    if (child.exitCode !== null) return res();
    child.on("exit", () => res());
  });

  return failures;
}

const failures = await runFixtures();
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll driver smoke checks passed.");
process.exit(0);
