/**
 * Slash command palette for the spotlight input.
 *
 * Detects when the input starts with "/" (typically `/skill:foo`) and
 * shows a filtered dropdown of available commands. Tracks Up/Down/Tab/Enter
 * to let the user pick without leaving the keyboard.
 *
 * Currently only `/skill:<name>` commands are surfaced; the list is fed by
 * the sidecar's `skills:list` event (see SpotlightApp).
 *
 * Pure presentational + small selection state. All side effects (sending,
 * filling the input, hiding) live in SpotlightApp.
 */

import { useEffect, useMemo, useRef, useState } from "react";

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
}

export interface PaletteCommand {
  /** Full command string the input would become if selected (e.g. "/skill:translate "). */
  fill: string;
  /** What to render in the row's first line. */
  label: string;
  /** Secondary line — explanation. */
  description: string;
}

export function buildCommands(skills: SkillEntry[]): PaletteCommand[] {
  return [
    {
      fill: "/reload-skills",
      label: "/reload-skills",
      description: "重新扫描 skills 目录（修改 SKILL.md 后用）",
    },
    ...skills.map((s) => ({
      fill: `/skill:${s.name} `,
      label: `/skill:${s.name}`,
      description: s.description,
    })),
  ];
}

interface PaletteProps {
  /** Current input value. */
  query: string;
  /** All commands (built from skills + builtins). */
  commands: PaletteCommand[];
  /** Called when user picks an item — replaces the input value. */
  onPick: (cmd: PaletteCommand) => void;
}

export interface PaletteHandle {
  /** Returns true if the keystroke was consumed by the palette. */
  handleKey: (e: React.KeyboardEvent) => boolean;
  open: boolean;
}

/**
 * Hook variant — returns ({ open, items, handleKey, render }) so the parent
 * can inline the palette directly above the input without a portal/z-index
 * hassle. The palette only opens when query starts with "/".
 */
export function useCommandPalette(props: PaletteProps): PaletteHandle & { render: () => React.ReactNode } {
  const { query, commands, onPick } = props;
  const open = query.startsWith("/");
  const filtered = useMemo(() => filter(commands, query), [commands, query]);
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Keep activeIdx in bounds when filtered shrinks.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIdx]);

  function handleKey(e: React.KeyboardEvent): boolean {
    if (!open || filtered.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % filtered.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      return true;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const pick = filtered[activeIdx];
      if (pick) onPick(pick);
      return true;
    }
    if (e.key === "Enter") {
      // Enter when a perfect match is highlighted: pick. Otherwise let
      // submit fire so the user can send a literal `/foo bar` string.
      const pick = filtered[activeIdx];
      if (pick && (pick.fill.trim() === query.trim() || filtered.length === 1)) {
        e.preventDefault();
        onPick(pick);
        return true;
      }
      return false;
    }
    return false;
  }

  function render(): React.ReactNode {
    if (!open) return null;
    if (filtered.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-neutral-400 border-b border-neutral-100">
          (没有匹配的命令)
        </div>
      );
    }
    return (
      <div ref={listRef} className="border-b border-neutral-100 max-h-48 overflow-y-auto">
        {filtered.map((cmd, i) => (
          <button
            key={cmd.fill}
            type="button"
            onMouseDown={(e) => {
              // mousedown (not click) so the input doesn't lose focus first
              e.preventDefault();
              onPick(cmd);
            }}
            onMouseEnter={() => setActiveIdx(i)}
            className={
              "w-full text-left px-3 py-1.5 flex flex-col gap-0.5 " +
              (i === activeIdx ? "bg-blue-50" : "hover:bg-neutral-50")
            }
          >
            <span className="font-mono text-xs text-neutral-700">{cmd.label}</span>
            <span className="text-[11px] text-neutral-500 truncate">{cmd.description}</span>
          </button>
        ))}
      </div>
    );
  }

  return { open, handleKey, render };
}

/**
 * Filter commands by:
 *  - typed prefix match on cmd.fill (most specific)
 *  - then substring match on label or description
 * Stable order: prefix matches first, then substring.
 */
function filter(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q || q === "/") return commands;
  const prefix: PaletteCommand[] = [];
  const sub: PaletteCommand[] = [];
  for (const c of commands) {
    if (c.fill.toLowerCase().startsWith(q)) prefix.push(c);
    else if (
      c.label.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q)
    ) sub.push(c);
  }
  return [...prefix, ...sub];
}
