/**
 * Browser-process singleton for Tauri sidecar event subscriptions.
 *
 * Why this exists: Tauri's `listen()` returns Promise<unsubscribe>. If you
 * register from inside a useEffect, the cleanup `void off.then(u => u())`
 * resolves asynchronously, so the first listener can survive into a second
 * mount (React.StrictMode) or remount (HMR / dependency-array change). Even
 * with `closed` flags inside the effect closure, the second listener fires
 * normally and you get every event N times.
 *
 * The fix is: register Tauri `listen()` exactly ONCE per channel, hold the
 * (eventually-resolved) unsubscribe in module scope, and dispatch to a Set
 * of handlers. The Set adds/removes synchronously, so React effects can
 * subscribe/unsubscribe cheaply and idempotently — N mounts of the same
 * effect produce 1 net handler in the Set, not N listeners on Tauri.
 *
 * The registry lives on globalThis, not in module scope. Vite HMR re-evaluates
 * this module; module-local state would register another Tauri listener on
 * every hot update and duplicate all future events.
 */

import { listen } from "@tauri-apps/api/event";

type Handler<T> = (payload: T) => void;

interface Channel<T> {
  registered: boolean;
  handlers: Set<Handler<T>>;
}

const GLOBAL_KEY = "__msword_use_tauri_event_channels__";

type ChannelMap = Map<string, Channel<any>>;

const channels: ChannelMap = (() => {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: ChannelMap };
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map();
  }
  return g[GLOBAL_KEY];
})();

function getChannel<T>(name: string): Channel<T> {
  let ch = channels.get(name) as Channel<T> | undefined;
  if (!ch) {
    ch = { registered: false, handlers: new Set() };
    channels.set(name, ch);
  }
  return ch;
}

export function onTauriEvent<T>(eventName: string, handler: Handler<T>): () => void {
  const ch = getChannel<T>(eventName);
  ch.handlers.add(handler);

  if (!ch.registered) {
    ch.registered = true;
    // Fire-and-forget the listener registration. We never tear it down.
    void listen<T>(eventName, (e) => {
      // Snapshot to avoid mutation-during-iteration issues if a handler
      // unsubscribes itself during dispatch.
      const snapshot = Array.from(ch.handlers);
      for (const h of snapshot) {
        try {
          h(e.payload);
        } catch (err) {
          console.error(`[onTauriEvent ${eventName}] handler threw`, err);
        }
      }
    });
  }

  return () => {
    ch.handlers.delete(handler);
  };
}
