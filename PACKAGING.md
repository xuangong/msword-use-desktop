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

To produce a repo-free distribution folder:

```powershell
bun run package:windows:dist
```

This writes:

```text
dist/msword-use-windows/
  install-windows.cmd
  install-windows.ps1
  msword-use_0.1.0_x64-setup.exe
  msword-use_0.1.0_x64_en-US.msi
  README.txt
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

## One-step local install

For testing or internal distribution, use the install wrapper. It writes the
runtime config for the current Windows user, runs the generated NSIS installer,
and then launches the app:

```powershell
bun run install:windows -- `
  -Endpoint "https://your-anthropic-compatible-endpoint.example" `
  -ApiKey "replace-me"
```

If the installer has not been built yet:

```powershell
bun run install:windows -- -Build -Endpoint "https://your-anthropic-compatible-endpoint.example" -ApiKey "replace-me"
```

For deployment scripts, prefer environment variables so the key is not baked
into repo files:

```powershell
$env:MSWORD_USE_ENDPOINT = "https://your-anthropic-compatible-endpoint.example"
$env:MSWORD_USE_API_KEY = "replace-me"
bun run install:windows -- -Silent
```

The wrapper creates:

```text
%APPDATA%\msword-use\config.json
```

The installer itself still does not contain a real API key. It only bundles the
app, compiled sidecar, WordDriver, and default skills/docs.

For distribution without the repo, put these two files in the same folder or
zip them together:

```text
install-windows.cmd
install-windows.ps1
msword-use_0.1.0_x64-setup.exe
msword-use_0.1.0_x64_en-US.msi
```

Then run:

```powershell
.\install-windows.cmd -Endpoint "https://your-anthropic-compatible-endpoint.example" -ApiKey "replace-me"
```

Use the `.cmd` wrapper for normal installs. It runs the PowerShell installer
with `-ExecutionPolicy Bypass` for that process only, so it works on machines
that block direct `.ps1` execution.

To force the traditional MSI installer path:

```powershell
.\install-windows.cmd -UseMsi -Endpoint "https://your-anthropic-compatible-endpoint.example" -ApiKey "replace-me"
```

The `.msi` can also be double-clicked directly. In that mode Windows Installer
only installs the app; create `%APPDATA%\msword-use\config.json` separately, or
add a first-run settings screen/custom MSI action later.
