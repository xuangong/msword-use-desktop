# Engineering Memory

This file records project-specific lessons that should influence future changes.

## Tauri/Bun Agent Event Ingestion

- Do not assume duplicate UI events come from the LLM. First isolate the layer:
  sidecar stdout, Rust fanout/emit, then React ingestion.
- The canonical event path for main chat rendering is `App.tsx -> handleSidecarReply -> piEventToDebugEvent -> appendEventAtom`.
- Main-window polling via `spotlight_take_reply` must not call `handleSidecarReply`; it is only for draining subscriber queues and detecting terminal events.
- Spotlight chat events must be handled by exactly one path. Do not process the same `agent_event` from both `bun:reply` and spotlight polling.
- Tauri `listen()` subscriptions must be browser-process singletons. Vite HMR re-evaluates modules, so module-local listener registries can leak old listeners and duplicate every future event.
- The main UI must treat raw pi `agent_event` envelopes as at-least-once delivery and dedupe at ingestion before appending debug/chat events.
- Pi lifecycle events such as `agent_start`, `turn_start`, `turn_end`, and `message_end` should stay out of the visible event panel unless actively debugging protocol flow.

## Regression Checks

- For suspected duplicate assistant text, run a sidecar-only two-turn smoke first. If sidecar emits unique deltas, debug Rust/UI fanout instead of changing prompts or model settings.
- After frontend event-ingestion fixes, restart Tauri dev fully. HMR can leave old webview listener state alive until the desktop process is restarted.
- Keep `.dev/` smoke scripts and logs out of commits unless explicitly requested.
