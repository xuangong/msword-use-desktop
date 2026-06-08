import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const nsisDir = join(repo, "apps", "desktop", "src-tauri", "target", "release", "bundle", "nsis");
const msiDir = join(repo, "apps", "desktop", "src-tauri", "target", "release", "bundle", "msi");
const distDir = join(repo, "dist", "msword-use-windows");
const installScript = join(repo, "scripts", "install-windows.ps1");

const setupExe = latestSetupExe(nsisDir);
const msi = latestByExt(msiDir, ".msi");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

cpSync(setupExe, join(distDir, basename(setupExe)));
cpSync(msi, join(distDir, basename(msi)));
cpSync(installScript, join(distDir, "install-windows.ps1"));

writeFileSync(
  join(distDir, "README.txt"),
  [
    "msword-use Windows install package",
    "",
    "Run from PowerShell:",
    "",
    '  .\\install-windows.ps1 -Endpoint "https://your-endpoint.example" -ApiKey "replace-me"',
    "",
    "To install through MSI instead of the setup exe:",
    "",
    '  .\\install-windows.ps1 -UseMsi -Endpoint "https://your-endpoint.example" -ApiKey "replace-me"',
    "",
    "You can also double-click the .msi for a traditional install, then create:",
    "",
    "  %APPDATA%\\msword-use\\config.json",
    "",
    "For silent install:",
    "",
    "  $env:MSWORD_USE_ENDPOINT = \"https://your-endpoint.example\"",
    "  $env:MSWORD_USE_API_KEY = \"replace-me\"",
    "  .\\install-windows.ps1 -UseMsi -Silent",
    "",
    "The API key is written to %APPDATA%\\msword-use\\config.json for the current Windows user.",
  ].join("\r\n") + "\r\n",
  "utf-8",
);

console.log(`[dist] wrote ${distDir}`);

function latestSetupExe(dir: string): string {
  if (!existsSync(dir)) {
    throw new Error(`NSIS bundle dir not found: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith("-setup.exe"))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) {
    throw new Error(`No *-setup.exe found in ${dir}. Run bun run package:windows first.`);
  }
  return files[0];
}

function latestByExt(dir: string, ext: string): string {
  if (!existsSync(dir)) {
    throw new Error(`Bundle dir not found: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) {
    throw new Error(`No *${ext} found in ${dir}. Run bun run package:windows first.`);
  }
  return files[0];
}
