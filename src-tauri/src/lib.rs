use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Arc,
    thread,
    process::Command,
    path::Path,
};
use tauri::{async_runtime::Mutex as AsyncMutex, State, AppHandle, Emitter};
use sysinfo::{System, Components, Networks};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    child_pid: u32,
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
    // Set UTF-8 locale for proper Korean/CJK character handling
    // DMG-installed apps don't inherit shell environment variables
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn command: {}", e))?;

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
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_clone.emit(&format!("pty-output-{}", session_id), text);
                }
                Err(_) => {
                    let _ = app_clone.emit(&format!("pty-end-{}", session_id), ());
                    break;
                }
            }
        }
    });

    let child_pid = child.process_id().unwrap_or(0);
    let session = PtySession {
        master: pair.master,
        writer,
        child,
        child_pid,
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
    let session = {
        let mut sessions = state.sessions.lock().await;
        sessions.remove(&session_id)
    };

    if let Some(mut session) = session {
        // Kill and drop everything - don't wait
        let _ = session.child.kill();
        drop(session.master);
        drop(session.writer);
        // Reader thread and child process will clean up on their own
        Ok(())
    } else {
        Ok(())
    }
}

#[tauri::command]
async fn get_pty_foreground_process(
    state: State<'_, PtyState>,
    session_id: u32,
) -> Result<String, String> {
    let child_pid = {
        let sessions = state.sessions.lock().await;
        sessions.get(&session_id).map(|s| s.child_pid)
    };

    let Some(shell_pid) = child_pid else {
        return Err("Session not found".to_string());
    };

    tauri::async_runtime::spawn_blocking(move || {
        // Get shell name first
        let shell_name = Command::new("ps")
            .args(["-o", "comm=", "-p", &shell_pid.to_string()])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let name = name.split('/').last().unwrap_or(&name);
                // Remove leading '-' from login shells (e.g., "-zsh" -> "zsh")
                name.strip_prefix('-').unwrap_or(name).to_string()
            })
            .unwrap_or_else(|| "shell".to_string());

        if shell_pid == 0 {
            return shell_name;
        }

        // Get shell's tty
        let tty = Command::new("ps")
            .args(["-o", "tty=", "-p", &shell_pid.to_string()])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        if tty.is_empty() || tty == "??" {
            return shell_name;
        }

        // Find foreground process on this tty (stat contains '+')
        let ps_output = Command::new("ps")
            .args(["-t", &tty, "-o", "pid=,stat=,comm="])
            .output();

        if let Ok(output) = ps_output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 3 {
                        let pid = parts[0];
                        let stat = parts[1];
                        let comm = parts[2];

                        // Foreground process has '+' in stat and is not the shell
                        if stat.contains('+') && pid != shell_pid.to_string() {
                            let name = comm.split('/').last().unwrap_or(comm);
                            let name = name.strip_prefix('-').unwrap_or(name);
                            if name != shell_name {
                                return name.to_string();
                            }
                        }
                    }
                }
            }
        }

        shell_name
    })
    .await
    .map_err(|e| format!("Task error: {}", e))
}

