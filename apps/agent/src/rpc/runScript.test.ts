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
