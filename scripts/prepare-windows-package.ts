import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dir, "..");
const resources = join(repo, "apps", "desktop", "src-tauri", "resources");
const sidecars = join(resources, "sidecars");
const agentBundle = join(resources, "agent-bundle");
const wordDriver = join(resources, "word-driver");

run("dotnet", ["build", join(repo, "drivers", "WordDriver", "WordDriver.csproj"), "-c", "Release"]);

rmSync(resources, { recursive: true, force: true });
mkdirSync(sidecars, { recursive: true });

copyDir(join(repo, "apps", "agent", "skills"), join(agentBundle, "skills"));
copyDir(join(repo, "apps", "agent", "docs"), join(agentBundle, "docs"));
copyDir(join(repo, "drivers", "WordDriver", "bin", "Release", "net48"), wordDriver, {
  exclude: (path) => path.endsWith(".pdb"),
});

run("bun", [
  "build",
  join(repo, "apps", "agent", "src", "index.ts"),
  "--compile",
  "--outfile",
  join(sidecars, "msword-agent.exe"),
]);

const configExample = join(resources, "config.example.json");
writeText(
  configExample,
  JSON.stringify(
    {
      baseUrl: "https://your-anthropic-compatible-endpoint.example",
      apiKey: "replace-me",
      model: "claude-sonnet-4-5",
      disableThinkingField: true,
    },
    null,
    2,
  ) + "\n",
);

console.log(`[package] resources prepared at ${resources}`);

function run(cmd: string, args: string[]) {
  console.log(`[package] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: repo, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed with exit code ${r.status}`);
  }
}

function copyDir(src: string, dst: string, opts: { exclude?: (path: string) => boolean } = {}) {
  if (!existsSync(src)) {
    throw new Error(`missing package input: ${src}`);
  }
  cpSync(src, dst, {
    recursive: true,
    force: true,
    filter: (path) => !opts.exclude?.(path),
  });
}

function writeText(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}
