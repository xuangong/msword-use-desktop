/**
 * msword-use config loader.
 *
 * Single source of truth for LLM-runtime configuration: API key, base URL,
 * model id, gateway-compat tweaks. Replaces ad-hoc environment variables.
 *
 * Resolution order (first hit wins):
 *   1. env MSWORD_CONFIG_PATH (dev override / tests)
 *   2. %APPDATA%/msword-use/config.json on Windows
 *      $XDG_CONFIG_HOME/msword-use/config.json on Unix (XDG_CONFIG_HOME or ~/.config)
 *      ~/Library/Application Support/msword-use/config.json on macOS
 *
 * If the file is missing, returns an empty config — defaults take over and
 * the agent will throw at first prompt with a clear "no API key" error.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export interface MswordUseConfig {
  /** Anthropic API key. Required for any LLM call. */
  apiKey?: string;
  /** Override Anthropic base URL (corporate proxy / OneAPI / etc). */
  baseUrl?: string;
  /** Anthropic model id. Defaults to claude-sonnet-4-5. */
  model?: string;
  /**
   * Strip the `reasoning` field from the pi-ai model object so pi never sends
   * `thinking: {type, display}`. Some Anthropic-compatible gateways don't
   * support the adaptive-thinking schema yet. Drop this once the gateway
   * implements it. Default: false.
   */
  disableThinkingField?: boolean;
}

/** Where the config file would live on this OS, regardless of whether it exists. */
export function defaultConfigPath(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, "msword-use", "config.json");
    return join(homedir(), "AppData", "Roaming", "msword-use", "config.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "msword-use", "config.json");
  }
  // Linux / other Unix
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg
    ? join(xdg, "msword-use", "config.json")
    : join(homedir(), ".config", "msword-use", "config.json");
}

/** Resolve the config path, honouring MSWORD_CONFIG_PATH override. */
export function resolveConfigPath(): string {
  const override = process.env.MSWORD_CONFIG_PATH?.trim();
  return override ? resolve(override) : defaultConfigPath();
}

let _cached: { path: string; config: MswordUseConfig } | null = null;

/**
 * Load and validate the config. Cached after first call. Logs to stderr on
 * parse errors but never throws — caller still gets a (possibly empty)
 * config and can decide how to handle missing fields.
 */
export function loadConfig(): MswordUseConfig {
  if (_cached) return _cached.config;
  const path = resolveConfigPath();

  if (!existsSync(path)) {
    process.stderr.write(`[config] no config at ${path} — using defaults\n`);
    _cached = { path, config: {} };
    return _cached.config;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as MswordUseConfig;
    if (parsed && typeof parsed === "object") {
      process.stderr.write(`[config] loaded ${path}\n`);
      _cached = { path, config: parsed };
      return parsed;
    }
    process.stderr.write(`[config] ${path} is not a JSON object — ignoring\n`);
  } catch (err) {
    process.stderr.write(`[config] failed to parse ${path}: ${err}\n`);
  }
  _cached = { path, config: {} };
  return _cached.config;
}

/** Test seam: drop the cache so a subsequent loadConfig() re-reads the file. */
export function __resetConfigForTesting(): void {
  _cached = null;
}
