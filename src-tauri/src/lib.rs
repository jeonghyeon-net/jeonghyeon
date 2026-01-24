use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Arc,
    thread,
    process::Command,
    path::Path,
};
use tauri::{async_runtime::Mutex as AsyncMutex, State, AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    _reader_thread: thread::JoinHandle<()>,
}

pub struct PtyState {
    sessions: Arc<AsyncMutex<HashMap<u32, PtySession>>>,
    next_id: Arc<AsyncMutex<u32>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(AsyncMutex::new(HashMap::new())),
            next_id: Arc::new(AsyncMutex::new(1)),
        }
    }
}

#[tauri::command]
async fn create_pty_session(
    app: AppHandle,
    state: State<'_, PtyState>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open pty: {}", e))?;

    let mut cmd = CommandBuilder::new_default_prog();
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // Set TERM for proper escape sequence handling
    cmd.env("TERM", "xterm-256color");

    pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Drop slave - we only need master
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| format!("Failed to get writer: {}", e))?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to get reader: {}", e))?;

    let mut next_id = state.next_id.lock().await;
    let session_id = *next_id;
    *next_id += 1;

    // Spawn thread to read from PTY and emit events
    let app_clone = app.clone();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 8192];

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = app_clone.emit(&format!("pty-end-{}", session_id), ());
                    break;
                }
                Ok(n) => {
                    let _ = app_clone.emit(&format!("pty-output-{}", session_id), buf[..n].to_vec());
                }
                Err(_) => {
                    let _ = app_clone.emit(&format!("pty-end-{}", session_id), ());
                    break;
                }
            }
        }
    });

    let session = PtySession {
        master: pair.master,
        writer,
        _reader_thread: reader_thread,
    };

    let mut sessions = state.sessions.lock().await;
    sessions.insert(session_id, session);

    Ok(session_id)
}

#[tauri::command]
async fn write_to_pty(
    state: State<'_, PtyState>,
    session_id: u32,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get_mut(&session_id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
        session.writer.flush().map_err(|e| format!("Flush error: {}", e))?;
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}


#[tauri::command]
async fn resize_pty(
    state: State<'_, PtyState>,
    session_id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    if let Some(session) = sessions.get(&session_id) {
        session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| format!("Resize error: {}", e))?;
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[tauri::command]
async fn close_pty_session(state: State<'_, PtyState>, session_id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if sessions.remove(&session_id).is_some() {
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

#[tauri::command]
fn check_path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn run_git_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    let output = Command::new("git")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| format!("Invalid UTF-8: {}", e))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.to_string())
    }
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn get_app_data_dir() -> Result<String, String> {
    dirs::data_dir()
        .map(|p| p.join("com.jeonghyeon.net").to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine app data directory".to_string())
}

#[tauri::command]
fn list_files_in_dir(path: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut files = Vec::new();
    for entry in entries {
        if let Ok(entry) = entry {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
    }
    Ok(files)
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete file: {}", e))
}

#[tauri::command]
fn create_dir_all(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
fn run_gh_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    let output = Command::new("gh")
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to execute gh: {}", e))?;

    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| format!("Invalid UTF-8: {}", e))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            create_pty_session,
            write_to_pty,
            resize_pty,
            close_pty_session,
            check_path_exists,
            run_git_command,
            run_gh_command,
            get_home_dir,
            create_dir_all,
            read_file,
            write_file,
            get_app_data_dir,
            list_files_in_dir,
            delete_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
