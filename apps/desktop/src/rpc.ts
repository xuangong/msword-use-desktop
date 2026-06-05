/**
 * Tiny helper: send a raw RPC to the driver (via the Bun sidecar) and resolve
 * with its result. Used by the Performance panel to poll _perf.dump and
 * _perf.summary on a tick. Each call gets a unique id and polls the per-id
 * reply queue we already use for chat.
 *
 * NOT a general-purpose RPC client — that already exists driver-side. This
 * helper exists because the chat path streams events, while perf polling
 * wants a request/response shape.
 */
import { invoke } from "@tauri-apps/api/core";

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function rawCall(method: string, params: unknown = {}): Promise<unknown> {
  const id = `raw-${rid()}`;
  await invoke("bun_send", { line: JSON.stringify({ id, method, params }) });

  // Poll the named "perf" subscriber. We register it lazily on first call.
  if (!registered) {
    await invoke("register_subscriber", { name: "perf" }).catch(() => {});
    registered = true;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const replies = await invoke<string[]>("spotlight_take_reply", {
      subscriber: "perf",
      id,
    }).catch(() => [] as string[]);
    for (const raw of replies) {
      try {
        const msg = JSON.parse(raw);
        if (msg.id === id) {
          if (msg.error) throw new Error(msg.error);
          return msg.result;
        }
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`rawCall timeout: ${method}`);
}

let registered = false;
