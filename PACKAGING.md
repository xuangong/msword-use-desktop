# Packaging

## Windows installer

Build a user-installable Windows package from the repo root:

```powershell
bun install
bun run package:windows
```

This produces:

```text
apps/desktop/src-tauri/target/release/bundle/nsis/msword-use_0.1.0_x64-setup.exe
apps/desktop/src-tauri/target/release/bundle/msi/msword-use_0.1.0_x64_en-US.msi
```

The packaging step prepares Tauri resources before running `tauri build`:

- `resources/sidecars/msword-agent.exe` — compiled Bun sidecar, so users do not need Bun installed.
- `resources/word-driver/` — Release build output for `WordDriver.exe` plus required Roslyn/Interop DLLs.
- `resources/agent-bundle/skills` and `resources/agent-bundle/docs` — default bundled skills/docs, seeded into the user data directory on first run.
- `resources/config.example.json` — example config only; never package a real API key.

At runtime, the installed app reads/writes user data here:

```text
%APPDATA%\msword-use\
  config.json
  skills\
  docs\
```

`config.json` is intentionally external to the installer. A user or deployment script should create:

```json
{
  "baseUrl": "https://your-anthropic-compatible-endpoint.example",
  "apiKey": "replace-me",
  "model": "claude-sonnet-4-5",
  "disableThinkingField": true
}
```

For a clean distribution test, install the generated setup on a machine without Bun and without this repo. The app should still start its sidecar, seed bundled skills/docs into `%APPDATA%\msword-use`, and use the bundled WordDriver.
