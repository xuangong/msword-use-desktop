# msword-use-desktop

> Windows-only. Microsoft Word + .NET Framework 4.8 + Node 20+/Bun 1.x + Rust 1.84+.

A desktop app that drives Microsoft Word via natural language. The full editing path
runs through Word's Track Changes, so every AI edit is auditable and reviewable.

This is the **v2 desktop product**, evolved from the [Python CLI / Claude Code plugin v1](https://github.com/xuangong/msword-use). v1 stays alive as the developer/debug edition.

## Architecture

```
React + Vite + Tailwind  (apps/desktop/src)
        ▲
        │ Tauri invoke + event
        ▼
Tauri 2 (Rust)           (apps/desktop/src-tauri)
        ▲
        │ NDJSON over stdio (sidecar)
        ▼
Bun agent loop           (apps/agent)
        ▲
        │ NDJSON over stdio (subprocess + supervisor)
        ▼
WordDriver.exe (.NET 4.8) (drivers/WordDriver)
        ▲
        │ COM
        ▼
Microsoft Word
```

Why .NET Framework 4.8 (not .NET 10): Microsoft has [explicitly stated](https://learn.microsoft.com/en-us/answers/questions/1685712/open-word-document-in-net) that the Office Interop / VSTO platform will not move to .NET Core / 5+.

## Repo layout

```
apps/desktop/         Tauri shell + React UI
apps/agent/           Bun sidecar (TS, agent loop, LLM client)
drivers/WordDriver/   .NET 4.8 console exe (COM driver)
packages/rpc-schema/  Generated TS types from drivers/WordDriver/schema/methods.json
scripts/              build / dev / codegen scripts
```

## Quick start (developer)

```bash
git clone https://github.com/xuangong/msword-use-desktop.git
cd msword-use-desktop

bun install                # install workspace deps
bun run gen                # regenerate RPC types from drivers/WordDriver/schema/methods.json
bun run driver:build       # build the .NET 4.8 Word COM driver
bun run dev                # launch Tauri dev (Vite + Rust + Bun sidecar + auto-spawned WordDriver)
```

### Try it out

1. Open Microsoft Word with any document
2. `bun run dev` — the Tauri window appears
3. Type commands in the input box and hit enter:
   - `ping` → `{pong: true}`
   - `attach` → `{attached: true, version: "16.0", ...}`
   - `observe.outline` → current document's heading tree
   - `observe.selection` → current selection state
   - `_freeze` → simulate a hang; after 5s the supervisor kills + restarts; `gen` jumps to 2

### Headless smoke test (no Tauri window)

```bash
bun run driver:test        # spawns Bun sidecar + .NET driver, runs full hang+restart cycle
```

## Status

Alpha (Week 1 of 3). See `apps/agent/src/index.ts` for the current entry behavior.
