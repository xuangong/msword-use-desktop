// msword-use desktop — Tauri main process.
//
// Architecture as of v0.3: this is a **Word command palette**, not a desktop
// chat app. The main window is hidden by default; the user invokes a global
// hotkey from inside Word and a transient always-on-top spotlight bar shows up.
//
// Process tree:
//   Tauri (this process) ── Bun sidecar (TypeScript agent) ── WordDriver.exe (.NET 4.8 COM)
//                                                                      │
//                                                                      ▼
//                                                              Microsoft Word

use once_cell::sync::{Lazy, OnceCell};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, EventTarget, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static SIDECAR_STDIN: OnceCell<Mutex<ChildStdin>> = OnceCell::new();
// Most recent spotlight invocation context.
static LAST_INVOKE: Mutex<Option<SpotlightInvoke>> = Mutex::new(None);
// Sidecar readiness, updated when we see {"ready":true,...} from stdout.
// Polled by the main window on mount (HMR-safe — survives React remounts).
static SIDECAR_READY: Mutex<bool> = Mutex::new(false);
static SIDECAR_GEN: Mutex<u32> = Mutex::new(0);
// Per-subscriber reply queue. Each webview that wants to receive sidecar
// replies registers as a subscriber (by string key) and gets its own queue;
// each incoming reply is fan-out copied to every subscriber's queue. This
// way main and spotlight don't race over a shared queue.
static SIDECAR_REPLIES: Lazy<Mutex<HashMap<String, HashMap<String, Vec<String>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn ensure_subscriber(name: &str) {
    if let Ok(mut top) = SIDECAR_REPLIES.lock() {
        top.entry(name.to_string()).or_insert_with(HashMap::new);
    }
}

fn fanout_reply(id: &str, line: &str) {
    if let Ok(mut top) = SIDECAR_REPLIES.lock() {
        for (_subscriber, queue) in top.iter_mut() {
            queue.entry(id.to_string()).or_insert_with(Vec::new).push(line.to_string());
        }
    }
}

// ---------- bun_send: relay from React → Bun sidecar ----------

#[tauri::command]
async fn bun_send(app: AppHandle, line: String) -> Result<String, String> {
    let request = line.trim().to_string();
    if !request.starts_with('{') {
        return Err("bun_send expects a JSON object (the UI must wrap it)".into());
    }
    let stdin_mutex = SIDECAR_STDIN.get().ok_or("sidecar not initialized")?;
    {
        let mut stdin = stdin_mutex.lock().map_err(|e| e.to_string())?;
        writeln!(stdin, "{}", request).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }
    let _ = app.emit("bun:sent", &request);
    Ok("ok".into())
}

// ---------- spotlight: hotkey-triggered transient window ----------

/// Context captured at the moment the hotkey was pressed. The spotlight
/// window receives this via the `spotlight:invoke` event so it can show
/// "operating on <doc>.docx · 段 N" and so the agent can attach to the
/// exact Word instance the user was looking at.
#[derive(Clone, Serialize)]
struct SpotlightInvoke {
    /// Raw HWND of the foreground window when the hotkey fired (u64 for IPC).
    trigger_hwnd: u64,
    /// PID of that window's process.
    trigger_pid: u32,
    /// Window title — usually "<filename>.docx - Word".
    trigger_title: String,
    /// Window class — "OpusApp" for Word's main window.
    trigger_class: String,
    /// True iff trigger_class == "OpusApp" (or starts with). The UI uses this
    /// to either proceed or show a "please focus a Word window first" hint.
    is_word: bool,
    /// Monotonic counter so the UI can detect "this is a new invocation"
    /// even if all other fields are identical.
    seq: u64,
}

#[cfg(windows)]
fn capture_foreground() -> SpotlightInvoke {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        let mut pid: u32 = 0;
        let _tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class = String::from_utf16_lossy(&class_buf[..class_len as usize]);

        let is_word = class == "OpusApp";

        SpotlightInvoke {
            trigger_hwnd: hwnd.0 as u64,
            trigger_pid: pid,
            trigger_title: title,
            trigger_class: class,
            is_word,
            seq,
        }
    }
}

