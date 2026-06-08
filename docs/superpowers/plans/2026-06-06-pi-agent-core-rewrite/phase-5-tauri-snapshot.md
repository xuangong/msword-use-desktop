# Phase 5 — Tauri: snapshot fetch on hotkey

**Goal:** When the user presses Ctrl+Alt+J, after capturing the foreground HWND, the Rust side asks the sidecar (via `kind:"raw"`) to run a small C# script that returns `{paragraphIndex, preview}` for the current Word selection. That info rides along with the existing `spotlight:invoke` event so the UI can render the "📄 第 N 段：『preview』" strip.

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` — add snapshot helper + thread it into `show_spotlight`

**Why phase 5:** Phase 6 (frontend) needs the snapshot data on the `spotlight:invoke` event. We could've delivered the data via a separate async channel, but it complicates frontend ordering — single payload is simpler.

**Design choices:**
- The snapshot runs as a `kind:"raw"` request, **NOT** through `bun_send`. We don't want the UI's chat code path involved; this is internal infrastructure.
- The snapshot is **best-effort**. If the sidecar isn't ready, or Word isn't running, or the script fails, we still emit `spotlight:invoke` with `paragraphIndex: null` and `preview: null`. The user can still type a prompt; the bootstrap preamble degrades gracefully when the pinned target is missing.
- Snapshot timeout: **2 seconds**. Spotlight UX is "instant" — anything beyond 2s feels broken. If Word's sluggish, we fall back to the no-target path.
- We add a per-snapshot reply queue keyed off the snapshot request id, separate from the chat reply queues used by the UI. Reuses the existing `fanout_reply` infrastructure with a "snapshot" subscriber.

---

### Task 5.1: Snapshot script constant

The Roslyn snippet that computes paragraphIndex + preview is best kept as a `const` in lib.rs (single source of truth, escaping done once).

**File:** `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the snapshot script constant near the top of `lib.rs`**

After the existing `static SIDECAR_REPLIES` block (look for `static SIDECAR_REPLIES: Lazy<Mutex<...>>` declaration), add:

```rust
/// C# snippet sent to the driver (via sidecar `kind:"raw"`) to capture the
/// active paragraph + an 80-char preview when the spotlight hotkey fires.
///
/// Globals available (set up by drivers/WordDriver/Roslyn/Host.cs):
///   - Doc (Word.Document)
///   - App (Word.Application)
///
/// Returns:
///   { paragraphIndex: int|null, preview: string }
///
/// Tolerant of "no selection" (returns null index + empty preview).
const SNAPSHOT_SCRIPT: &str = r#"
if (App == null || Doc == null) {
    return new { paragraphIndex = (int?)null, preview = "" };
}
var sel = App.Selection;
int? idx = null;
if (sel != null && sel.Paragraphs.Count > 0) {
    int targetStart = sel.Paragraphs[1].Range.Start;
    int i = 1;
    foreach (Microsoft.Office.Interop.Word.Paragraph p in Doc.Paragraphs) {
        if (p.Range.Start == targetStart) { idx = i; break; }
        i++;
    }
}
string preview = "";
if (idx.HasValue) {
    var t = (Doc.Paragraphs[idx.Value].Range.Text ?? "").Trim('\r','\n','\x07',' ','\t');
    preview = t.Length > 80 ? t.Substring(0, 80) : t;
}
return new { paragraphIndex = idx, preview = preview };
"#;
```

The Roslyn host hooks `result` to whatever the script returns; the anonymous object becomes a JSON object with `paragraphIndex` and `preview` keys.

- [ ] **Step 2: Build to confirm it parses**

```bash
cd apps/desktop/src-tauri && cargo check
cd ../../..
```

