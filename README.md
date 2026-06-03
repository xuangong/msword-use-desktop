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

# Export your Anthropic key (required for chat / polish)
# PowerShell:
$env:ANTHROPIC_API_KEY = "sk-ant-..."
# bash:
export ANTHROPIC_API_KEY=sk-ant-...

bun run dev                # launch Tauri dev (Vite + Rust + Bun sidecar + auto-spawned WordDriver)
```

### Try it out

Open Microsoft Word with any document. `bun run dev` opens the Tauri window.

**Chat mode (default — talks to the LLM agent):**
- Select a paragraph in Word, then type "把这段改成公文风格" in the input box
- You'll see a tool-call card (`polish_text({...})`) that you can expand to inspect
- The assistant streams a Chinese summary
- The change appears in Word as a tracked revision with an `[AI: polish:公文]` comment

**Raw RPC mode (prefix `/`, for debugging):**
- `/ping` → `{pong: true}`
- `/attach` → `{attached: true, version: "16.0", ...}`
- `/observe.outline` → current document's heading tree
- `/observe.selection` → current selection state
- `/_freeze` → simulate a hang; after ~10s the supervisor kills + restarts; `gen` jumps to 2

### Headless smoke tests (no Tauri window)

```bash
bun run scripts/test-sidecar.ts   # raw RPC + hang+restart cycle (week 1)
bun run scripts/test-chat.ts      # full agent loop with polish_text (week 2)
```

## Status

Week 2 of 3 — alpha. End-to-end `/polish` over the agent loop validated headlessly. Tauri window verification is manual.
