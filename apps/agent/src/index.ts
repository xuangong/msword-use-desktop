/**
 * Bun sidecar entry point.
 *
 * Receives NDJSON requests from Tauri on stdin, dispatches to one of:
 *
 *   {"kind":"raw","id":"<str>","method":"<str>","params":{...}}
 *     — pass-through RPC into the WordDriver. Used by the dev UI's
 *       "raw command" mode and by the test harness.
 *
 *   {"kind":"chat","id":"<str>","message":"<str>"}
 *     — runs one agent turn; streams events back as
 *       {"id":"<str>","kind":"agent_event","event":{...}}
 *
 * Old-style requests without `kind` are treated as `raw` for backwards compat
 * with the W1 test harness.
 */

import { Supervisor } from "./rpc/supervisor";
import { runAgentTurn } from "./agent/loop";
import { resolve } from "node:path";

const driverExe = process.env.MSWORD_DRIVER_EXE
  ?? resolve(import.meta.dir, "../../../drivers/WordDriver/bin/Debug/net48/WordDriver.exe");

const supervisor = new Supervisor({ exePath: driverExe, callTimeoutMs: 10_000 });

function write(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

write({ ready: true, driverExe, gen: supervisor.generation });

// Read NDJSON from stdin.
let buf = "";
const decoder = new TextDecoder("utf-8");

for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    // Fire-and-forget — async handler emits its own replies.
    handleLine(line);
  }
}

async function handleLine(line: string) {
  let req: any;
  try { req = JSON.parse(line); }
  catch (err) {
    write({ id: null, error: `parse_error: ${err}` });
    return;
  }

  const id = req.id ?? null;

  // chat mode: run an agent turn, stream events
  if (req.kind === "chat") {
    const message = req.message;
    if (typeof message !== "string") {
      write({ id, kind: "agent_event", event: { kind: "error", error: "missing message" } });
      return;
    }
    try {
      for await (const ev of runAgentTurn(message, supervisor)) {
        write({ id, kind: "agent_event", event: ev, gen: supervisor.generation });
      }
    } catch (err: any) {
      write({
        id,
        kind: "agent_event",
        event: { kind: "error", error: String(err?.message ?? err) },
        gen: supervisor.generation,
      });
    }
    return;
  }

  // raw mode (default): pass-through into the driver
  const method = req.method;
  if (typeof method !== "string") {
    write({ id, error: "missing method" });
    return;
  }
  try {
    const result = method.startsWith("_")
      ? await supervisor.callRaw(method, req.params)
      : await supervisor.call(method, req.params);
    write({ id, result, error: null, gen: supervisor.generation });
  } catch (err: any) {
    write({ id, result: null, error: String(err?.message ?? err), gen: supervisor.generation });
  }
}