Expected: clean check (the constant is unused at this point — Rust may warn `dead_code`, that's fine).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(tauri): SNAPSHOT_SCRIPT for spotlight paragraph preview"
```

---

### Task 5.2: Async snapshot helper

Wraps the lifecycle: write a `kind:"raw"` request to the sidecar's stdin, wait up to 2s for the matching `kind:"raw_response"` line on the snapshot subscriber's queue, parse, return.

**File:** `apps/desktop/src-tauri/src/lib.rs`

The sidecar already reads stdin and writes line-delimited JSON; the existing `fanout_reply()` puts every reply with an `id` field into all subscriber queues. Snapshots use a unique `id` prefix (`snap_<seq>_<ts>`) so we can identify them in the snapshot subscriber's queue.

- [ ] **Step 1: Register the "snapshot" subscriber at startup**

Find the existing `setup` closure (search for `app.global_shortcut().register(toggle_shortcut)`). After the spotlight window's focus handler, add:

```rust
            // Register a dedicated queue for spotlight snapshot replies so they
            // don't race against the UI's main / spotlight subscriber queues.
            ensure_subscriber("snapshot");
```

This guarantees the snapshot subscriber's queue exists from process start, regardless of when the first hotkey fires.

- [ ] **Step 2: Add the snapshot helper**

Right after `show_spotlight` (search for `fn show_spotlight(app: &AppHandle)`), add:

```rust
#[derive(Clone, Serialize, Default)]
struct SpotlightSnapshot {
    paragraph_index: Option<u32>,
    preview: String,
}

/// Send a `kind:"raw"` request to the sidecar with the SNAPSHOT_SCRIPT and
/// wait up to 2s for the matching reply. On any failure (sidecar not up, no
/// reply within budget, parse error, driver error), returns the default
/// (no paragraph index, empty preview) — snapshot is best-effort.
fn fetch_snapshot_blocking(seq: u64) -> SpotlightSnapshot {
    let id = format!("snap_{}_{}", seq, std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));

    let payload = serde_json::json!({
        "kind": "raw",
        "id": id,
        "code": SNAPSHOT_SCRIPT,
    });
    let line = match serde_json::to_string(&payload) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[snapshot] serialize failed: {}", e);
            return SpotlightSnapshot::default();
        }
    };

    // Write to sidecar stdin
    let stdin_mutex = match SIDECAR_STDIN.get() {
        Some(m) => m,
        None => {
            eprintln!("[snapshot] sidecar not initialized yet");
            return SpotlightSnapshot::default();
        }
    };
    if let Ok(mut stdin) = stdin_mutex.lock() {
        if writeln!(stdin, "{}", line).is_err() {
            eprintln!("[snapshot] write to sidecar failed");
            return SpotlightSnapshot::default();
        }
        let _ = stdin.flush();
    } else {
        return SpotlightSnapshot::default();
    }

    // Poll the snapshot subscriber queue every 25ms, up to 2s.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2000);
    while std::time::Instant::now() < deadline {
        let lines = SIDECAR_REPLIES
            .lock()
            .ok()
            .and_then(|mut top| top.get_mut("snapshot").and_then(|q| q.remove(&id)))
            .unwrap_or_default();
        if !lines.is_empty() {
            // Parse the FIRST line we got (sidecar emits a single raw_response per id).
            let raw = &lines[0];
            return parse_snapshot_line(raw);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    eprintln!("[snapshot] timed out after 2s");
    SpotlightSnapshot::default()
}

fn parse_snapshot_line(raw: &str) -> SpotlightSnapshot {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[snapshot] parse failed: {}", e);
            return SpotlightSnapshot::default();
        }
    };
    // raw_response shape: {id, kind:"raw_response", result:..., stdout, error}
    if v.get("error").and_then(|e| e.as_str()).is_some_and(|s| !s.is_empty()) {
        eprintln!("[snapshot] driver error: {}", v["error"]);
        return SpotlightSnapshot::default();
    }
    let result = match v.get("result") {
        Some(r) => r,
        None => return SpotlightSnapshot::default(),
    };
    let paragraph_index = result
        .get("paragraphIndex")
        .and_then(|p| p.as_u64())
        .map(|n| n as u32);
    let preview = result
        .get("preview")
        .and_then(|p| p.as_str())
        .unwrap_or("")
        .to_string();
    SpotlightSnapshot {
        paragraph_index,
        preview,
    }
}
```

The choice of 25ms poll interval is to keep snapshot latency ≤ 25ms once the reply lands, while bounding CPU at 40 polls/s — a hotkey doesn't fire often, so this is cheap.

- [ ] **Step 3: Build**

```bash
cd apps/desktop/src-tauri && cargo check
cd ../../..
```

Expected: clean. Helper still unused — `dead_code` warning is fine.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(tauri): fetch_snapshot_blocking helper (best-effort)"
```

---

### Task 5.3: Wire the snapshot into `show_spotlight`

Now actually call the helper before emitting `spotlight:invoke`, and include the snapshot in the event payload.

- [ ] **Step 1: Extend `SpotlightInvoke` with snapshot fields**

Find the `struct SpotlightInvoke` definition (search for `struct SpotlightInvoke`). Add two fields:

```rust
    /// 1-based paragraph index for the current Word selection. None if Word
    /// isn't focused or the snapshot fetch failed.
    paragraph_index: Option<u32>,
    /// Up to 80 chars of the active paragraph's text. Empty when no selection.
    preview: String,
```

Place them right after the existing `seq` field. Keep `serde::Serialize` happy — the struct is already `#[derive(Clone, Serialize)]`.

- [ ] **Step 2: Initialize the new fields in `capture_foreground`**

Find both `capture_foreground` implementations (the `#[cfg(windows)]` and `#[cfg(not(windows))]` versions). For each, in the constructed `SpotlightInvoke {...}` literal, add:

```rust
            paragraph_index: None,
            preview: String::new(),
```

The capture function only reads HWND state; snapshot data comes from the sidecar in the next step.

- [ ] **Step 3: Update `show_spotlight` to fetch and merge the snapshot**

Find `fn show_spotlight(app: &AppHandle)`. Replace its body with:

