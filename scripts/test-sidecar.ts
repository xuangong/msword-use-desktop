/**
 * Smoke test: spawn the Bun sidecar, send a few RPC commands, verify replies.
 * Run with `bun run scripts/test-sidecar.ts`.
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

const replies: string[] = [];
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
      if (line) replies.push(line);
    }
  }
})();

// Stream stderr so we can see [driver] ready etc.
(async () => {
  const reader = child.stderr.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    process.stderr.write(decoder.decode(value));
  }
})();

// Wait briefly for sidecar's `ready` line.
await Bun.sleep(500);

const cmds = [
  { id: "1", method: "ping" },
  { id: "2", method: "attach" },
  { id: "3", method: "observe.outline" },
];
for (const c of cmds) {
  child.stdin.write(JSON.stringify(c) + "\n");
}

// Give the driver time to respond.
await Bun.sleep(1500);

// Simulate a hang and verify supervisor restarts.
console.error("--- testing hang ---");
child.stdin.write(JSON.stringify({ id: "4", method: "_freeze" }) + "\n");
await Bun.sleep(6000); // > callTimeoutMs (5s)

child.stdin.write(JSON.stringify({ id: "5", method: "ping" }) + "\n");
await Bun.sleep(1000);

child.kill();
await child.exited;

console.log("\n--- replies received ---");
replies.forEach((r, i) => console.log(`[${i}] ${r}`));