#[cfg(not(windows))]
fn capture_foreground() -> SpotlightInvoke {
    SpotlightInvoke {
        trigger_hwnd: 0,
        trigger_pid: 0,
        trigger_title: String::new(),
        trigger_class: String::new(),
        is_word: false,
        seq: 0,
    }
}

/// Pull the latest spotlight invocation context. UI calls this on mount and
/// whenever it receives a spotlight:invoke event (as a robustness fallback
/// in case the event was missed).
#[tauri::command]
fn spotlight_get_invoke() -> Option<SpotlightInvoke> {
    LAST_INVOKE.lock().ok().and_then(|g| g.clone())
}

/// Sidecar readiness snapshot — survives React HMR remounts of the main
/// window which would otherwise miss the original `ready` event.
#[derive(Clone, Serialize)]
struct AppStatus {
    ready: bool,
    gen: u32,
}

#[tauri::command]
fn app_status() -> AppStatus {
    AppStatus {
        ready: SIDECAR_READY.lock().map(|g| *g).unwrap_or(false),
        gen: SIDECAR_GEN.lock().map(|g| *g).unwrap_or(0),
    }
}

/// Notify the main window that a chat was just submitted from the spotlight,
/// so it can render the user bubble. Forwards the event to the main webview.
#[tauri::command]
fn announce_chat(
    app: AppHandle,
    id: String,
    message: String,
    session_id: Option<String>,
) -> Result<(), String> {
    // Re-capture foreground at announce time so the main window can show
    // "linked to <doc>.docx" even if the spotlight moved/closed.
    let invoke = capture_foreground();
    let payload = serde_json::json!({
        "id": id,
        "message": message,
        "sessionId": session_id,
        "trigger": {
            "title": invoke.trigger_title,
            "class": invoke.trigger_class,
            "isWord": invoke.is_word,
            "pid": invoke.trigger_pid,
        },
    });
    let _ = app.emit_to(EventTarget::webview_window("main"), "chat:start", payload);
    Ok(())
}

/// Register a subscriber name so its queue is allocated. Each webview that
/// wants to poll replies should call this once on mount.
#[tauri::command]
fn register_subscriber(name: String) -> Result<(), String> {
    ensure_subscriber(&name);
    Ok(())
}

/// Pull all pending sidecar replies for a request id from the named
/// subscriber's queue (and clear them from that queue only — other
/// subscribers still get their copy).
#[tauri::command]
fn spotlight_take_reply(subscriber: Option<String>, id: String) -> Vec<String> {
    let sub = subscriber.unwrap_or_else(|| "spotlight".to_string());
    ensure_subscriber(&sub);
    SIDECAR_REPLIES
        .lock()
        .ok()
        .and_then(|mut top| top.get_mut(&sub).and_then(|q| q.remove(&id)))
        .unwrap_or_default()
}

fn show_spotlight(app: &AppHandle) {
    let invoke = capture_foreground();
    eprintln!(
        "[main] spotlight invoke: seq={} class={:?} title={:?} is_word={} hwnd={:#x} pid={}",
        invoke.seq, invoke.trigger_class, invoke.trigger_title, invoke.is_word, invoke.trigger_hwnd, invoke.trigger_pid,
    );
    if let Ok(mut g) = LAST_INVOKE.lock() {
        *g = Some(invoke.clone());
    }
    if let Some(w) = app.get_webview_window("spotlight") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        // Tauri 2: emit_to a specific webview is more reliable than the
        // host-side w.emit which can land on the host event channel.
        if let Err(e) = app.emit_to(EventTarget::webview_window("spotlight"), "spotlight:invoke", invoke) {
            eprintln!("[main] spotlight:invoke emit_to failed: {}", e);
        }
    } else {
        eprintln!("[main] spotlight window not found");
    }
}

#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("[ui] {}", msg);
}

