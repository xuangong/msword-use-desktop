# Phase 6a — Spotlight UI: paragraph preview strip

**Goal:** Surface the `paragraph_index` + `preview` fields delivered on `spotlight:invoke` (phase 5) as a small visual strip above the input — `📄 第 N 段：「preview…」`. Lets the user visually confirm what the AI will operate on before submitting a prompt.

**Files:**
- Modify: `apps/desktop/src/SpotlightApp.tsx` — extend `SpotlightInvoke` type + render strip

**Why phase 6a:** The spotlight UX promise (Q4 decision in the spec) is "user sees the target paragraph before typing". This is the visible payoff of phase 5's snapshot work. Independent of 6b (atoms / event-name parsing) — those changes are in `App.tsx` / `state/atoms.ts`, not the spotlight window.

**Visual target (mock):**
```
┌────────────────────────────────────────────────────┐
│ 📄 第 6 段：「关于深入学习贯彻…的通知」            │  ← new strip (only when paragraph_index != null)
│  ─────────────────────────────────                 │
│  把这段改成公文风格…                               │  ← existing input
│                                                    │
│  agent transcript scrolls below                    │
└────────────────────────────────────────────────────┘
```

When `paragraph_index` is null (e.g. user invoked outside Word, or the snapshot timed out), the strip is replaced with a subtler hint about which window is focused (current behavior — preserve it).

---

### Task 6a.1: Extend `SpotlightInvoke` type

The Rust side already adds `paragraph_index` and `preview` (phase 5). The TS-side mirror needs the same fields.

**File:** `apps/desktop/src/SpotlightApp.tsx`

- [ ] **Step 1: Update the interface**

Find the existing interface near the top of `SpotlightApp.tsx`:

```typescript
interface SpotlightInvoke {
  trigger_hwnd: number;
  trigger_pid: number;
  trigger_title: string;
  trigger_class: string;
  is_word: boolean;
  seq: number;
}
```

Replace with:

```typescript
interface SpotlightInvoke {
  trigger_hwnd: number;
  trigger_pid: number;
  trigger_title: string;
  trigger_class: string;
  is_word: boolean;
  seq: number;
  /** 1-based paragraph index for the active Word selection, or null if
   *  not focused on Word / snapshot fetch failed. */
  paragraph_index: number | null;
  /** Up to 80 chars of the active paragraph's text. Empty string when no
   *  selection / not Word focused. */
  preview: string;
}
```

The new fields use snake_case to match Rust's serde-default JSON shape (tauri's serde-json bridge does no automatic case conversion).

- [ ] **Step 2: Confirm compile**

```bash
cd apps/desktop && bunx tsc --noEmit
cd ../..
```

