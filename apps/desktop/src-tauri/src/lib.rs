// msword-use desktop — Tauri main process.
//
// Owns the Bun agent sidecar lifecycle: spawns it on app launch, pipes
// stdin/stdout, exposes `bun_send` as a Tauri command for the React UI,
// and re-emits the sidecar's responses as `bun:reply` events.
//
// Wire format with Bun sidecar (NDJSON):
//   we write:  {"id":"<str>","method":"<str>","params":{...}}
//   we read:   {"id":"<str>","result":...,"error":...,"gen":N}

use once_cell::sync::OnceCell;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static SIDECAR_STDIN: OnceCell<Mutex<ChildStdin>> = OnceCell::new();

#[tauri::command]
async fn bun_send(
    app: AppHandle,
    line: String,
) -> Result<String, String> {
    // Caller passes a complete JSON line. The UI is responsible for shape
    // (either {kind:"chat",id,message} or {id,method,params}).
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

fn _legacy_chrono_unused() {}

fn spawn_sidecar(app: &AppHandle) -> Result<Child, String> {
    // Dev path: bun runs the TS directly. Production path will swap to the
    // compiled exe in src-tauri/binaries/.
    let agent_index = {
        // src-tauri/../../agent/src/index.ts
        let mut p = std::env::current_dir().map_err(|e| e.to_string())?;
        // current_dir during `tauri dev` is apps/desktop/src-tauri
        p.pop(); // -> apps/desktop
        p.pop(); // -> apps
        p.push("agent");
        p.push("src");
        p.push("index.ts");
        p
    };

    eprintln!("[main] spawning Bun sidecar: bun run {:?}", agent_index);
    let mut child = Command::new("bun")
        .arg("run")
        .arg(&agent_index)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn bun: {}", e))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    SIDECAR_STDIN
        .set(Mutex::new(stdin))
        .map_err(|_| "sidecar stdin already set")?;

    // Read stdout: forward each line as `bun:reply` event.
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.is_empty() => {
                    let _ = app_handle.emit("bun:reply", &l);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        eprintln!("[main] sidecar stdout closed");
    });

    // Read stderr: forward each line as `bun:log` (and also print).
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let app_handle2 = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                eprintln!("[bun] {}", l);
                let _ = app_handle2.emit("bun:log", &l);
            }
        }
    });

    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &toggle_shortcut && event.state() == ShortcutState::Pressed {
                        if let Some(w) = app.get_webview_window("main") {
                            // Toggle: hide if focused, show + focus otherwise.
                            let is_visible = w.is_visible().unwrap_or(false);
                            let is_focused = w.is_focused().unwrap_or(false);
                            if is_visible && is_focused {
                                let _ = w.hide();
                            } else {
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Register the global shortcut now that the plugin is initialised.
            if let Err(e) = app.global_shortcut().register(toggle_shortcut) {
                eprintln!("[main] failed to register global shortcut: {}", e);
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
        .invoke_handler(tauri::generate_handler![bun_send])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
