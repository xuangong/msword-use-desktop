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
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static SIDECAR_STDIN: OnceCell<Mutex<ChildStdin>> = OnceCell::new();

#[tauri::command]
async fn bun_send(
    app: AppHandle,
    line: String,
) -> Result<String, String> {
    // The UI sends a bare command like "ping" or full JSON. Wrap bare ones.
    let trimmed = line.trim();
    let request = if trimmed.starts_with('{') {
        trimmed.to_string()
    } else {
        // Parse as "<method> [json-args]" — alpha convenience.
        let mut parts = trimmed.splitn(2, ' ');
        let method = parts.next().unwrap_or("").to_string();
        let params_str = parts.next().unwrap_or("{}");
        let params: Value = serde_json::from_str(params_str)
            .unwrap_or_else(|_| json!({}));
        let req = json!({
            "id": format!("{}", chrono_ish()),
            "method": method,
            "params": params,
        });
        req.to_string()
    };

    let stdin_mutex = SIDECAR_STDIN.get().ok_or("sidecar not initialized")?;
    {
        let mut stdin = stdin_mutex.lock().map_err(|e| e.to_string())?;
        writeln!(stdin, "{}", request).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }
    // Replies arrive asynchronously via the `bun:reply` event; the caller
    // just gets an ack here. (Synchronous response correlation is a v2 nicety.)
    let _ = app.emit("bun:sent", &request);
    Ok(format!("sent: {}", request))
}

fn chrono_ish() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

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
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            // Spawn sidecar shortly after the app starts; if it fails, surface
            // the error to the UI as a `bun:log` event rather than crashing.
            tauri::async_runtime::spawn(async move {
                // Brief delay so the UI is up to receive events.
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