```rust
fn show_spotlight(app: &AppHandle) {
    let mut invoke = capture_foreground();
    eprintln!(
        "[main] spotlight invoke: seq={} class={:?} title={:?} is_word={} hwnd={:#x} pid={}",
        invoke.seq, invoke.trigger_class, invoke.trigger_title, invoke.is_word, invoke.trigger_hwnd, invoke.trigger_pid,
    );

    // Snapshot fetch: only worth attempting if the foreground is actually Word.
    // Otherwise we'd spend 2s waiting for a script that's guaranteed to error.
    if invoke.is_word {
        let snap = fetch_snapshot_blocking(invoke.seq);
        invoke.paragraph_index = snap.paragraph_index;
        invoke.preview = snap.preview;
    }

    if let Ok(mut g) = LAST_INVOKE.lock() {
        *g = Some(invoke.clone());
    }
    if let Some(w) = app.get_webview_window("spotlight") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        if let Err(e) = app.emit_to(EventTarget::webview_window("spotlight"), "spotlight:invoke", invoke) {
            eprintln!("[main] spotlight:invoke emit_to failed: {}", e);
        }
    } else {
        eprintln!("[main] spotlight window not found");
    }
}
```

Two notable details:
- We only fetch the snapshot when `is_word` is true. The check is cheap (string comparison on window class) and avoids the 2s timeout wait when the user hits the hotkey from, say, VS Code.
- The snapshot fetch is **synchronous** here (`fetch_snapshot_blocking`). The hotkey handler in `tauri-plugin-global-shortcut` already runs on a worker thread, so blocking up to 2s here is acceptable. If telemetry later shows this is too slow, we can move to async via Tauri's `async_runtime::spawn` and emit a separate `spotlight:snapshot_update` event — but that's a follow-up.

- [ ] **Step 4: Build**

```bash
cd apps/desktop/src-tauri && cargo check
cd ../../..
```

Expected: clean.

- [ ] **Step 5: Full Tauri build (no run yet)**

```bash
cd apps/desktop/src-tauri && cargo build
cd ../../..
```

Expected: succeeds. This is heavier than `check` and surfaces any link issues.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(tauri): include paragraph snapshot in spotlight:invoke event"
```

---

### Task 5.4: Manual sanity check (with sidecar + Word)

We can't unit-test the Rust side without a heavy Tauri test harness. Instead, run the dev loop and verify:

- [ ] **Step 1: Start Word with any document**

(Doesn't have to be Chinese for this check; it's just verifying the snapshot fetch returns sensible data.)

- [ ] **Step 2: Run dev**

```bash
bun run dev
```

Expected: Tauri window opens, sidecar logs show `ready`, no panics from Rust.

- [ ] **Step 3: Open browser devtools on the spotlight window**

Press Ctrl+Alt+J once with Word focused. In Tauri's devtools console (or the `bun:log` event stream visible in the main window — phase 6 will surface this in the UI), look for the spotlight:invoke payload.

Expected payload includes:
```json
{
  "trigger_title": "<filename>.docx - Word",
  "trigger_class": "OpusApp",
  "is_word": true,
  "paragraph_index": <some 1-based int>,
  "preview": "<first 80 chars of the selected paragraph>"
}
```

If `paragraph_index` is null and `preview` is empty even though Word is focused with a real selection, debug:
- Check the sidecar stderr — is the `[snapshot]` message indicating "sidecar not initialized" or "timed out"?
- Run the snapshot script manually via the test driver from phase 1: `bun run scripts/test-driver.ts` then send the SNAPSHOT_SCRIPT verbatim to confirm the script itself works.
- If the sidecar's writes to its own stdin are failing because `SIDECAR_STDIN` was never set — that means `spawn_sidecar` isn't running yet at hotkey time. The current code spawns sidecar with a 200ms delay in setup; if you're hitting the hotkey within that window, of course the snapshot fails. Wait 1s after Tauri opens and re-test.

If preview shows mojibake or wrong characters, that's a UTF-8 issue in the IPC chain — likely the script's escaping. Compare the raw write to stdin (via `eprintln!` of `line` before writing) against what arrives at the driver to triangulate.

- [ ] **Step 4: Press Ctrl+Alt+J from a non-Word window (e.g. Notepad)**

Expected: spotlight still opens; payload has `is_word: false`, `paragraph_index: null`, `preview: ""`. The fetch helper should be **skipped** entirely (no `[snapshot]` message in stderr), so this should be near-instant.

- [ ] **Step 5: Stop dev (Ctrl-C)**

No commit for this task — it's a verification step. If it failed, find the bug and amend the relevant prior commit.

---

## Phase 5 acceptance

- ✅ `apps/desktop/src-tauri/src/lib.rs` defines `SNAPSHOT_SCRIPT` and `fetch_snapshot_blocking`.
- ✅ `SpotlightInvoke` struct includes `paragraph_index: Option<u32>` and `preview: String`.
- ✅ `show_spotlight` calls the snapshot fetch only when `is_word == true`.
- ✅ `cargo build` succeeds.
- ✅ Manual sanity: hotkey from Word emits a `spotlight:invoke` event with non-null `paragraph_index` and a non-empty `preview` matching the selection.
- ✅ Manual sanity: hotkey from non-Word emits with `is_word: false` and snapshot fetch skipped (≤200ms).

If any criterion fails, fix in place — phase 6 needs these fields.
