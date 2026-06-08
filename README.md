# msword-use-desktop

> Windows-only. Requires Microsoft Word + .NET Framework 4.8 + Node 20+/Bun 1.x + Rust 1.84+.

A desktop app that drives Microsoft Word via natural language. Every AI edit
flows through Word's Track Changes, so users can review and accept/reject
just like a human collaborator's changes.

This is the **v2 desktop product**, evolved from the
[Python CLI / Claude Code plugin v1](https://github.com/xuangong/msword-use).
v1 stays alive as the developer/debug edition.

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
Bun + pi-agent-core      (apps/agent)
        ▲ Anthropic SDK
        │ NDJSON over stdio (supervised subprocess)
        ▼
WordDriver.exe (.NET 4.8) (drivers/WordDriver)
        ▲
        │ COM (single-action driver: exec_csharp + a thin observe RPC)
        ▼
Microsoft Word
```

**Why .NET Framework 4.8 (not .NET 10):** Microsoft has
[explicitly stated](https://learn.microsoft.com/en-us/answers/questions/1685712/open-word-document-in-net)
that Office Interop / VSTO won't move to .NET Core / 5+. The spike confirmed
this — net48 + `Microsoft.Office.Interop.Word` works; .NET 10 fails at
runtime (`office.dll` cannot load).

**Why a supervised driver subprocess:** Word COM can hang (modal dialogs,
runaway operations). The Bun supervisor detects 10-second hangs, kills the
driver, and respawns it. Word itself keeps running — re-attach is automatic.

## Quick start (developer)

```bash
git clone https://github.com/xuangong/msword-use-desktop.git
cd msword-use-desktop

bun install                # install workspace deps
bun run driver:build       # build the .NET 4.8 Word COM driver

# Configure your API key — required for chat / polish.
# Copy the example to your OS-standard config dir:
#   Windows : %APPDATA%\msword-use\config.json
#   macOS   : ~/Library/Application Support/msword-use/config.json
#   Linux   : ~/.config/msword-use/config.json
# (Override path: set MSWORD_CONFIG_PATH=/abs/path/to/config.json)
#
# Edit the copy and fill in apiKey, plus optional baseUrl / model /
# disableThinkingField — see config.example.json for the full schema.

bun run dev                # launch Tauri dev (Vite + Rust + Bun sidecar + auto-spawned WordDriver)
```

## Using it

### 1. Open Word
Open Microsoft Word with any document. For the best demo, use a Chinese
document (we ship `gongwen_sample.docx` in the v1 repo as a fixture).

### 2. Launch the app
`bun run dev` opens the Tauri window. Within ~2 seconds the header should show
`驱动 gen=1` in green and the right-side context panel should populate with
the active document name, current selection, and outline.

### 3. Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>J</kbd>
Global hotkey — works from any app, including from Word itself. Toggles the
msword-use window in/out of focus.

### 4. Chat with the agent
- Select a paragraph in Word
- In the chat box, type 「**把这段改成公文风格**」 (or English: "Polish this in 公文 style")
- Watch the tool-call card appear (you can expand it to inspect)
- The assistant streams a Chinese summary
- In Word: the change appears as a **tracked revision** with an
  `[AI: polish:公文]` comment

### 5. Raw RPC for debugging (`/` prefix)
Slash commands removed in W1; will be re-added if useful.

## Polish styles

Polish in 公文 / 合同 / 论文 / 文案 / 商务 style — the agent reads the matching
SKILL.md from `apps/agent/skills/` and writes a Track-Changes-wrapped C#
script (via `exec_csharp`) to apply the rewrite.

## Headless smoke tests (no Tauri window)

```bash
bun run scripts/test-driver.ts    # 6-tick driver smoke (compile/runtime/stdout/empty/shutdown)
bun test apps/agent               # full sidecar suite (RPC, supervisor, agent, tools)
bun test --cwd apps/desktop src/state/piEventBridge.test.ts   # frontend bridge tests
```

## Status

**Alpha (Week 3) + W1 pi-agent-core rewrite in progress.** End-to-end
`/polish` over the agent loop validated. Built-in observability (CoT
stream, tool-call expand, Word context panel, supervisor gen tracking).
Tauri window tested in dev mode; `bun run build` (.msi packaging) is wired
up but not yet exercised in CI.

### Known limitations (alpha)
- `bun run dev` requires `apiKey` set in the OS-standard `config.json` (see Quick start)
- Inner sidecar binaries are not yet Authenticode-signed → SmartScreen warning on first run of a built .msi
- Word must run unelevated (or both Word and the desktop app elevated together)
- Comments on tracked insertions can fail silently in some Word versions — the edit still applies, just no `[AI:...]` comment