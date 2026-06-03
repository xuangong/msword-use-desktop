/**
 * Bun sidecar entry point.
 *
 * Listens on stdin (NDJSON, fed by Tauri). Forwards typed RPC calls to the
 * WordDriver subprocess via Supervisor. Writes responses to stdout.
 *
 * Wire format (from Tauri):
 *   {"id":"<str>","method":"<str>","params":{...}}
 *
 * Wire format (to Tauri):
 *   {"id":"<str>","result":{...},"error":null}
 *   {"id":"<str>","error":"<msg>"}
 *
 * Today this is a thin pass-through — week 2 adds the agent loop here.
 * Inputs starting with `_` are dev escape hatches (e.g. _freeze).
 */

import { Supervisor } from "./rpc/supervisor";
import { resolve } from "node:path";

// In dev, point at the dotnet build output. In production this exe is bundled
// next to the Bun sidecar via the Tauri externalBin mechanism, so use a
// path-relative-to-self lookup.
const driverExe = process.env.MSWORD_DRIVER_EXE
  ?? resolve(import.meta.dir, "../../../drivers/WordDriver/bin/Debug/net48/WordDriver.exe");

const supervisor = new Supervisor({ exePath: driverExe, callTimeoutMs: 5000 });

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
    handleLine(line);
  }
}

async function handleLine(line: string) {
  let req: { id?: string; method?: string; params?: unknown };
  try { req = JSON.parse(line); }
  catch (err) {
    write({ id: null, error: `parse_error: ${err}` });
    return;
  }

  if (!req.method) {
    write({ id: req.id ?? null, error: "missing method" });
    return;
  }

  try {
    const result = req.method.startsWith("_")
      ? await supervisor.callRaw(req.method, req.params)
      : await supervisor.call(req.method as any, req.params as any);
    write({ id: req.id ?? null, result, error: null, gen: supervisor.generation });
  } catch (err: any) {
    write({ id: req.id ?? null, result: null, error: String(err?.message ?? err), gen: supervisor.generation });
  }
}
