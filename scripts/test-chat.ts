/**
 * Test the chat (agent) path of the Bun sidecar.
 *
 * Spawns sidecar with API key, sends a chat message that should trigger
 * polish_text, watches the streamed agent events. Word must be running
 * with a doc open + a selection.
 */

import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SIDECAR = resolve(REPO, "apps/agent/src/index.ts");

const child = Bun.spawn({
  cmd: ["bun", "run", SIDECAR],
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});

const decoder = new TextDecoder();
let buf = "";

(async () => {
  const reader = child.stdout.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          const obj = JSON.parse(line);
          if (obj.kind === "agent_event") {
            const e = obj.event;
            if (e.kind === "text_delta") process.stdout.write(e.text);
            else console.log("\n[event]", JSON.stringify(e).slice(0, 400));
          } else {
            console.log("[reply]", line.slice(0, 500));
          }
        } catch {
          console.log("[raw]", line.slice(0, 500));
        }
      }
    }
  }
})();

(async () => {
  const reader = child.stderr.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    process.stderr.write("[bun]" + decoder.decode(value));
  }
})();

await Bun.sleep(800); // wait for sidecar ready

console.log("\n=== sending chat message ===");
child.stdin.write(
  JSON.stringify({
    kind: "chat",
    id: "chat-1",
    message: "请把当前选中的文字改成公文风格",
  }) + "\n",
);

await Bun.sleep(30_000); // give it 30s to round-trip LLM + Word

console.log("\n=== killing sidecar ===");
child.kill();
await child.exited;
