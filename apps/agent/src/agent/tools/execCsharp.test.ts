import { test, expect } from "bun:test";
import { makeExecCsharpTool } from "./execCsharp";
import { HangError, type Supervisor } from "../../rpc/supervisor";
import type { DriverResponse } from "../../rpc/driverClient";

/**
 * Minimal Supervisor stub. Only implements what the tool uses (runScript).
 * Casting through `unknown` because the real Supervisor has many other methods.
 */
function stubSupervisor(impl: (code: string) => Promise<DriverResponse>): Supervisor {
  return { runScript: impl } as unknown as Supervisor;
}

test("exec_csharp: success — surfaces result and stdout", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async (code) => ({
      id: "1",
      result: 42,
      stdout: "hello\n",
      error: null,
    })),
  );
  const r = await tool.execute("tc1", { code: "return 1+41;" });
  expect(r.details.result).toBe(42);
  expect(r.details.error).toBeNull();
  expect(r.details.hung).toBe(false);
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("result: 42");
  expect(text).toContain("stdout:\nhello");
});

test("exec_csharp: compile_error surfaces as text the LLM can read", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => ({
      id: "1",
      result: null,
      stdout: "",
      error: "compile_error: ; expected",
    })),
  );
  const r = await tool.execute("tc2", { code: "this is bad" });
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("error: compile_error: ; expected");
  expect(r.details.error).toBe("compile_error: ; expected");
});

test("exec_csharp: HangError becomes error result, not thrown", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => {
      throw new HangError();
    }),
  );
  const r = await tool.execute("tc3", { code: "while(true){}" });
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("error: driver hung");
  expect(r.details.hung).toBe(true);
  expect(r.details.error).toBe("hang");
});

test("exec_csharp: empty code returns error without calling supervisor", async () => {
  let called = false;
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => {
      called = true;
      return { id: "1", result: null, stdout: "", error: null };
    }),
  );
  const r = await tool.execute("tc4", { code: "   " });
  expect(called).toBe(false);
  expect(r.details.error).toBe("empty_code");
});

test("exec_csharp: non-HangError errors are re-thrown for pi to mark as tool failure", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => {
      throw new Error("driver restarted 3 times in the last minute — giving up");
    }),
  );
  await expect(tool.execute("tc5", { code: "anything" })).rejects.toThrow(
    /restarted 3 times/,
  );
});

test("exec_csharp: undefined result is rendered as 'undefined' (not omitted)", async () => {
  const tool = makeExecCsharpTool(
    stubSupervisor(async () => ({
      id: "1",
      result: undefined,
      stdout: "",
      error: null,
    })),
  );
  const r = await tool.execute("tc6", { code: 'Print("hi");' });
  const text = (r.content[0] as any).text as string;
  expect(text).toContain("result: undefined");
});