#[tauri::command]
fn spotlight_hide(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("spotlight") {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
fn spotlight_resize(app: AppHandle, height: u32) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("spotlight") {
        let size = w.outer_size().map_err(|e| e.to_string())?;
        let scale = w.scale_factor().map_err(|e| e.to_string())?;
        let new_h = ((height as f64) * scale) as u32;
        w.set_size(tauri::PhysicalSize::new(size.width, new_h))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- Bun sidecar lifecycle ----------

fn locate_bun() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("MSWORD_BUN_EXE") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let candidate = std::path::PathBuf::from(home).join(".bun").join("bin").join("bun.exe");
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    for name in ["bun.exe", "bun.cmd", "bun"] {
        if let Ok(p) = which_on_path(name) {
            return Ok(p);
        }
    }
    Err("bun not found — set MSWORD_BUN_EXE or install bun (https://bun.sh/)".into())
}

fn which_on_path(name: &str) -> Result<std::path::PathBuf, ()> {
    let path = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

fn spawn_sidecar(app: &AppHandle) -> Result<Child, String> {
    let repo_root = {
        let mut p = std::env::current_dir().map_err(|e| e.to_string())?;
        p.pop(); // -> apps/desktop
        p.pop(); // -> apps
        p.pop(); // -> repo root
        p
    };
    let agent_index = repo_root.join("apps").join("agent").join("src").join("index.ts");

    let bun = locate_bun()?;
    eprintln!("[main] spawning Bun sidecar: {:?} run {:?} (cwd={:?})", bun, agent_index, repo_root);
    // cwd=repo_root so Bun auto-loads `.env` / `.env.local` from the repo root
    // (Bun reads dotenv files relative to the process cwd). Lets users set
    // ANTHROPIC_API_KEY in a gitignored .env instead of in their shell.
    let mut child = Command::new(&bun)
        .arg("run")
        .arg(&agent_index)
        .current_dir(&repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn bun ({:?}): {}", bun, e))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    SIDECAR_STDIN
        .set(Mutex::new(stdin))
        .map_err(|_| "sidecar stdin already set")?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&l) {
                        if let Some(id) = parsed.get("id").and_then(|v| v.as_str()) {
                            fanout_reply(id, &l);
                        }
                        // Track ready + gen so the main window can poll
                        // status on mount (HMR-safe — surviving React remounts
                        // that miss the original ready event).
                        if parsed.get("ready").and_then(|v| v.as_bool()) == Some(true) {
                            if let Ok(mut g) = SIDECAR_READY.lock() {
                                *g = true;
                            }
                        }
                        if let Some(gen) = parsed.get("gen").and_then(|v| v.as_u64()) {
                            if let Ok(mut g) = SIDECAR_GEN.lock() {
                                *g = gen as u32;
                            }
                        }
                    }
                    let _ = app_handle.emit_to(EventTarget::webview_window("main"), "bun:reply", &l);
                    let _ = app_handle.emit_to(EventTarget::webview_window("spotlight"), "bun:reply", &l);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        eprintln!("[main] sidecar stdout closed");
    });

    let stderr = child.stderr.take().ok_or("no stderr")?;
    let app_handle2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                eprintln!("[bun] {}", l);
                let _ = app_handle2.emit_to(EventTarget::webview_window("main"), "bun:log", &l);
                let _ = app_handle2.emit_to(EventTarget::webview_window("spotlight"), "bun:log", &l);
            }
        }
    });

    Ok(child)
}

// ---------- entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // v0.3 hotkey: Ctrl+Alt+J. Ctrl+Shift+Space was taken on test machine.
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyJ);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        // Toggle: if spotlight is already visible, hide it.
                        // Otherwise capture trigger context + show it.
                        if let Some(w) = app.get_webview_window("spotlight") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                                return;
                            }
                        }
                        show_spotlight(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            if let Err(e) = app.global_shortcut().register(toggle_shortcut) {
                eprintln!("[main] failed to register global shortcut: {}", e);
            }

            // Auto-hide the spotlight window when it loses focus (user clicked
            // outside, returned to Word, etc). Standard Raycast/Spotlight UX.
            if let Some(spot) = app.get_webview_window("spotlight") {
                let spot_clone = spot.clone();
                spot.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = spot_clone.hide();
                    }
                });
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                match spawn_sidecar(&handle) {
                    Ok(_child) => {
                        let _ = handle.emit("bun:log", "[main] sidecar spawned");
                    }
                    Err(e) => {
                        eprintln!("[main] failed to spawn sidecar: {}", e);
                        let _ = handle.emit("bun:log", format!("[main] sidecar failed: {}", e));
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bun_send,
            spotlight_hide,
            spotlight_resize,
            spotlight_get_invoke,
            spotlight_take_reply,
            register_subscriber,
            app_status,
            announce_chat,
            debug_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