Expected: existing errors related to v0.3 chat code may remain (those are addressed in 6b). What matters here: **no new errors caused by this type change**. If the diff between "before this task" and "after" introduces TS errors, they must be in code that consumes `SpotlightInvoke` — fix those consumers.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/SpotlightApp.tsx
git commit -m "feat(spotlight): SpotlightInvoke type adds paragraph_index + preview"
```

---

### Task 6a.2: Render the preview strip

The strip should appear at the top of the spotlight window, above the input. It updates whenever `setCtx(invoke)` runs (existing call site).

- [ ] **Step 1: Add the strip component**

Open `apps/desktop/src/SpotlightApp.tsx`. Locate the JSX returned from the `SpotlightApp` component — search for the input element (it's wrapped in some layout div with the placeholder text "raw command" or similar; look around line ~280-330 in the current file).

Just before the input, add this element. The exact JSX placement depends on the existing structure, so first **read** the JSX of the return statement, then insert this in the layout slot directly above the main input row:

```tsx
        {ctx && ctx.paragraph_index != null && (
          <div
            className="spotlight-target-strip"
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              color: "#888",
              borderBottom: "1px solid #2a2a2a",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={ctx.preview /* full preview on hover, in case it's truncated */}
          >
            📄 第 {ctx.paragraph_index} 段：「{ctx.preview || "(空段落)"}」
          </div>
        )}
        {ctx && ctx.paragraph_index == null && ctx.is_word === false && (
          <div
            className="spotlight-target-strip spotlight-target-strip--inactive"
            style={{
              padding: "6px 12px",
              fontSize: "12px",
              color: "#666",
              borderBottom: "1px solid #2a2a2a",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={ctx.trigger_title}
          >
            ⚠️ 当前不在 Word 窗口（{ctx.trigger_class || "未知"}）
          </div>
        )}
```

Two strips, mutually exclusive (one when we have a target paragraph, one when we don't and Word isn't focused). When `paragraph_index == null` AND `is_word == true` (i.e., snapshot fetch failed despite Word being focused — ~rare), nothing renders — silently degrades, the user can still type.

The `style` props are inline so this works without touching CSS files. If the project has a global CSS module pattern, prefer adding two classes there and removing inline styles. (Look for `App.css` to see whether the rest of the spotlight uses CSS modules or inline styles — match the prevailing pattern.)

- [ ] **Step 2: Build the renderer**

```bash
cd apps/desktop && bun run build
cd ../..
```

If this errors out elsewhere (v0.3 chat code), do `bunx tsc --noEmit` to isolate; only NEW errors caused by 6a.2 are blocking.

If the JSX placement broke layout, your JSX has unbalanced tags or a wrong fragment boundary — re-read your edit and the surrounding return statement.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/SpotlightApp.tsx
git commit -m "feat(spotlight): paragraph preview strip"
```

---

### Task 6a.3: Manual sanity (with sidecar + Word + dev loop)

- [ ] **Step 1: Run dev**

```bash
bun run dev
```

- [ ] **Step 2: Open Word, click into a paragraph, press Ctrl+Alt+J**

Expected:
- Spotlight window opens
- Top strip reads `📄 第 N 段：「<text of clicked paragraph>」` where N matches
- The text is the active paragraph (paragraph the cursor is in), not necessarily a full sentence — Word treats each `\r`-terminated chunk as a paragraph

If the strip doesn't show:
- Open Tauri devtools on the spotlight window. Inspect the `spotlight:invoke` event payload via the `bun:log` stream or by adding a `dlog("invoke payload", invoke.payload)` line to the existing handler. Confirm `paragraph_index` is non-null and `preview` is non-empty.
- If the payload is correct but the strip doesn't render: check React component remount — the inline-style div might be hidden by other CSS. Open DevTools → Elements → look for `.spotlight-target-strip` in the DOM tree.

- [ ] **Step 3: Click into a different paragraph, press Ctrl+Alt+J again**

Expected: strip updates to the new paragraph index + preview. Each invoke is a fresh snapshot (the `seq` field on `SpotlightInvoke` increments).

- [ ] **Step 4: Press Ctrl+Alt+J from Notepad / VS Code (non-Word)**

Expected: strip shows the warning variant: `⚠️ 当前不在 Word 窗口（Notepad / Chrome / etc）`. The agent input is still usable (per spec — degraded mode), though prompts will fail at exec_csharp time.

- [ ] **Step 5: Stop dev (Ctrl-C)**

No commit for this task — verification only.

---

## Phase 6a acceptance

- ✅ `apps/desktop/src/SpotlightApp.tsx` `SpotlightInvoke` type includes `paragraph_index: number | null` and `preview: string`.
- ✅ When `paragraph_index != null`, top of spotlight shows `📄 第 N 段：「preview」` with text-overflow ellipsis.
- ✅ When `is_word == false`, top of spotlight shows the non-Word warning variant.
- ✅ When `is_word == true && paragraph_index == null` (rare snapshot failure), nothing rendered (degraded silently — user can still type).
- ✅ Manual sanity: hotkey from a Word paragraph shows the right preview; hotkey from non-Word shows the warning; hotkey from a different paragraph updates the strip.

If any criterion fails, fix in place — phase 6b (event/atom rewiring) is independent and can proceed in parallel if you have a second worktree, but the e2e in phase 7 needs both.