#[tauri::command]
async fn check_path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        Path::new(&path).exists()
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
async fn run_git_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path_env = std::env::var("PATH").unwrap_or_default();
        let extended_path = format!(
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
            path_env
        );

        let output = Command::new("git")
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", &extended_path)
            .output()
            .map_err(|e| format!("Failed to execute git: {}", e))?;

        if output.status.success() {
            String::from_utf8(output.stdout)
                .map_err(|e| format!("Invalid UTF-8: {}", e))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(stderr.to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Ensure parent directory exists
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
fn get_app_data_dir() -> Result<String, String> {
    dirs::data_dir()
        .map(|p| p.join("com.jeonghyeon.net").to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine app data directory".to_string())
}

#[tauri::command]
async fn list_files_in_dir(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete file: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn delete_directory(path: String) -> Result<(), String> {
    // Use system rm -rf which is much faster than Rust's remove_dir_all for large directories
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new("rm")
            .args(["-rf", &path])
            .output()
            .map_err(|e| format!("Failed to execute rm: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("rm -rf failed: {}", stderr))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn create_dir_all(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to create directory: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn run_gh_command(cwd: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path_env = std::env::var("PATH").unwrap_or_default();
        let extended_path = format!(
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{}",
            path_env
        );

        let output = Command::new("gh")
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", &extended_path)
            .output()
            .map_err(|e| format!("Failed to execute gh: {}", e))?;

        if output.status.success() {
            String::from_utf8(output.stdout)
                .map_err(|e| format!("Invalid UTF-8: {}", e))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(stderr.to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
async fn open_terminal_at(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        Command::new("open")
            .args(["-a", "Terminal", &path])
            .output()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[derive(serde::Serialize)]
struct SystemStats {
    cpu_usage: f32,
    memory_usage: f32,
    temperature: Option<f32>,
    network_rx: u64,  // bytes received per second
    network_tx: u64,  // bytes transmitted per second
}

// Store previous network stats for calculating rate
static PREV_NETWORK: std::sync::Mutex<Option<(u64, u64, std::time::Instant)>> = std::sync::Mutex::new(None);

// Persistent instances for accurate measurements
use std::sync::OnceLock;
static SYSTEM: OnceLock<std::sync::Mutex<System>> = OnceLock::new();
static COMPONENTS: OnceLock<std::sync::Mutex<Components>> = OnceLock::new();
static NETWORKS: OnceLock<std::sync::Mutex<Networks>> = OnceLock::new();

#[tauri::command]
async fn get_system_stats() -> Result<SystemStats, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let sys_mutex = SYSTEM.get_or_init(|| std::sync::Mutex::new(System::new_all()));
        let mut sys = sys_mutex.lock().unwrap();

        sys.refresh_memory();
        sys.refresh_cpu_usage();

        let cpu_usage = sys.global_cpu_usage();
        let memory_usage = (sys.used_memory() as f32 / sys.total_memory() as f32) * 100.0;

        // Get temperature from components
        let comp_mutex = COMPONENTS.get_or_init(|| std::sync::Mutex::new(Components::new_with_refreshed_list()));
        let mut components = comp_mutex.lock().unwrap();
        components.refresh();
        let temperature = components.iter()
            .find(|c| c.label().contains("CPU") || c.label().contains("Die"))
            .map(|c| c.temperature());
        drop(components);

        // Get network stats
        let net_mutex = NETWORKS.get_or_init(|| std::sync::Mutex::new(Networks::new_with_refreshed_list()));
        let mut networks = net_mutex.lock().unwrap();
        networks.refresh();
        let (total_rx, total_tx): (u64, u64) = networks.iter()
            .map(|(_, data)| (data.total_received(), data.total_transmitted()))
            .fold((0, 0), |(rx, tx), (r, t)| (rx + r, tx + t));
        drop(networks);

        let now = std::time::Instant::now();
        let (network_rx, network_tx) = {
            let mut prev = PREV_NETWORK.lock().unwrap();
            if let Some((prev_rx, prev_tx, prev_time)) = *prev {
                let elapsed = now.duration_since(prev_time).as_secs_f64();
                if elapsed > 0.0 {
                    let rx_rate = ((total_rx.saturating_sub(prev_rx)) as f64 / elapsed) as u64;
                    let tx_rate = ((total_tx.saturating_sub(prev_tx)) as f64 / elapsed) as u64;
                    *prev = Some((total_rx, total_tx, now));
                    (rx_rate, tx_rate)
                } else {
                    (0, 0)
                }
            } else {
                *prev = Some((total_rx, total_tx, now));
                (0, 0)
            }
        };

        Ok(SystemStats {
            cpu_usage,
            memory_usage,
            temperature,
            network_rx,
            network_tx,
        })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn open_activity_monitor() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        Command::new("open")
            .arg("-a")
            .arg("Activity Monitor")
            .spawn()
            .map_err(|e| format!("Failed to open Activity Monitor: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
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
            get_pty_foreground_process,
            check_path_exists,
            run_git_command,
            run_gh_command,
            get_home_dir,
            create_dir_all,
            read_file,
            write_file,
            get_app_data_dir,
            list_files_in_dir,
            delete_file,
            delete_directory,
            open_terminal_at,
            get_system_stats,
            open_activity_monitor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
